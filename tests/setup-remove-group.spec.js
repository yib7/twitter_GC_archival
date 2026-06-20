const { test, expect } = require("@playwright/test");

// Two groups so the group selector + remove toggle are exercised. All server
// endpoints are mocked, so this runs identically on CI.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 30, mediaCopied: 0, groups: [
        { id: "G1", title: "Alpha", count: 20 },
        { id: "G2", title: "Beta", count: 10 },
      ] }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ parts: [{ id: "1", count: 20, samples: [], media: [] }] }) }));
});

async function build(page) {
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await page.locator("#btn-build").click();
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
}

test("removing a group sends it in ignoredGroups and the people step shows a notice", async ({ page }) => {
  await build(page);

  // Step 2: switch to Beta and mark it for removal.
  await page.selectOption("#gc-group", "G2");
  await page.locator("#gc-remove").check();
  await expect(page.locator("#gc-remove")).toBeChecked();
  await expect(page.locator("#gc-group")).toContainText("removed");

  // Step 3 for the removed group: no roster, just a notice.
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator("#people")).toContainText(/marked for removal/i);

  // Capture the save payload.
  let body = null;
  await page.route("**/api/identity", (route) => {
    body = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, names: 0, pfps: 0, ignored: 0 }) });
  });
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);

  expect(body.ignoredGroups).toContain("G2");
  expect(body.ignoredGroups).not.toContain("G1");
});
