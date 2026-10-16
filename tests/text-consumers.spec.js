const { test, expect } = require("@playwright/test");
const { bootViewer, collectErrors } = require("./_viewer-fixture.js");
const S = require("../src/shared-core.js");

// every view that counts words or emoji
// uses the ONE definition in shared-core (extractEmojis / tokenize / countWord)
// — Stats (top emojis, word cloud, total words), Wrapped (emoji + word of the
// year), Word Battles (default AND custom rows) and the keyword trend.
//   - a skin-tone emoji is one emoji, never a stray 🏽;
//   - curly-apostrophe contractions never leave "don" / "didn" fragments;
//   - "lol!" / "lol." are the word lol; "many" is not the word "man".

const T0 = Date.parse("2024-05-01T12:00:00Z");
const LINES = [
  ["u1", "I don’t know, I didn’t see it 👍🏽"],
  ["u1", "I don’t think so 👍🏽👍🏽"],
  ["u1", "don’t worry, pizza tonight"],
  ["u1", "pizza pizza, didn’t we say pizza?"],
  ["u1", "many humans here"],
  ["u1", "привет друзья, привет"],
  ["u1", "👍🏽👍🏽"],
  ["u1", "lol! ok"],
  ["u2", "lol. lol, lol?"],
  ["u2", "man oh man man"],
  ["u2", "see https://example.com/some/long/path ok"],
  ["u2", "I don’t care, didn’t ask 👍🏽"],
];
const MSGS = LINES.map(([s, x], k) => ({ i: "m" + k, s, t: T0 + k * 3600000, x }));
const DATA = { conversations: [{ id: "G", type: "group", title: "Words", participants: ["u1", "u2"], count: MSGS.length, msgs: MSGS, events: [] }] };

const openStats = async (page) => {
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
};

test("Stats: top emojis, word cloud and total words share the tokenizer / emoji grammar", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA);
  await openStats(page);

  const emojis = await page.locator("#top-emojis .word").evaluateAll((els) => els.map((e) => e.firstChild.textContent));
  expect(emojis[0]).toBe("👍🏽");
  expect(emojis).not.toContain("🏽");
  expect(emojis).not.toContain("👍");

  const cloud = await page.locator("#words .cloud-word").evaluateAll((els) => els.map((e) => e.firstChild.textContent));
  for (const frag of ["don", "didn", "t", "i'm"]) expect(cloud).not.toContain(frag);
  expect(cloud[0]).toBe("pizza");
  expect(cloud).toContain("привет");

  // Total words = shared-core tokens (emoji-only and URL-only runs are not words).
  const want = MSGS.reduce((n, m) => n + S.tokenize(m.x).length, 0);
  const card = page.locator("#view-stats .mile", { hasText: "Total words sent" });
  await expect(card.locator(".stat-num")).toHaveAttribute("data-count", String(want));
  expect(errors).toEqual([]);
});

test("Wrapped: the emoji of the year keeps its skin tone; the word of the year is never a fragment", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="wrapped"]').click();
  const slide = page.locator("#wr-slide");
  await expect(slide).toBeVisible();
  const seen = {};
  for (let k = 0; k < 12; k++) {
    const txt = await slide.textContent();   // not innerText: CSS text-transform
    if (/word of the year/.test(txt)) seen.word = txt;
    if (/emoji of the year/.test(txt)) seen.emoji = txt;
    if (seen.word && seen.emoji) break;
    await page.locator("#wr-next").click();
  }
  expect(seen.word).toContain('"pizza"');
  expect(seen.emoji).toContain("👍🏽");
  expect(seen.emoji).not.toMatch(/^🏽/m);
});

test("Word Battles: default and custom rows count the same whole-word tokens", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="battles"]').click();
  const row = (w) => page.locator("#battle-results .battle-row", { has: page.locator(".battle-word", { hasText: new RegExp("^" + w + "$") }) }).first();
  const counts = async (w) => (await row(w).locator(".battle-count").allTextContents()).map(Number);
  // PARTS order: u1 (8 msgs) left, u2 (4 msgs) right.
  expect(await counts("lol")).toEqual([1, 3]);
  expect(await counts("man")).toEqual([0, 3]);
  await page.locator("#battle-word").fill("man");
  await page.locator("#battle-go").click();
  await expect(page.locator("#battle-results .battle-added .battle-count")).toHaveText(["0", "3"]);
  await page.locator("#battle-word").fill("don’t");
  await page.locator("#battle-go").click();
  await expect(page.locator("#battle-results .battle-added").first().locator(".battle-count")).toHaveText(["3", "1"]);
});

test("the keyword trend counts whole-word uses, not substrings", async ({ page }) => {
  await bootViewer(page, DATA);
  await openStats(page);
  await page.locator("#trend-input").fill("man");
  await page.locator("#trend-input").press("Enter");
  const total = () => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById("chart-trends"));
    return c && c.data.datasets[0].label === '"man" frequency' ? c.data.datasets[0].data.reduce((a, b) => a + b, 0) : null;
  });
  await expect.poll(total).toBe(3);
});

// An emoji keyword is counted where it appears, whole, the way Word Battles
// counts it: it used to chart a flat zero, as an emoji has no word in it.
test("the keyword trend counts an emoji keyword", async ({ page }) => {
  await bootViewer(page, DATA);
  await openStats(page);
  await page.locator("#trend-input").fill("\u{1F44D}\u{1F3FD}");
  await page.locator("#trend-input").press("Enter");
  const total = () => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById("chart-trends"));
    return c && c.data.datasets[0].label === "\"\u{1F44D}\u{1F3FD}\" frequency" ? c.data.datasets[0].data.reduce((a, b) => a + b, 0) : null;
  });
  await expect.poll(total).toBe(6);
});

// Review fix 7: the word cloud and the Wrapped word of the year count a word
// once across its spellings (y'all / y’all / yall), shown in the commonest one.
test("word cloud and word of the year merge apostrophe spellings", async ({ page }) => {
  const lines = ["y'all ready", "y'all coming", "y’all here", "yall sure", "pizza night", "pizza again", "pizza time"];
  const msgs = lines.map((x, k) => ({ i: "y" + k, s: k % 2 ? "u2" : "u1", t: T0 + k * 3600000, x }));
  const data = { conversations: [{ id: "G", type: "group", title: "Yall", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };
  await bootViewer(page, data);
  await openStats(page);
  const cloud = await page.locator("#words .cloud-word").evaluateAll((els) => els.map((e) => [e.firstChild.textContent, e.querySelector("b") ? e.querySelector("b").textContent : ""]));
  expect(cloud.filter(([w]) => w.replace(/['’]/g, "") === "yall")).toEqual([["y'all", "4"]]);
  await page.locator('.nav-item[data-view="wrapped"]').click();
  const slide = page.locator("#wr-slide");
  let word = "";
  for (let k = 0; k < 12 && !word; k++) {
    const txt = await slide.textContent();
    if (/word of the year/.test(txt)) word = txt;
    else await page.locator("#wr-next").click();
  }
  expect(word).toContain('"y\'all"');
  expect(word).toContain("used 4 times");
});
