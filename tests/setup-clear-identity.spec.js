require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");

// SP-18: a saved "This is YOU" and a saved name must be clearable. The wizard
// sends me: "" / names[id] = "" as the explicit "forget it" signal (a missing
// value still means "unchanged"). Server routes are mocked; made-up data.
const PARTS = [
  { id: "1111", count: 40, samples: ["hello there friend"], media: [] },
  { id: "2222", count: 10, samples: ["another sample line"], media: [] },
];
let saved;

test.beforeEach(async ({ page }) => {
  saved = null;
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ built: false, groups: [], ignoredGroups: [], me: "1111", names: { "1111": "Ann", "2222": "Bob" }, pfps: {} }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 50, groups: [{ id: "G1", title: "Grp", count: 50 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
  await page.route("**/api/identity", (route) => {
    saved = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, names: 1, pfps: 0, ignored: 0 }) });
  });
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await page.locator("#btn-build").click();
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person")).toHaveCount(2);
});
async function save(page) {
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
}

test("\"Nobody here is me\" clears a saved 'This is YOU'", async ({ page }) => {
  const mine = page.locator('.su-person input[type="radio"][value="1111"]');
  await expect(mine).toBeChecked();
  await page.locator("#me-clear").click();
  await expect(mine).not.toBeChecked();
  await save(page);
  expect(saved.me).toBe("");
});

test("removing your own card clears 'This is YOU' too", async ({ page }) => {
  await page.locator(".su-person").first().locator(".su-remove").click();
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  // fix round 1 (#3): removing someone asks first (preview is unmocked here, so no counts)
  await page.locator("#remove-go").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(saved.me).toBe("");
});

test("emptying a saved name sends it as cleared; untouched names aren't resent as blanks", async ({ page }) => {
  await page.locator(".su-person").first().locator(".su-name").fill("");
  await save(page);
  expect(saved.names["1111"]).toBe("");
  expect(saved.names["2222"]).toBe("Bob");
  expect(saved.me).toBe("1111");
});
