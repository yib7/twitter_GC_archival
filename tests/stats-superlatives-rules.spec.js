const { test, expect } = require("@playwright/test");
const { bootViewer, collectErrors } = require("./_viewer-fixture.js");

// SP4 superlative definitions (AN-3 / AN-7 / AN-8 / AN-9):
//  - frequency awards are RATES (per 100 messages / % of messages) and need a
//    minimum sample (MIN_MSGS messages), so a 3-message lurker who posted once
//    at 3 AM is not the Late Night Owl and the top poster doesn't win every
//    count by volume;
//  - a card is hidden when its best value is 0 or every eligible person ties;
//    2+ people sharing the top are shown as a tie;
//  - platform links match on the hostname (netflix.com is not x.com);
//  - The Laugh Track counts emoji 😂 reactions as well as "funny";
//  - The Ghost includes members who never posted;
//  - every card says how it is measured (.s-def);
//  - profile badges come from the SAME list as the grid (AN-3: the top poster
//    used to get "The Sailor" for 0 swear messages).
test.use({ timezoneId: "UTC" });

function fixture() {
  const out = [];
  const T = (d, h, m) => Date.UTC(2024, 2, 4 + d, h, m);
  const add = (s, t, x, extra) => out.push(Object.assign({ s, t, x }, extra || {}));
  for (let k = 0; k < 100; k++) {
    const x = k >= 10 && k < 20 ? "WOW THIS IS GREAT" : k >= 20 && k < 30 ? "nice one 🔥" : "hello there friend";
    const extra = k === 30 ? { u: [{ s: "https://t.co/n", e: "https://www.netflix.com/title/1", d: "netflix.com/title/1" }] }
      : k === 40 ? { r: [{ k: "funny", s: "u2" }] }
      : k === 41 ? { r: [{ k: "emoji", e: "😂", s: "u2" }] } : null;
    add("u1", T(Math.floor(k / 3), k < 10 ? 1 : 14, (k % 3) * 5), x, extra);
  }
  for (let k = 0; k < 20; k++) {
    const x = k === 6 || k === 7 ? "WOW THIS IS GREAT" : k === 8 || k === 9 ? "nice 🔥" : "ok sounds good";
    const extra = k === 10 ? { u: [{ s: "https://t.co/x", e: "https://x.com/a/status/1", d: "x.com/a/status/1" }] }
      : k === 11 ? { r: [{ k: "funny", s: "u1" }] } : null;
    add("u2", T(k, k < 6 ? 2 : 15, 1), x, extra);
  }
  for (let k = 0; k < 20; k++) add("u4", T(k, 16, 2), k < 2 ? "WOW THIS IS GREAT" : "yep all good here");
  for (let k = 0; k < 3; k++) add("u3", T(k, 3, 3), "zzz late");
  out.sort((a, b) => a.t - b.t);
  out.forEach((m, k) => { m.i = "m" + k; });
  return { conversations: [{ id: "G", type: "group", title: "Rules", participants: ["u1", "u2", "u4", "u3", "u9"], count: out.length, msgs: out, events: [] }] };
}

async function openStats(page) {
  await bootViewer(page, fixture());
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
}
const card = (page, title) => page.locator(".card.super", { has: page.locator(".s-title", { hasText: new RegExp("^" + title + "$") }) });

test("rates with a minimum sample, ties, hidden all-tie / zero cards", async ({ page }) => {
  const errors = collectErrors(page);
  await openStats(page);
  // User 2: 6 of 20 msgs at night (30%) beats User 1's 10 of 100; User 4
  // (u3, 3 msgs, all at 3 AM) is below the minimum sample.
  await expect(card(page, "Late Night Owl").locator(".s-name")).toHaveText("User 2");
  await expect(card(page, "Late Night Owl").locator(".s-stat")).toContainText("30%");
  // 10 emoji per 100 msgs each — a shown tie.
  await expect(card(page, "Emoji Enthusiast").locator(".s-name")).toHaveText("User 1");
  await expect(card(page, "Emoji Enthusiast").locator(".s-tie")).toContainText("User 2");
  // Every eligible person shouts in 10% of their messages → no Shouter.
  await expect(card(page, "The Shouter")).toHaveCount(0);
  // Nobody swears → no Sailor (and no Sailor badge, below).
  await expect(card(page, "The Sailor")).toHaveCount(0);
  // netflix.com is not x.com.
  await expect(card(page, "X/Twitter Addict").locator(".s-name")).toHaveText("User 2");
  await expect(card(page, "X/Twitter Addict").locator(".s-tie")).toHaveCount(0);
  // 1 funny + 1 😂 emoji reaction beats 1 funny.
  await expect(card(page, "The Laugh Track").locator(".s-name")).toHaveText("User 2");
  await expect(card(page, "The Laugh Track").locator(".s-stat")).toContainText(/^2 /);
  // The roster-only member is the Ghost.
  await expect(card(page, "The Ghost").locator(".s-name")).toHaveText("User 5");
  await expect(card(page, "The Ghost").locator(".s-stat")).toHaveText("Never posted");
  // Each card explains its definition.
  const defs = await page.locator(".card.super .s-def").allTextContents();
  expect(defs.length).toBe(await page.locator(".card.super").count());
  for (const d of defs) expect(d.trim().length).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test("profile badges are exactly the grid cards the person wins (AN-3)", async ({ page }) => {
  await openStats(page);
  const won = await page.locator(".card.super").evaluateAll((els) => els
    .filter((e) => (e.dataset.winners || "").split(" ").includes("u1"))
    .map((e) => e.querySelector(".s-title").textContent));
  expect(won).toContain("Emoji Enthusiast");
  await page.locator('.card.super .av[data-id="u1"]').first().click();
  await expect(page.locator(".profile-modal")).toBeVisible();
  await expect(page.locator(".profile-modal .profile-badge").first()).toBeVisible();
  const badges = (await page.locator(".profile-modal .profile-badge").allTextContents()).map((t) => t.replace(/^\S+\s*/, "").trim());
  expect(badges).toEqual(won);
  expect(badges).not.toContain("The Sailor");
});

// Timing / vocabulary awards on a second fixture:
//  - The Flash / The Ghoster compare the MEDIAN reply (answers within 12 h);
//  - The Deserter is the longest run of others' messages between two of yours
//    (or after your last one);
//  - The Scholar compares distinct words among each person's first N words
//    (the same N for everyone), so the chattier person has no volume edge.
function fixture2() {
  const out = [];
  let t = Date.UTC(2024, 4, 1, 10, 0);
  const word = (k) => "w" + String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + Math.floor(k / 26) % 26) + String.fromCharCode(97 + Math.floor(k / 676) % 26);
  let u1k = 0;
  const u1 = () => { const x = word(u1k++) + " " + word(u1k++); return x; };
  for (let k = 0; k < 40; k++) {
    if (k % 2 === 0) { t += 60000; out.push({ s: "u1", t, x: u1() }); }        // u1 answers after 1 min
    else { t += 600000; out.push({ s: "u2", t, x: "same thing again" }); }      // u2 answers after 10 min
  }
  for (let k = 0; k < 60; k++) { t += 60000; out.push({ s: "u1", t, x: u1() }); } // u2 silent for 60
  for (let k = 0; k < 40; k++) { t += 60000; out.push({ s: "u2", t, x: "same thing again" }); } // u1 trailing 40
  out.forEach((m, k) => { m.i = "q" + k; });
  return { conversations: [{ id: "G2", type: "group", title: "Timing", participants: ["u1", "u2"], count: out.length, msgs: out, events: [] }] };
}

test("Flash / Ghoster medians, Deserter silence, Scholar at a common N", async ({ page }) => {
  await bootViewer(page, fixture2());
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
  // u1 (User 1, 80 msgs) and u2 (User 2, 60 msgs).
  await expect(card(page, "The Flash").locator(".s-name")).toHaveText("User 1");
  await expect(card(page, "The Flash").locator(".s-stat")).toHaveText("1.0m median reply");
  await expect(card(page, "The Ghoster").locator(".s-name")).toHaveText("User 2");
  await expect(card(page, "The Ghoster").locator(".s-stat")).toHaveText("10.0m median reply");
  await expect(card(page, "The Deserter").locator(".s-name")).toHaveText("User 2");
  await expect(card(page, "The Deserter").locator(".s-stat")).toContainText("60 messages from others");
  await expect(card(page, "The Scholar").locator(".s-name")).toHaveText("User 1");
  await expect(card(page, "The Scholar").locator(".s-stat")).toHaveText("100 different words in first 100");
  await expect(card(page, "The Scholar").locator(".s-def")).toContainText("first 100 words");
});
