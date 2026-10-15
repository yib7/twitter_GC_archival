require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForBootLine } = require("./wait-for-boot-line.js");
const X = require("./fixtures/x-export.js");
const { checkAndBuild } = require("./_setup-helpers.js");

// Checkpoint: the wizard over a REAL server + synthetic export shows a
// clear error — never a green "✓ Built 0 messages" — for a wrong, empty or
// broken messages file, stays unlocked so the user can fix it, and builds a
// BOM-prefixed export normally with the build log one click away.
//
// Own server on an OS-assigned port (GCA_PORT=0), a fresh mkdtemp
// GCA_PERSONAL and the root fallbacks off; the export is generated into
// another mkdtemp dir. Nothing here can touch real data. Tests run in file
// order on one server: the failures first (a failed build writes nothing),
// then the one successful build.
let BASE, proc, personal, exportRoot, F;

test.beforeAll(async () => {
  personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-ingest-personal-"));
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-ingest-export-"));
  F = X.writeExport(exportRoot, { bom: true });
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

// "Check export" reads the files first (POST /api/preflight); a file it
// can't use is refused right there, before the preview and before any build.
async function submit(page, groupJs) {
  await page.goto(BASE + "/setup.html");
  await page.locator("#src-group").fill(groupJs);
  await page.locator("#src-headers").fill(F.headers);
  await page.locator("#src-media").fill(F.media);
  await page.locator("#btn-build").click();
}
async function expectClearFailure(page, re) {
  const out = page.locator("#src-result");
  await expect(out).toHaveClass(/err/);
  await expect(out).toContainText(re);
  await expect(out).not.toContainText(/Built 0|✓/);
  await expect(out).not.toContainText(/\bat .+:\d+:\d+/);   // no stack trace
  await expect(page.locator('[data-pane="1"]')).toBeVisible();   // still on step 1
  await expect(page.locator("#btn-build")).toBeEnabled();        // not locked
  await expect(page.locator("#src-locked")).toBeHidden();
  // and a reload doesn't lock it either: nothing was built
  await page.reload();
  await expect(page.locator("#btn-build")).toBeEnabled();
  await expect(page.locator("#src-locked")).toBeHidden();
}

test("the 1:1 direct-messages.js picked as the messages file gets a clear error, not 'Built 0'", async ({ page }) => {
  await submit(page, F.dm);
  await expectClearFailure(page, /1:1 direct messages file/);
});

test("account.js picked as the messages file gets a clear error", async ({ page }) => {
  await submit(page, F.account);
  await expectClearFailure(page, /account/);
});

test("an empty messages file gets a clear error", async ({ page }) => {
  const empty = path.join(exportRoot, "empty", "direct-messages-group.js");
  fs.mkdirSync(path.dirname(empty), { recursive: true });
  fs.writeFileSync(empty, "");
  await submit(page, empty);
  await expectClearFailure(page, /empty/);
});

test("a truncated messages file gets a clear error and the build log is available", async ({ page }) => {
  const cut = path.join(exportRoot, "cut", "direct-messages-group.js");
  fs.mkdirSync(path.dirname(cut), { recursive: true });
  const s = fs.readFileSync(F.group, "utf8");
  fs.writeFileSync(cut, s.slice(0, s.length >> 1));
  await submit(page, cut);
  // the pre-flight check reads the file and stops here, before a build
  // runs — so there is no build log to show, only the plain sentence.
  await expect(page.locator("#src-result")).toContainText(/truncated/);
  await expect(page.locator("#preflight")).toBeHidden();
  await expectClearFailure(page, /truncated/);
});

test("a folder given as the messages file gets a plain message, not a raw EPERM", async ({ page }) => {
  await submit(page, F.media);
  await expectClearFailure(page, /folder/);
});

test("a BOM-prefixed export builds, reports its messages and shows the build log", async ({ page }) => {
  await page.goto(BASE + "/setup.html");
  await page.locator("#src-group").fill(F.group);
  await page.locator("#src-headers").fill(F.headers);
  await page.locator("#src-media").fill(F.media);
  await checkAndBuild(page);
  const out = page.locator("#src-result");
  await expect(out).toHaveClass(/ok/, { timeout: 15000 });
  await expect(out).toContainText(/Built 7 messages across 2 group/);
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  await page.locator('[data-pane="2"] [data-back]').click();   // the result stays on step 1
  const log = out.locator("details");
  await expect(log.locator("summary")).toHaveText(/Build log/);
  await log.locator("summary").click();
  await expect(log.locator("pre")).toContainText(/Total messages: 7/);
});
