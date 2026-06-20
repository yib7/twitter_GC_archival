const { test, expect } = require("@playwright/test");

// Two groups; one is removed via LOCAL_IGNORED_GROUPS (the wizard's app-facing
// output). The removed group must not be reachable in the viewer.
const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "Alpha", participants: ["u1"], count: 1,
      msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hi from alpha" }], events: [] },
    { id: "G2", type: "group", title: "Beta", participants: ["u2"], count: 1,
      msgs: [{ i: "m2", s: "u2", t: Date.parse("2020-01-02T10:00:00Z"), x: "hi from beta" }], events: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_IGNORED_GROUPS = ["G2"];' }));
});

test("a removed group is hidden from the viewer's conversation picker", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();

  // Only Alpha remains visible, so the picker collapses and Beta is unreachable.
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  await expect(page.locator("#conv-select")).toHaveCount(0);
  await expect(page.locator(".msg").first()).toContainText("hi from alpha");
});
