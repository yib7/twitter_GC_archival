require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForBootLine } = require("./wait-for-boot-line.js");
const X = require("./fixtures/x-export.js");
const { checkAndBuild } = require("./_setup-helpers.js");

// SP7: the wizard builds from the unzipped archive folder alone — its
// data/manifest.js says where the group files, every part, the headers and
// the media are. Own server (GCA_PORT=0, mkdtemp GCA_PERSONAL, root fallbacks
// and native pickers off) over a synthetic export only.
let BASE, proc, personal, exportRoot, F;

test.beforeAll(async () => {
  personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-personal-"));
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-export-"));
  F = X.writeExport(exportRoot, { manifest: true });
  proc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: personal, GCA_PORT: "0", GCA_NO_ROOT_FALLBACK: "1", GCA_NO_NATIVE_PICKER: "1" }),
    stdio: "pipe",
  });
  BASE = "http://127.0.0.1:" + (await waitForBootLine(proc, 10000));
});
test.afterAll(() => {
  if (proc) proc.kill();
  for (const d of [personal, exportRoot]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("nothing filled in asks for the archive folder first", async ({ page }) => {
  await page.goto(BASE + "/setup.html");
  await page.locator("#btn-build").click();
  await expect(page.locator("#src-result")).toContainText(/Choose your archive folder/);
  expect(fs.existsSync(path.join(personal, "data.js"))).toBe(false);
});

test("a folder with no group chat files gets one plain sentence", async ({ page }) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gca-root-empty-"));
  try {
    await page.goto(BASE + "/setup.html");
    await page.locator("#src-root").fill(empty);
    await page.locator("#btn-build").click();
    await expect(page.locator("#src-result")).toHaveClass(/err/);
    await expect(page.locator("#src-result")).toContainText(/No group chat files were found/);
    await expect(page.locator("#btn-build")).toBeEnabled();
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("picking only the archive folder builds every part, with the media", async ({ page }) => {
  await page.goto(BASE + "/setup.html");
  await expect(page.locator(".setup-or")).toContainText(/or pick the three files yourself/i);
  await page.locator("#src-root").fill(F.root);
  // SP7 pre-flight: the preview comes first, and nothing is written yet
  await page.locator("#btn-build").click();
  const pf = page.locator("#preflight");
  await expect(pf).toBeVisible();
  await expect(page.locator("#pf-sub")).toContainText(/data\/manifest\.js · 2 messages files/);
  await expect(page.locator("#pf-lines")).toContainText(/Messages\s*7/);
  await expect(page.locator("#pf-lines")).toContainText(/Group chats\s*2/);
  await expect(page.locator("#pf-lines")).toContainText(/People\s*5/);
  await expect(page.locator("#pf-lines")).toContainText(/Photos & videos\s*3/);
  await expect(page.locator("#pf-groups li")).toHaveCount(2);
  await expect(page.locator("#pf-groups")).toContainText(/Synthetic Crew — 5 messages/);
  await expect(page.locator('#pf-warnings li[data-code="dm-ignored"]')).toContainText(/1 1:1 conversation/);
  expect(fs.readdirSync(personal)).toEqual([]);
  // changing a field drops the preview (it no longer describes the fields)
  await page.locator("#src-root").fill(F.root + " ");
  await expect(pf).toBeHidden();
  await page.locator("#src-root").fill(F.root);
  await checkAndBuild(page);
  const out = page.locator("#src-result");
  await expect(out).toHaveClass(/ok/);
  await expect(out).toContainText(/Built 7 messages across 2 group/);
  await expect(out).toContainText(/from 2 message part files/);
  await expect(out).toContainText(/copied 3 media files/);
  await expect(out).toContainText(/data\/manifest\.js/);
  await expect(out).toContainText(/1:1 direct messages are left out/);
  await expect(pf).toBeHidden();
  const cfg = JSON.parse(fs.readFileSync(path.join(personal, "config.json"), "utf8"));
  expect(cfg.sourceJs.map((p) => path.basename(p))).toEqual(["direct-messages-group.js", "direct-messages-group-part1.js"]);
  await expect(page.locator("#src-root")).toBeDisabled();   // locked like the three fields
});
