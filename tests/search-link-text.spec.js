const { test, expect } = require("@playwright/test");
const { bootViewer, conv, afterSearchRun } = require("./_viewer-fixture.js");

// a message shows its links by their display / expanded URL
// ("youtube.com/watch?v=xyz") while its text holds the raw t.co short link.
// Search indexes the expanded + display URLs too, so what you see is what you
// can find (exact, fuzzy and -exclusions), with the visible link highlighted —
// while the word cloud / keyword analytics keep reading the message text only.
// Synthetic data only.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "l1", s: "u1", t: T, x: "check this https://t.co/abc", u: [{ s: "https://t.co/abc", e: "https://www.youtube.com/watch?v=xyz", d: "youtube.com/watch?v=xyz" }] },
  { i: "l2", s: "u2", t: T + 60000, x: "no links here, just words words words" },
  { i: "l3", s: "u1", t: T + 120000, x: "recipe https://t.co/r1", u: [{ s: "https://t.co/r1", e: "https://cooking.example/lasagna-recipe", d: "cooking.example/lasagna-r…" }] },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const found = (page) => page.locator("#s-list .msg .bubble").allTextContents();
const search = (page, q) => afterSearchRun(page, () => page.locator("#s-input").fill(q));

test("the link text a message shows can be searched, and is highlighted", async ({ page }) => {
  await bootViewer(page, DATA);
  await search(page, "youtube");
  expect(await found(page)).toEqual(["check this youtube.com/watch?v=xyz"]);
  await expect(page.locator("#s-list .msg .bubble a mark")).toHaveText("youtube");
  // the expanded URL counts too (the display text is cut short)
  await search(page, "lasagna");
  expect(await found(page)).toEqual(["recipe cooking.example/lasagna-r…"]);
  // exclusions see it as well
  await search(page, "-youtube");
  await expect(page.locator("#s-meta")).toContainText("2 messages found");
  // Exact mode, and a fuzzy (typo'd) query
  await page.locator('#f-matchtoggle [data-mode="exact"]').click();
  await search(page, "youtube.com/watch");
  expect(await found(page)).toEqual(["check this youtube.com/watch?v=xyz"]);
  await page.locator('#f-matchtoggle [data-mode="fuzzy"]').click();
  await search(page, "yuotube");
  expect(await found(page)).toEqual(["check this youtube.com/watch?v=xyz"]);
});

test("link text stays out of the word cloud", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "stats" } });
  await expect(page.locator("#words .cloud-word").first()).toBeVisible();
  const words = (await page.locator("#words .cloud-word").allTextContents()).map((w) => w.toLowerCase());
  expect(words.some((w) => /youtube|lasagna|cooking/.test(w))).toBe(false);
  expect(words.some((w) => /words/.test(w))).toBe(true);
});
