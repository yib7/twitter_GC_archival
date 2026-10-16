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

// One word each: the summary reads "1 win", not "1 wins".
const T = Date.parse("2024-03-10T12:00:00Z");
const ONE_EACH = { conversations: [conv("A", "Duo", [
  { i: "w1", s: "u1", t: T, x: "lol" }, { i: "w2", s: "u2", t: T + 60000, x: "bruh" },
  { i: "w3", s: "u1", t: T + 120000, x: "nah nah" }, { i: "w4", s: "u2", t: T + 180000, x: "ok" },
])] };
test("the summary says win for one and wins for more", async ({ page }) => {
  await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles" } });
  const sum = page.locator("#view-battles .battle-summary");
  await expect(sum).toContainText(": 2 wins");
  await expect(sum).toContainText(": 1 win");
  await expect(sum).not.toContainText("1 wins");
});

// On a phone the two pickers stack, so VS goes between them, not beside the first.
test("at 375px VS sits between the stacked pickers", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await bootViewer(page, TWO, { ls: { "gca.lastView": "battles" } });
  const [p1, vs, p2] = await Promise.all([
    page.locator(".battle-picker").nth(0).boundingBox(), page.locator(".battle-vs").boundingBox(), page.locator(".battle-picker").nth(1).boundingBox()]);
  expect(vs.y, "VS below the first picker").toBeGreaterThanOrEqual(p1.y + p1.height - 1);
  expect(vs.y + vs.height, "VS above the second picker").toBeLessThanOrEqual(p2.y + 1);
  const mid = (b) => b.x + b.width / 2;
  expect(Math.abs(mid(vs) - mid(p1))).toBeLessThan(4);
  expect(Math.abs(mid(vs) - mid(p2))).toBeLessThan(4);
});

// The win tally counts every row on screen, the words added in settings too
// (it used to loop only the built-in list). A built-in word the user also
// added is one row, counted once.
test("words added to the battle count toward the wins", async ({ page }) => {
  await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ battleWords: ["ok", "lol"] }) } });
  const v = page.locator("#view-battles");
  await expect(v.locator(".battle-word")).toHaveText(["ok", "lol", "bruh", "nah"]);
  const sum = v.locator(".battle-summary");
  await expect(sum).toContainText("User 1: 2 wins");   // lol, nah
  await expect(sum).toContainText("User 2: 2 wins");   // ok (added), bruh
  // adding one more word that User 2 wins moves the tally live
  await page.locator("#battle-word").fill("bruh");
  await page.locator("#battle-go").click();
  await expect(v.locator(".battle-word")).toHaveText(["bruh", "ok", "lol", "nah"]);
  await expect(sum).toContainText("User 2: 2 wins");
});

