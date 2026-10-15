const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, collectErrors } = require("./_viewer-fixture.js");

// Word Battles compares two people. A chat with one poster (or whose others
// are ignored) gets a plain empty state, not two blank pickers.
// Synthetic data only.
const ONE = { conversations: [conv("A", "Solo", msgs("a", 5, { s: ["u1"] }))] };
const TWO = { conversations: [conv("A", "Duo", msgs("a", 6, { s: ["u1", "u2"] }))] };

test("one poster: Word Battles explains it needs two people", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, ONE, { ls: { "gca.lastView": "battles" } });
  const v = page.locator("#view-battles");
  await expect(v.locator(".empty")).toContainText("A word battle needs two people who posted");
  await expect(v.locator("select")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("two posters, one ignored: the same empty state", async ({ page }) => {
  await bootViewer(page, TWO, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ ignoredUsers: ["u2"] }) } });
  await expect(page.locator("#view-battles .empty")).toContainText("A word battle needs two people who posted");
  await expect(page.locator("#view-battles select")).toHaveCount(0);
});

test("two posters: both pickers are filled", async ({ page }) => {
  await bootViewer(page, TWO, { ls: { "gca.lastView": "battles" } });
  await expect(page.locator("#battle-p1")).toHaveValue("u1");
  await expect(page.locator("#battle-p2")).toHaveValue("u2");
  await expect(page.locator("#view-battles .empty")).toHaveCount(0);
});
