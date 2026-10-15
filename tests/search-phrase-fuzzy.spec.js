const { test, expect } = require("@playwright/test");
const { bootViewer, conv, afterSearchRun } = require("./_viewer-fixture.js");

// the box promises "use quotes for exact phrases" — that holds in
// Fuzzy mode (the default) too. Fuse's close matches (the automatic fallback
// and "+ Show close matches") must still contain every quoted phrase
// contiguously (case-insensitive, same lowercasing as the exact matcher);
// unquoted words stay typo-tolerant. Synthetic data only.
const T = Date.parse("2024-03-10T12:00:00Z");
const TEXTS = [
  "we should do a movie night",
  "movie tonight at 8",
  "Movie Night with pizza",
  "the movie was a night to remember",
  "pizza party tomorrow",
];
const DATA = { conversations: [conv("A", "Alpha", TEXTS.map((x, k) => ({ i: "p" + k, s: k % 2 ? "u1" : "u2", t: T + k * 60000, x })))] };
const found = (page) => page.locator("#s-list .msg .bubble").allTextContents();
const search = (page, q) => afterSearchRun(page, () => page.locator("#s-input").fill(q));

test("a quoted phrase stays exact when close matches are added", async ({ page }) => {
  await bootViewer(page, DATA);
  await search(page, '"movie night"');
  expect((await found(page)).sort()).toEqual(["Movie Night with pizza", "we should do a movie night"]);
  await afterSearchRun(page, () => page.locator("#s-fuzzy-toggle").click());
  await expect(page.locator("#s-fuzzy-toggle")).toContainText("Exact matches only");
  expect((await found(page)).sort()).toEqual(["Movie Night with pizza", "we should do a movie night"]);
});

test("the automatic fuzzy fallback keeps quoted phrases exact; plain words stay fuzzy", async ({ page }) => {
  await bootViewer(page, DATA);
  // no literal hit: the fallback runs, but nothing contains the phrase
  await search(page, '"movie nite"');
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
  // a typo'd word next to an exact phrase: fuzzy for the word only
  await search(page, '"movie night" pizzza');
  expect(await found(page)).toEqual(["Movie Night with pizza"]);
  // unquoted, the same words are typo-tolerant as before
  await search(page, "movie nite");
  expect((await found(page)).length).toBeGreaterThan(1);
});
