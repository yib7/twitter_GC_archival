const { test, expect } = require("@playwright/test");

// UX-20 (SP3): the default zone is now the viewer's own ("local"). This spec's
// expected dates were written for UTC, so it pins the browser zone to UTC.
test.use({ timezoneId: "UTC" });

// SP8 characterization pin (behavior-preserving refactor of computeStats'
// superlative winners into a data table + derive loop).
//
// This freezes the ENTIRE rendered Superlatives grid on the repo sample data
// (data.sample.js): for every ".card.super", the winner name (.s-name), the
// title (.s-title), and the full stat text (.s-stat), in DOM order. Where the
// sibling stats-superlatives-guard.spec.js only pins the card *titles* and the
// profile badges, this pins the winner *identity* and the exact desc string per
// card — so any drift in which person wins, or in how a value is formatted, is
// caught. The golden below was captured from the pre-refactor code and must
// pass byte-identically before and after the refactor.

const GOLDEN = [
  { name: "User 1", title: "Late Night Owl", stat: "5 msgs (12AM-5AM)" },
  { name: "User 1", title: "Reaction Magnet", stat: "10 reactions" },
  { name: "User 1", title: "Emoji Enthusiast", stat: "2 emojis used" },
  { name: "User 1", title: "Media Hog", stat: "2 files shared" },
  { name: "User 2", title: "The Yapper", stat: "9.1 words / msg" },
  { name: "User 3", title: "The Caveman", stat: "6.0 words / msg" },
  { name: "User 5", title: "The Inquisitor", stat: "1 questions asked" },
  { name: "User 2", title: "The Narcissist", stat: '6 "I/me/my"' },
  { name: "User 4", title: "The Giver", stat: "10 reactions given" },
  { name: "User 4", title: "Thread Starter", stat: "2 days started" },
  { name: "User 1", title: "Thread Killer", stat: "1 days ended" },
  { name: "User 2", title: "The Double Texter", stat: "3 double texts" },
  { name: "User 2", title: "Weekend Warrior", stat: "13 weekend msgs" },
  { name: "User 3", title: "The Work Slacker", stat: "3 msgs (9-5)" },
  { name: "User 5", title: "The Ghost", stat: "Only 7 messages total" },
  { name: "User 5", title: "The Ghoster", stat: "19.0m avg reply" },
  { name: "User 2", title: "The Flash", stat: "12.1m avg reply" },
  { name: "User 1", title: "The Scholar", stat: "76 unique words" },
  { name: "User 2", title: "The Novelist", stat: "84 chars (longest msg)" },
  { name: "User 1", title: "The Early Bird", stat: "4 msgs (5AM-8AM)" },
  { name: "User 1", title: "Vampiric Owl", stat: "3 msgs (3AM-5AM)" },
  { name: "User 5", title: "The Deserter", stat: "12.0 hrs without sending" },
  { name: "User 1", title: "Crowd Pleaser", stat: "0.6 reacts / msg avg" },
  { name: "User 5", title: "The Ignored", stat: "85.7% msgs 0 reacts" },
  { name: "User 3", title: "The Laugh Track", stat: "2 😂/😭 given" },
  { name: "User 4", title: "The Hater", stat: "4 👎/😡 given" },
  { name: "User 1", title: "Gratitude King", stat: "2 'thank you's" },
  { name: "User 3", title: "The Optimist", stat: "2 positive words" },
  { name: "User 1", title: "The Zoomer", stat: "2 Gen-Z slangs" },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  // Let the repo's real data.sample.js load; keep data.js / local.js inert.
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("superlatives grid renders identical winner/title/stat per card on sample data", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await page.goto("/");
  await page.locator('.nav-item[data-view="stats"]').click();

  const section = page.locator(".section", { hasText: "Superlatives & Fun Stats" });
  await expect(section).toBeVisible();
  await expect(section.locator(".card.super").first()).toBeVisible();

  const cards = await section.locator(".card.super").evaluateAll((nodes) =>
    nodes.map((n) => ({
      name: n.querySelector(".s-name") ? n.querySelector(".s-name").textContent : null,
      title: n.querySelector(".s-title") ? n.querySelector(".s-title").textContent : null,
      stat: n.querySelector(".s-stat") ? n.querySelector(".s-stat").textContent : null,
    })));

  // Dump for regenerating the golden (harmless once the golden is baked in).
  console.log("CHARACTERIZATION_GOLDEN=" + JSON.stringify(cards));

  expect(cards).toEqual(GOLDEN);
  expect(errors).toEqual([]);
});
