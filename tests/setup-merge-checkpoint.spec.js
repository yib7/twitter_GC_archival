require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const X = require("./fixtures/x-export.js");
const { startServer, readData } = require("./_sp6-server.js");

// Merge checkpoint, end to end through the wizard over a real server
// (GCA_PORT=0, a mkdtemp GCA_PERSONAL, root fallbacks and native pickers off)
// and two synthetic exports only:
//   1. build from export A by picking its archive folder (found through
//      data/manifest.js) — the preview shows counts and warnings BEFORE
//      anything is written;
//   2. name people, add photos, name the group (with a photo), remove 333,
//      mark "me" = 111, save;
//   3. reopen, "Add a newer export" with B (overlapping A, plus a new group),
//      preview the overlap, merge;
//   4. the archive is A ∪ B with every bit of identity kept, 333 still out,
//      and data.js.bak is the archive as it was before the merge.
test.describe.configure({ mode: "serial" });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
let S, rootA, rootB, A, B, preMerge;
const scratchDirs = [];
const P = (...p) => path.join(S.personal, ...p);
const cfg = () => JSON.parse(fs.readFileSync(P("config.json"), "utf8"));
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p);
      if (e.isDirectory()) { out[rel] = "dir"; walk(p); }
      else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const msgIds = (data, cid) => {
  const c = data.conversations.find((x) => String(x.id) === cid);
  return c ? c.msgs.map((m) => String(m.i)).sort() : null;
};
async function choosePhoto(page, button) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
  await chooser.setFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await page.locator('.su-modal [data-act="ok"]').click();
}
const card = (page, id) => page.locator(".su-person").filter({ has: page.locator(".su-meta", { hasText: "id " + id }) });

test.beforeAll(async () => {
  S = await startServer();
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), "gca-checkpoint-a-"));
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), "gca-checkpoint-b-"));
  scratchDirs.push(rootA, rootB);
  A = X.writeExport(rootA, { manifest: true });
  B = X.writeExportB(rootB);
});
test.afterAll(() => { if (S) S.stop(); for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true }); });

test("1. export A from its archive folder: the preview comes first, then the build", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-root").fill(A.root);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator("#pf-title")).toHaveText("Ready to build");
  await expect(page.locator("#pf-sub")).toContainText("Found through the archive's data/manifest.js · 2 messages files");
  await expect(page.locator("#pf-lines")).toContainText(/Group chats\s*2/);
  await expect(page.locator("#pf-lines")).toContainText(/Messages\s*7/);
  await expect(page.locator("#pf-lines")).toContainText(/People\s*5/);
  await expect(page.locator("#pf-lines")).toContainText(/Photos & videos\s*3/);
  await expect(page.locator('#pf-warnings [data-code="dm-ignored"]')).toBeVisible();
  expect(fs.readdirSync(S.personal), "nothing is written before Build").toEqual([]);

  await page.locator("#btn-confirm").click();
  await expect(page.locator("#src-result")).toHaveClass(/ok/, { timeout: 15000 });
  await expect(page.locator("#src-result")).toContainText(/Built 7 messages across 2 group/);
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
});

test("2. name the group and people, add photos, remove 333, mark me, save", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-continue").click();
  await page.locator("#gc-group").selectOption("1000000001");
  await page.locator("#gc-name").fill("Crew");
  await choosePhoto(page, page.locator("#gc-pick"));
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(card(page, "111")).toBeVisible();
  await card(page, "111").locator(".su-name").fill("Ann");
  await card(page, "111").getByRole("radio").check();
  await card(page, "222").locator(".su-name").fill("Bea");
  await choosePhoto(page, card(page, "222").locator(".su-pick"));
  await card(page, "333").locator(".su-remove").click();
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await page.locator("#remove-go").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/, { timeout: 15000 });
  const c = cfg();
  expect(c.names).toMatchObject({ 111: "Ann", 222: "Bea" });
  expect(c.me).toBe("111");
  expect(c.gc["1000000001"].name).toBe("Crew");
  expect(c.gc["1000000001"].photo).toMatch(/^personal_data\/pfps\//);
  expect(c.pfps["222"]).toMatch(/^personal_data\/pfps\//);
  expect(c.ignoredUsers).toEqual(["333"]);
  expect(msgIds(readData(S.personal), "1000000001")).toEqual(["9001", "9002", "9003", "9005"]);
  preMerge = fs.readFileSync(P("data.js"));
});

test("3. reopen, add the newer export B: the preview shows the overlap, then it merges", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await expect(page.locator("#src-locked")).toBeVisible();
  await page.locator("#src-add").click();
  await expect(page.locator("#src-merge")).toBeVisible();
  await expect(page.locator("#src-root")).toBeEnabled();
  await page.locator("#src-root").fill(B.root);
  const before = snapshot(S.personal);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator("#pf-title")).toHaveText("Add this export to your archive");
  await expect(page.locator("#pf-sub")).toContainText("data/manifest.js");
  await expect(page.locator("#pf-lines")).toContainText(/Already in your archive\s*6 messages/);
  await expect(page.locator("#pf-lines")).toContainText(/New messages to add\s*4/);
  await expect(page.locator("#pf-lines")).toContainText(/New group chats\s*1/);
  await expect(page.locator("#pf-lines")).toContainText(/Group chats kept from your archive\s*1/);
  await expect(page.locator('#pf-warnings [data-code="overlap"]')).toContainText(/2 messages are already in your archive/);
  await expect(page.locator('#pf-warnings [data-code="removed"]')).toContainText(/1 message from people or group chats you removed/);
  await expect(page.locator("#btn-confirm")).toHaveText("Merge into archive");
  expect(snapshot(S.personal), "the preview changed nothing").toEqual(before);

  await page.locator("#btn-confirm").click();
  await expect(page.locator("#src-result")).toHaveClass(/ok/, { timeout: 15000 });
  await expect(page.locator("#src-result")).toContainText(/Merged: 4 new messages added — your archive now has 10 messages across 3 group/);
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
});

test("4. the merged archive is A ∪ B and every bit of identity is kept", async ({ page }) => {
  const data = readData(S.personal);
  expect(msgIds(data, "1000000001")).toEqual(["9001", "9002", "9003", "9005", "9006", "9007"]);
  expect(msgIds(data, "1000000002")).toEqual(["9101", "9102"]);
  expect(msgIds(data, "1000000003")).toEqual(["9201", "9202"]);
  expect(data.conversations.some((c) => c.msgs.some((m) => String(m.s) === "333")), "333 stays removed").toBe(false);
  expect(fs.readFileSync(P("data.js.bak")).equals(preMerge), "data.js.bak is the archive before the merge").toBe(true);

  const c = cfg();
  expect(c.names).toMatchObject({ 111: "Ann", 222: "Bea" });
  expect(c.me).toBe("111");
  expect(c.gc["1000000001"].name).toBe("Crew");
  expect(fs.existsSync(path.join(S.personal, c.gc["1000000001"].photo.replace(/^personal_data\//, "")))).toBe(true);
  expect(fs.existsSync(path.join(S.personal, c.pfps["222"].replace(/^personal_data\//, "")))).toBe(true);
  expect(c.ignoredUsers).toEqual(["333"]);
  const local = fs.readFileSync(P("local.js"), "utf8");
  expect(local).toContain('"111": "Ann"');
  expect(local).toContain('window.LOCAL_ME = "111"');
  expect(local).toContain('"name": "Crew"');
  expect(local).toMatch(/LOCAL_IGNORED_USERS = \[\s*"333"\s*\]/);

  const media = fs.readdirSync(P("media")).sort();
  expect(media).toEqual(expect.arrayContaining(["9002-AbCdEf.png", "9002-ZzSecond.jpg", "9007-NewPic.jpg", "9101-Other.mp4", "9201-Group3.png"]));
  expect(media).not.toContain("9008-Removed.png");

  // the reopened wizard still shows the saved group name, and the new group
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-continue").click();
  await page.locator("#gc-group").selectOption("1000000001");
  await expect(page.locator("#gc-name")).toHaveValue("Crew");
  await expect(page.locator('#gc-group option[value="1000000003"]')).toHaveCount(1);
});
