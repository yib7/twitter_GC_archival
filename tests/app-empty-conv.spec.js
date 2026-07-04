const { test, expect } = require("@playwright/test");

// Two groups; every sender in group A is ignored (LOCAL_IGNORED_USERS), so
// A's post-filter message list is empty (N === 0) while B is untouched.
// P1-4: a fully-ignored conversation must not blank or crash the app.
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "AllIgnored", participants: ["u1"], count: 1,
      msgs: [{ i: "a1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hi from a" }], events: [] },
    { id: "B", type: "group", title: "Beta", participants: ["u2"], count: 1,
      msgs: [{ i: "b1", s: "u2", t: Date.parse("2020-01-02T10:00:00Z"), x: "hi from beta" }], events: [] },
  ],
};

async function routeData(page, { savedConv } = {}) {
  await page.addInitScript((saved) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    if (saved) localStorage.setItem("gca.conv", saved);
  }, savedConv);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_IGNORED_USERS = ["u1"];' }));
}

test("boots on the non-empty group when the saved conversation is fully ignored", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await routeData(page, { savedConv: "A" });
  await page.goto("/");

  // Must not blank out — Beta (the group with visible messages) loads instead.
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator(".msg").first()).toContainText("hi from beta");
  await expect(page.locator("#boot")).toBeEmpty();

  expect(errors).toEqual([]);
});

test("switching to an all-ignored conversation shows a friendly panel in every view, no crash", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await routeData(page, { savedConv: "B" });
  await page.goto("/");
  await expect(page.locator(".msg").first()).toContainText("hi from beta");

  // Switch to the fully-ignored group via the conversation picker.
  await page.locator("#conv-select").selectOption("A");
  await expect(page.locator("#brand-title")).toHaveText("AllIgnored");

  const views = ["stats", "timeline", "gallery", "wrapped", "capsule"];
  for (const name of views) {
    await page.locator(`.nav-item[data-view="${name}"]`).click();
    await expect(page.locator(`#view-${name} .empty`).first()).toBeVisible();
  }

  expect(errors).toEqual([]);
});

test("boot card only appears when every conversation is empty", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  // Ignore every sender across both groups — genuinely nothing to show.
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_IGNORED_USERS = ["u1", "u2"];' }));

  await page.goto("/");

  await expect(page.locator("#boot")).toContainText("No messages found");
  // P2-3: the boot card must name real script paths and lead with the setup
  // wizard, not the stale root-level "node build.js" / "node make_sample.js".
  await expect(page.locator("#boot")).toContainText("npm start");
  await expect(page.locator("#boot")).toContainText("node scripts/build.js");
  await expect(page.locator("#boot")).toContainText("node scripts/make_sample.js");
  expect(errors).toEqual([]);
});
