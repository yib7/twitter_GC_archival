const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, collectErrors } = require("./_viewer-fixture.js");
const { contrastFailures } = require("./_contrast.js");

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

// Each side's bars wear that person's colour (the one on their name in the
// summary), not the theme accent / pink, and stay visible on their track.
for (const th of ["lightsout", "dim", "light"]) {
  test(`each side's bars are that person's colour (${th})`, async ({ page }) => {
    await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.theme": th, "gca.settings": JSON.stringify({ colors: { u2: "#eab308" } }) } });
    const r = await page.evaluate(() => {
      const css = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
      const spans = document.querySelectorAll("#view-battles .battle-summary > span");
      return {
        left: css(".battle-fill-left", "backgroundColor"), leftImg: css(".battle-fill-left", "backgroundImage"),
        right: css(".battle-fill-right", "backgroundColor"), rightImg: css(".battle-fill-right", "backgroundImage"),
        p1: getComputedStyle(spans[0]).color, p2: getComputedStyle(spans[2]).color,
        track: css(".battle-bar-left", "backgroundColor"), page: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect([r.leftImg, r.rightImg]).toEqual(["none", "none"]);
    expect(r.left).toBe(r.p1);
    expect(r.right).toBe(r.p2);
    expect(r.left).not.toBe(r.right);
    const lum = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0);
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const fill of [r.left, r.right]) for (const bg of [r.track, r.page]) expect(cr(fill, bg), fill + " on " + bg).toBeGreaterThanOrEqual(3);
  });
}

// A word typed with a capital or punctuation ("Lol", "lol!") is the same word
// as the built-in "lol": one row, one win. (Phone keyboards capitalise the
// first letter.) So is a word in quotes or brackets (it used to be keyed with
// its quotes and count 0 beside the built-in row). Likewise "don't" and "dont"
// are one added word.
for (const typed of ["Lol", "lol!", "LOL", "\"lol\"", "“lol”", "(lol)"]) {
  test(`an added "${typed}" is one row with the built-in lol, counted once`, async ({ page }) => {
    await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ battleWords: [typed] }) } });
    const v = page.locator("#view-battles");
    await expect(v.locator(".battle-word")).toHaveText([typed, "bruh", "nah"]);
    await expect(v.locator(".battle-summary")).toContainText("User 1: 2 wins");   // lol, nah
    await expect(v.locator(".battle-summary")).toContainText("User 2: 1 win");    // bruh
  });
}
test("typing a spelling of a word already added says so and adds no row", async ({ page }) => {
  await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ battleWords: ["don't"] }) } });
  await page.locator("#battle-word").fill("Dont");
  await page.locator("#battle-go").click();
  await expect(page.locator(".toast")).toContainText("already in the battle");
  await expect(page.locator("#view-battles .battle-added")).toHaveCount(1);
});

// A word of only invisible characters (a lone zero-width joiner, pasted from
// an emoji) has nothing to count: say so, instead of adding a row that counts
// every joined emoji or doing nothing at all.
test("adding a word of only invisible characters says there is nothing to count", async ({ page }) => {
  await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles" } });
  await page.locator("#battle-word").fill("\u200D");
  await page.locator("#battle-go").click();
  await expect(page.locator(".toast")).toContainText("nothing to count");
  await expect(page.locator("#view-battles .battle-added")).toHaveCount(0);
  // an @mention is left out of every message, so it has nothing to count either
  await page.locator("#battle-word").fill("@bob");
  await page.locator("#battle-go").click();
  await expect(page.locator(".toast")).toContainText("@mentions");
  await expect(page.locator("#view-battles .battle-added")).toHaveCount(0);
});

// An added emoji (or anything with no letters or digits) is counted where it
// appears, each time it appears; it used to show 0 : 0 whatever the chat said.
const EMOJI = { conversations: [conv("A", "Duo", [
  { i: "e1", s: "u1", t: T, x: "\u{1F602}\u{1F602} ha" }, { i: "e2", s: "u1", t: T + 60000, x: "\u{1F602}" },
  { i: "e3", s: "u2", t: T + 120000, x: "lol \u{1F602}" }, { i: "e4", s: "u2", t: T + 180000, x: "?!" },
])] };
test("an added emoji counts every time each person used it", async ({ page }) => {
  await bootViewer(page, EMOJI, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ battleWords: ["\u{1F602}", "?!"] }) } });
  const rows = page.locator("#view-battles .battle-added");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".battle-count")).toHaveText(["3", "1"]);
  await expect(rows.nth(1).locator(".battle-count")).toHaveText(["0", "1"]);
});
// ❤️ is a heart, not the invisible U+FE0F after it: ☺️ is not a heart.
test("an added heart counts hearts only", async ({ page }) => {
  const HEARTS = { conversations: [conv("A", "Duo", [
    { i: "h1", s: "u1", t: T, x: "I ❤️ it" }, { i: "h2", s: "u2", t: T + 60000, x: "☺️ ✔️" },
  ])] };
  await bootViewer(page, HEARTS, { ls: { "gca.lastView": "battles", "gca.settings": JSON.stringify({ battleWords: ["❤️"] }) } });
  await expect(page.locator("#view-battles .battle-added .battle-count")).toHaveText(["1", "0"]);
});

// The winning count wears the winner's colour (it was the theme accent on both
// sides), and stays readable as text on what is behind it (tests/_contrast.js
// measures every text run in the view at 4.5:1, the winner's count included).
async function sideColours(page) {
  return page.evaluate(() => {
    const spans = document.querySelectorAll("#view-battles .battle-summary > span");
    const css = (e, p) => getComputedStyle(e)[p];
    const winners = [...document.querySelectorAll("#view-battles .battle-count.battle-winner")].map((e) => ({
      side: e.classList.contains("left") ? "left" : e.classList.contains("right") ? "right" : "?", color: css(e, "color"),
    }));
    return {
      p1: css(spans[0], "color"), p2: css(spans[2], "color"),
      left: css(document.querySelector(".battle-fill-left"), "backgroundColor"),
      right: css(document.querySelector(".battle-fill-right"), "backgroundColor"),
      winners,
    };
  });
}
for (const th of ["lightsout", "dim", "light"]) {
  test(`the winning count is that person's colour and readable (${th})`, async ({ page }) => {
    await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.theme": th, "gca.settings": JSON.stringify({ colors: { u1: "#1e40af", u2: "#eab308" } }) } });
    const r = await sideColours(page);
    expect(r.winners.length, "both sides have a winning word").toBeGreaterThanOrEqual(2);
    for (const w of r.winners) {
      expect(w.color, w.side + " winner is that side's colour").toBe(w.side === "left" ? r.p1 : r.p2);
    }
    expect(await contrastFailures(page, "#view-battles")).toEqual([]);
  });
  test(`two people with the same colour still read as two sides (${th})`, async ({ page }) => {
    await bootViewer(page, ONE_EACH, { ls: { "gca.lastView": "battles", "gca.theme": th, "gca.settings": JSON.stringify({ colors: { u1: "#eab308", u2: "#eab308" } }) } });
    const r = await sideColours(page);
    expect(r.p1).not.toBe(r.p2);
    expect(r.left).not.toBe(r.right);
    expect(r.left).toBe(r.p1);
    expect(r.right).toBe(r.p2);
    for (const w of r.winners) {
      expect(w.color).toBe(w.side === "left" ? r.p1 : r.p2);
    }
    expect(await contrastFailures(page, "#view-battles")).toEqual([]);
  });
}
test("two people whose automatic colours collide get two different colours", async ({ page }) => {
  const { personHue } = require("../src/shared-core.js");
  const ids = []; const seen = {};
  for (let k = 1; k < 200 && ids.length < 2; k++) { const id = "x" + k, h = personHue(id); if (seen[h]) ids.push(seen[h], id); else seen[h] = id; }
  expect(ids.length).toBe(2);
  const data = { conversations: [conv("A", "Duo", [
    { i: "w1", s: ids[0], t: T, x: "lol" }, { i: "w2", s: ids[1], t: T + 60000, x: "bruh" },
    { i: "w3", s: ids[0], t: T + 120000, x: "nah nah" }, { i: "w4", s: ids[1], t: T + 180000, x: "ok" },
  ])] };
  await bootViewer(page, data, { ls: { "gca.lastView": "battles" } });
  const r = await sideColours(page);
  expect(r.p1).not.toBe(r.p2);
  expect(r.left).not.toBe(r.right);
  expect(r.left).toBe(r.p1);
  expect(r.right).toBe(r.p2);
});
