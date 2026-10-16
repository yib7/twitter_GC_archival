require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForBootLine } = require("./_wait-for-boot-line.js");
const X = require("./fixtures/x-export.js");
const { checkAndBuild } = require("./_setup-helpers.js");

// the wizard shows how far the media copy is while a
// build runs. Own server (GCA_PORT=0, mkdtemp GCA_PERSONAL, root fallbacks and
// native pickers off) with GCA_TEST_COPY_DELAY_MS slowing each media file down
// so the progress is visible; synthetic export only.
let BASE, proc, personal, exportRoot, F;

test.beforeAll(async () => {
  personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-progress-personal-"));
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-progress-export-"));
  F = X.writeExport(exportRoot, { manifest: true });
  proc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: personal, GCA_PORT: "0", GCA_NO_ROOT_FALLBACK: "1", GCA_NO_NATIVE_PICKER: "1", GCA_TEST_COPY_DELAY_MS: "700" }),
    stdio: "pipe",
  });
  BASE = "http://127.0.0.1:" + (await waitForBootLine(proc, 10000));
});
test.afterAll(() => {
  if (proc) proc.kill();
  for (const d of [personal, exportRoot]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("the media copy shows files and bytes as it goes, then the build finishes", async ({ page }) => {
  await page.goto(BASE + "/setup.html");
  await page.locator("#src-root").fill(F.root);
  await checkAndBuild(page);
  const out = page.locator("#src-result");
  await expect(out).toContainText(/Copying photos & videos… [12] of 3 files \(\d+ B of 13 B\)/);
  await expect(out.locator("progress.build-progress")).toBeVisible();
  await expect(out).toHaveClass(/ok/, { timeout: 15000 });
  await expect(out).toContainText(/Built 7 messages/);
  await expect(out.locator("progress")).toHaveCount(0);
});
