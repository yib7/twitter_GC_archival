require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

// adding an export OLDER than the archive needs an
// explicit extra confirm in the wizard. Real server (GCA_PORT=0, mkdtemp
// GCA_PERSONAL, no native pickers), synthetic exports only: the archive is
// built from the newer export B, then the older A is offered as a merge.
let S, A, B;
const dirs = [];
test.beforeAll(async () => {
  S = await startServer();
  const ra = fs.mkdtempSync(path.join(os.tmpdir(), "gca-older-a-")), rb = fs.mkdtempSync(path.join(os.tmpdir(), "gca-older-b-"));
  dirs.push(ra, rb);
  A = X.writeExport(ra, { manifest: true });
  B = X.writeExportB(rb);
  expect((await S.post("/api/source", { archiveRoot: B.root })).status).toBe(200);
});
test.afterAll(() => { if (S) S.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("an older export is merged only after ticking the extra confirm", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-add").click();
  await page.locator("#src-root").fill(A.root);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator('#pf-warnings [data-code="older-export"]')).toContainText(/older than your archive/);
  const confirm = page.locator("#btn-confirm");
  const ok = page.locator("#pf-older-ok");
  await expect(ok).toBeVisible();
  await expect(page.locator("#pf-older")).toContainText(/This export is older than my archive/);
  await expect(ok).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  // and it looks off, not just ignores clicks
  expect(Number(await confirm.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.7);
  await ok.check();
  await expect(confirm).toBeEnabled();
  expect(Number(await confirm.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
  await ok.uncheck();
  await expect(confirm).toBeDisabled();
  await ok.check();
  await confirm.click();
  await expect(page.locator("#src-result")).toHaveClass(/ok/, { timeout: 15000 });
  await expect(page.locator("#src-result")).toContainText(/Merged: 5 new messages added — your archive now has 12 messages/);
});

test("a newer export shows no extra confirm", async ({ page }) => {
  const rc = fs.mkdtempSync(path.join(os.tmpdir(), "gca-older-c-"));
  dirs.push(rc);
  // a later download: one message newer than anything in the archive
  const data = path.join(rc, "data");
  fs.mkdirSync(path.join(data, "direct_messages_group_media"), { recursive: true });
  const t = X.T0 + 60 * 86400e3;
  fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [X.gmsg(9301, 111, t, "newer than the archive")])]));
  fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", [X.conv("1000000001", [X.hmsg(9301, 111, t)])]));
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-add").click();
  await page.locator("#src-root").fill(rc);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator("#pf-older-ok")).toBeHidden();
});

// an export with no group messages can't be merged —
// the preview says so and its merge button stays off.
test("an export with no group messages can't be merged", async ({ page }) => {
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), "gca-older-d-"));
  dirs.push(rd);
  const data = path.join(rd, "data");
  fs.mkdirSync(path.join(data, "direct_messages_group_media"), { recursive: true });
  const ev = { conversationNameUpdate: { initiatingUserId: "111", name: "Renamed", createdAt: X.iso(X.T0 + 90 * 86400e3) } };
  fs.writeFileSync(path.join(data, "direct-messages-group.js"), X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [ev])]));
  fs.writeFileSync(path.join(data, "direct-message-group-headers.js"), X.ytd("direct_message_group_headers", "part0", [X.conv("1000000001", [ev])]));
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-add").click();
  await page.locator("#src-root").fill(rd);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator('#pf-warnings [data-code="zero-messages"]')).toBeVisible();
  await expect(page.locator("#btn-confirm")).toBeDisabled();
});

// re-adding an export the archive already has isn't
// "older" — the confirm says what will actually happen.
test("re-adding the same export asks to re-add anyway, not to merge an older one", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-add").click();
  await page.locator("#src-root").fill(B.root);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  await expect(page.locator('#pf-warnings [data-code="older-export"]')).toContainText(/already in your archive/);
  const label = page.locator("#pf-older");
  await expect(label).toBeVisible();
  await expect(label).toContainText("Re-add anyway (nothing new will be added)");
  await expect(label).not.toContainText(/older/);
  await expect(page.locator("#btn-confirm")).toBeDisabled();
  await page.locator("#pf-older-ok").check();
  await expect(page.locator("#btn-confirm")).toBeEnabled();
});
