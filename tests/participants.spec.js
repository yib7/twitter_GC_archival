const { test, expect } = require("@playwright/test");
const { bootViewer, collectErrors } = require("./_viewer-fixture.js");

// SP4 AN-14: a person who never posted — on the roster only, reacting only,
// or joining / leaving without a word — is still a member of the chat: they
// appear in People, the people count, the name pickers and reaction tooltips,
// numbered with the same "User N" everywhere (AN-15).
// SP4 AN-19: an ignored user's REACTIONS are dropped too, not only their
// messages — they never show in chips, tooltips, counts or awards.
// SP4 UX-25: one person colour everywhere (the avatar hue), not a second
// palette for battles / foreign pins / the quote card.

const T0 = Date.parse("2024-04-01T12:00:00Z");
const MSGS = [
  { i: "m1", s: "u1", t: T0, x: "first post", r: [{ s: "u3", k: "funny" }, { s: "u6", k: "funny" }] },
  { i: "m2", s: "u2", t: T0 + 60000, x: "reply one", r: [{ s: "u6", k: "disagree" }] },
  { i: "m3", s: "u1", t: T0 + 120000, x: "second post" },
  { i: "m4", s: "u6", t: T0 + 180000, x: "ignored person talking" },
  { i: "m5", s: "u2", t: T0 + 240000, x: "reply two" },
  { i: "m6", s: "u1", t: T0 + 300000, x: "third post" },
];
const DATA = {
  ignoredUsers: ["u6"],
  conversations: [{
    id: "G", type: "group", title: "Roster", participants: ["u1", "u2", "u3", "u9", "u6"], count: MSGS.length, msgs: MSGS,
    events: [
      { type: "join", t: T0 - 60000, s: "u1", ids: ["u8"] },
      { type: "leave", t: T0 + 200000, ids: ["u7"] },
    ],
  }],
};

test("roster-only, reaction-only and join/leave-only members are people too", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="people"]').click();
  const cards = page.locator("#people-body .person");
  await expect(cards).toHaveCount(6);                       // u1 u2 + u3 u9 u8 u7, never u6
  const ids = await cards.locator(".person-id").allTextContents();
  expect(ids.map((s) => s.replace(/^id /, ""))).toEqual(["u1", "u2", "u3", "u9", "u8", "u7"]);
  // Placeholders are the same generic names used everywhere else.
  const ph = await cards.locator(".person-name-input").evaluateAll((els) => els.map((e) => e.placeholder));
  expect(ph).toEqual(["User 1", "User 2", "User 3", "User 4", "User 5", "User 6"]);
  await expect(cards.nth(3).locator(".person-meta")).toContainText("Never posted");

  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
  await expect(page.locator(".hero .h-inline .it").first().locator(".v")).toHaveAttribute("data-count", "6");
  await expect(page.locator("#sidebar-foot-text")).toContainText("6 people");
  expect(errors).toEqual([]);
});

test("an ignored user's reactions are dropped everywhere", async ({ page }) => {
  await bootViewer(page, DATA);
  // Timeline chips: m1 keeps only u3's 😂 (named by the generic name), m2 has none.
  const react = page.locator(".reacts .react");
  await expect(react).toHaveCount(1);
  await expect(react.first()).toHaveAttribute("title", "funny — User 3");

  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#view-stats .mile", { hasText: "Reactions given" }).locator(".stat-num")).toHaveAttribute("data-count", "1");
  // The Hater would be u6 (the only 👎) — ignored, so no card at all.
  await expect(page.locator(".card.super", { hasText: "The Hater" })).toHaveCount(0);
});

test("one person colour: battles and avatars agree", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="battles"]').click();
  const res = await page.evaluate(() => {
    const summary = document.querySelectorAll("#battle-results .battle-summary span[style]");
    const av = document.querySelector('.battle-picker .av[data-id="u1"]');
    return { name: summary[0] && getComputedStyle(summary[0]).color, av: av && getComputedStyle(av).getPropertyValue("--p").trim() };
  });
  expect(res.av).toMatch(/^var\(--p-|^#/);
  // The summary name is painted with the avatar's --p hue (resolved).
  const want = await page.evaluate((v) => {
    const probe = document.createElement("span"); probe.style.color = v; document.body.appendChild(probe);
    const c = getComputedStyle(probe).color; probe.remove(); return c;
  }, res.av);
  expect(res.name).toBe(want);
});
