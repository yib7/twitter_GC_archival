const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// Two group chats from the build. /api/parts is scoped by ?group, so each group
// returns its own roster.
const GROUPS = [
  { id: "G1", title: "Alpha", count: 100 },
  { id: "G2", title: "Beta", count: 50 },
];
const PARTS = {
  G1: [
    { id: "1111", count: 60, samples: ["alpha chatter here"], media: [] },
    { id: "2222", count: 40, samples: ["more alpha chatter"], media: [] },
  ],
  G2: [
    { id: "3333", count: 50, samples: ["beta chatter here"], media: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 150, groups: GROUPS, mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) => {
    const g = new URL(route.request().url()).searchParams.get("group") || "G1";
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS[g] || [] }) });
  });
});

async function build(page) {
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // SP7: Check export → preview → Build
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
}

test("a group selector scopes the People step to one group's participants", async ({ page }) => {
  await build(page);
  await page.locator('[data-pane="2"] [data-next]').click();

  // Defaults to the first group: only its two people show.
  await expect(page.locator(".su-person")).toHaveCount(2);
  await expect(page.locator(".su-meta")).toContainText(["id 1111", "id 2222"]);

  // Switching the group reloads the roster to just the other group's person.
  await page.selectOption("#people-group", "G2");
  await expect(page.locator(".su-person")).toHaveCount(1);
  await expect(page.locator(".su-meta")).toContainText("id 3333");
});

test("group name is kept per group and saved per-group", async ({ page }) => {
  await build(page);

  // Step 2: each group keeps its own name.
  await page.selectOption("#gc-group", "G1");
  await page.locator("#gc-name").fill("Alpha Name");
  await page.selectOption("#gc-group", "G2");
  await expect(page.locator("#gc-name")).toHaveValue("");
  await page.locator("#gc-name").fill("Beta Name");
  await page.selectOption("#gc-group", "G1");
  await expect(page.locator("#gc-name")).toHaveValue("Alpha Name");

  // Capture the save payload.
  let body = null;
  await page.route("**/api/identity", (route) => {
    body = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, names: 0, pfps: 0 }) });
  });

  await page.locator('[data-pane="2"] [data-next]').click(); // → people
  await page.locator('[data-pane="3"] [data-next]').click(); // → finish
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);

  expect(body.gc.G1.name).toBe("Alpha Name");
  expect(body.gc.G2.name).toBe("Beta Name");
});
