const { test, expect } = require("@playwright/test");

// the default zone is now the viewer's own ("local"). This spec's
// expected dates were written for UTC, so it pins the browser zone to UTC.
test.use({ timezoneId: "UTC" });

// Characterization pin (behavior-preserving refactor of computeStats'
// superlative winners into a data table + derive loop).
//
// This freezes the ENTIRE rendered Superlatives grid on the repo sample data
// (sample/data.sample.js): for every ".card.super", the winner name (.s-name), the
// title (.s-title), and the full stat text (.s-stat), in DOM order. Where the
// sibling stats-superlatives-guard.spec.js only pins the card *titles* and the
// profile badges, this pins the winner *identity* and the exact desc string per
// card — so any drift in which person wins, or in how a value is formatted, is
// caught. The golden below was captured from the pre-refactor code and must
// pass byte-identically before and after the refactor.

// Superlatives are rates per 100 messages with a minimum sample (20 messages
// per person), median reply times, and tie / all-tie rules. The demo sample
// spans ~18 months with 130-360 messages per chat, so every award that has a
// clear winner renders; the golden also pins the "tied with" line (The Flash
// and Emoji Enthusiast). The reaction cards follow the sample's rule of one
// reaction per person per message, as in a real export.
const GOLDEN = [
  { name: "User 4", tie: "", title: "Late Night Owl", stat: "1.5% of msgs 12–5 AM" },
  { name: "User 1", tie: "", title: "Reaction Magnet", stat: "45 reactions received" },
  { name: "User 3", tie: "tied with User 4", title: "Emoji Enthusiast", stat: "38.2 emoji / 100 msgs" },
  { name: "User 2", tie: "", title: "Media Hog", stat: "8 files shared" },
  { name: "User 5", tie: "", title: "The Yapper", stat: "6.2 words / msg" },
  { name: "User 4", tie: "", title: "The Caveman", stat: "4.7 words / msg" },
  { name: "User 1", tie: "", title: "The Inquisitor", stat: "8.4% of msgs ask" },
  { name: "User 5", tie: "", title: "The Narcissist", stat: "10.6 \"I/me/my\" / 100 msgs" },
  { name: "User 4", tie: "", title: "The LMAO User", stat: "16.2 laughs / 100 msgs" },
  { name: "User 3", tie: "", title: "The Giver", stat: "35 reactions given" },
  { name: "User 2", tie: "", title: "The Link Spammer", stat: "1 link shared" },
  { name: "User 4", tie: "", title: "Thread Starter", stat: "16 days started" },
  { name: "User 2", tie: "", title: "Thread Killer", stat: "20 days ended" },
  { name: "User 3", tie: "", title: "The Double Texter", stat: "22.1 double texts / 100 msgs" },
  { name: "User 2", tie: "", title: "Weekend Warrior", stat: "33% of msgs on weekends" },
  { name: "User 5", tie: "", title: "The Work Slacker", stat: "39% of msgs 9–5 weekdays" },
  { name: "User 5", tie: "", title: "The Ghost", stat: "Only 66 messages total" },
  { name: "User 4", tie: "", title: "The Ghoster", stat: "9.0m median reply" },
  { name: "User 2", tie: "tied with User 5", title: "The Flash", stat: "7.0m median reply" },
  { name: "User 3", tie: "", title: "The Scholar", stat: "141 different words in first 250" },
  { name: "User 2", tie: "", title: "The Deserter", stat: "29 messages from others over 48 days without a word" },
  { name: "User 5", tie: "", title: "The Monologuer", stat: "1.5 runs of 5+ / 100 msgs" },
  { name: "User 1", tie: "", title: "Crowd Pleaser", stat: "0.54 reactions / msg" },
  { name: "User 2", tie: "", title: "The Ignored", stat: "80% of msgs got no reaction" },
  { name: "User 2", tie: "", title: "The Laugh Track", stat: "6 laughing reactions given" },
  { name: "User 3", tie: "", title: "The Hater", stat: "10 👎/😡 reactions given" },
  { name: "User 3", tie: "", title: "Gratitude King", stat: "4.4 thank-yous / 100 msgs" },
  { name: "User 4", tie: "", title: "The Laughing Void", stat: "4.4% of msgs only laughter" },
  { name: "User 2", tie: "", title: "The Exclaimer", stat: "13.3 “!” / 100 msgs" },
  { name: "User 2", tie: "", title: "The Optimist", stat: "14.7 positive words / 100 msgs" },
  { name: "User 1", tie: "", title: "The Zoomer", stat: "7.2 slang words / 100 msgs" },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  // Let the repo's real sample/data.sample.js load; keep data.js / local.js inert.
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
      tie: n.querySelector(".s-tie") ? n.querySelector(".s-tie").textContent : "",
      title: n.querySelector(".s-title") ? n.querySelector(".s-title").textContent : null,
      stat: n.querySelector(".s-stat") ? n.querySelector(".s-stat").textContent : null,
    })));

  // Dump for regenerating the golden (harmless once the golden is baked in).
  console.log("CHARACTERIZATION_GOLDEN=" + JSON.stringify(cards));

  expect(cards).toEqual(GOLDEN);
  expect(errors).toEqual([]);
});
