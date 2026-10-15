require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// Removing a group or a person rebuilds the archive
// without them, so a save that removes MORE than before asks first, naming the
// effect with real counts (from /api/removal-preview). Cancel saves nothing.
// Server routes are mocked; made-up data.
const PARTS = [
  { id: "1111", count: 40, samples: ["hello there friend"], media: [] },
  { id: "2222", count: 10, samples: ["another sample line"], media: [] },
];
let saved, previewed;

test.beforeEach(async ({ page }) => {
  saved = null; previewed = null;
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ built: false, groups: [], ignoredGroups: [], me: null, names: {}, pfps: {} }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 50, groups: [{ id: "G1", title: "Grp", count: 50 }, { id: "G2", title: "Other", count: 7 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
  await page.route("**/api/removal-preview", (route) => {
    previewed = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: 1234, media: 56, groups: previewed.ignoredGroups.length, people: previewed.ignoredUsers.length }) });
  });
  await page.route("**/api/identity", (route) => {
    saved = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, names: 0, pfps: 0, ignored: saved.ignoredUsers.length, rebuilt: true, mediaRemoved: 56 }) });
  });
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // Check export → preview → Build
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person")).toHaveCount(2);
});
async function toFinish(page) { await page.locator('[data-pane="3"] [data-next]').click(); }

test("removing a person asks first, with real counts and 'every group'; Cancel saves nothing", async ({ page }) => {
  await page.locator(".su-person").nth(1).locator(".su-remove").click();
  await toFinish(page);
  await page.locator("#btn-save").click();
  const dlg = page.locator("#remove-modal");
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("role", "dialog");
  await expect(dlg).toContainText("Permanently removes 1,234 messages and their 56 media files");
  await expect(dlg).toContainText(/every group/);
  expect(previewed.ignoredUsers).toEqual(["2222"]);
  await expect(page.locator("#remove-cancel")).toBeFocused();
  await page.locator("#remove-cancel").click();
  await expect(dlg).toBeHidden();
  expect(saved).toBe(null);
  await expect(page.locator("#finish-result")).toContainText(/Nothing was saved/);

  await page.locator("#btn-save").click();
  await page.locator("#remove-go").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(saved.ignoredUsers).toEqual(["2222"]);
});

test("removing a group chat asks first too; Escape cancels", async ({ page }) => {
  await page.locator('[data-pane="3"] [data-back]').click();
  await page.locator("#gc-remove").check();
  await page.locator('[data-pane="2"] [data-next]').click();
  await toFinish(page);
  await page.locator("#btn-save").click();
  const dlg = page.locator("#remove-modal");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("1,234 messages");
  expect(previewed.ignoredGroups).toEqual(["G1"]);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(saved).toBe(null);
});

test("a save that removes nothing new doesn't ask", async ({ page }) => {
  await toFinish(page);
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  await expect(page.locator("#remove-modal")).toBeHidden();
  expect(previewed).toBe(null);
});
