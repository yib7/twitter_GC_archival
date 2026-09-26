const { test, expect } = require("@playwright/test");

// UX-20 (SP3): the default zone is now the viewer's own ("local"). This spec's
// expected dates were written for UTC, so it pins the browser zone to UTC.
test.use({ timezoneId: "UTC" });

// P2-1 regression guard: computeStats() used to compute ~21 superlative
// "winners" that no render path ever read; they were deleted as dead code.
// This spec freezes the *rendered* stats surface on the repo sample data
// (data.sample.js) so that deletion can never change what users see:
//   (a) the Stats view's "Superlatives & Fun Stats" grid renders exactly the
//       same cards (count + every title, in order), and
//   (b) profile modals keep their badge and stat lines byte-identical.
// Captured from a pre-deletion run at HEAD 1d8080a; it must pass both before
// and after the dead-stat removal.
//
// Updated for P1-2 (fix(stats): compare reaction keys not emoji glyphs):
// "The Laugh Track" and "The Hater" now render too, since the sample
// generator guarantees funny/disagree reactions and the comparison bug that
// zeroed both counters (comparing r.k against emoji glyphs instead of the
// reaction key) is fixed. They land between "The Ignored" and "Gratitude
// King", matching the fixed render order in src/app.js.

// Every card the sample data renders in the Superlatives grid, in DOM order.
// SP4 (AN-3 / AN-7): rate / average awards need 20+ messages per person (the
// 64-message sample has none), all-tie cards are hidden, so the sample grid is
// down to the count-based awards until SP11 regenerates a bigger demo.
const EXPECTED_CARD_TITLES = [
  "Reaction Magnet", "Media Hog", "The Giver", "Thread Starter", "Thread Killer",
  "The Ghost", "The Ghoster", "The Flash", "The Novelist", "The Laugh Track", "The Hater",
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

test("stats view renders the full superlatives grid on sample data", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await page.goto("/");
  await page.locator('.nav-item[data-view="stats"]').click();

  const section = page.locator(".section", { hasText: "Superlatives & Fun Stats" });
  await expect(section).toBeVisible();

  const titles = section.locator(".card .s-title");
  await expect(titles).toHaveCount(EXPECTED_CARD_TITLES.length);
  await expect(titles).toHaveText(EXPECTED_CARD_TITLES);

  expect(errors).toEqual([]);
});

test("profile modal keeps its badges and stat lines on sample data", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await page.goto("/");

  const openProfile = async (id) => {
    const av = page.locator(`.av-clickable[data-id="${id}"]`).locator("visible=true").first();
    await av.click();
    await expect(page.locator(".profile-modal")).toBeVisible();
  };
  const closeProfile = async () => {
    await page.locator(".profile-card-close").click();
    await expect(page.locator(".profile-modal")).toHaveCount(0);
  };

  // AN-3: badges are exactly the grid cards 1005 wins (ties included). It used
  // to also get "The Sailor" (0 swear messages), "Late Night Owl" etc. from a
  // badge path that only checked the winner id, never the value.
  await openProfile("1005");
  await expect(page.locator(".profile-modal .profile-badge")).toHaveText([
    "⭐\nReaction Magnet", "📷\nMedia Hog", "🔚\nThread Killer",
  ]);
  await expect(page.locator(".profile-modal .profile-stat-val")).toHaveText(["18", "6.2", "76"]);
  await expect(page.locator(".profile-modal .profile-stat-lbl")).toHaveText(["Messages", "Words/Msg", "Vocab Size"], { ignoreCase: true });
  await closeProfile();

  // 1002 — a second, independent winner path.
  await openProfile("1002");
  await expect(page.locator(".profile-modal .profile-badge")).toHaveText(["⚡\nThe Flash", "📜\nThe Novelist"]);
  await expect(page.locator(".profile-modal .profile-stat-val")).toHaveText(["17", "9.1", "75"]);
  await closeProfile();

  expect(errors).toEqual([]);
});
