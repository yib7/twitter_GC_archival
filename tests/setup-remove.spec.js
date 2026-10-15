const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// Synthetic participants returned by /api/parts, so the wizard's People step
// renders without any built personal_data/. The server's build/parts/identity
// endpoints are all mocked, so this runs identically on CI.
const PARTS = [
  { id: "1111", count: 120, samples: ["hi", "hello"], media: [] },
  { id: "2222", count: 80, samples: ["yo"], media: [] },
  { id: "3333", count: 5, samples: [], media: [] }, // the "bot" to remove
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 205, groups: [{ id: "G1", title: "Grp", count: 205 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
});

// Drive the wizard from the source step through to the People step.
async function gotoPeopleStep(page) {
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // SP7: Check export → preview → Build
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person").first()).toBeVisible();
}

test("a removed participant is sent as ignored and their name is dropped", async ({ page }) => {
  await gotoPeopleStep(page);
  const cards = page.locator(".su-person");
  await expect(cards).toHaveCount(3);

  await cards.nth(0).locator(".su-name").fill("Alice");
  await cards.nth(2).locator(".su-name").fill("SpamBot");

  // Remove the third participant; the card shows a removed state.
  await cards.nth(2).getByRole("button", { name: /^remove$/i }).click();
  await expect(cards.nth(2)).toHaveClass(/removed/);

  // Capture what the wizard sends on save.
  let body = null;
  await page.route("**/api/identity", (route) => {
    body = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, names: 1, pfps: 0, ignored: 1 }) });
  });

  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await page.locator("#remove-go").click();   // fix round 1 (#3): removing asks first
  await expect(page.locator("#finish-result")).toContainText(/Saved/);

  expect(body.ignoredUsers).toContain("3333");
  expect(body.names).not.toHaveProperty("3333"); // removed person's name dropped
  expect(body.names).toHaveProperty("1111", "Alice"); // kept person survives
});

test("removing a participant then undoing keeps them", async ({ page }) => {
  await gotoPeopleStep(page);
  const card = page.locator(".su-person").nth(2);

  await card.getByRole("button", { name: /^remove$/i }).click();
  await expect(card).toHaveClass(/removed/);

  await card.getByRole("button", { name: /^undo$/i }).click();
  await expect(card).not.toHaveClass(/removed/);
});
