const { test, expect } = require("@playwright/test");

// P2-1 regression guard: computeStats() used to compute ~21 superlative
// "winners" that no render path ever read; they were deleted as dead code.
// This spec freezes the *rendered* stats surface on the repo sample data
// (data.sample.js) so that deletion can never change what users see:
//   (a) the Stats view's "Superlatives & Fun Stats" grid renders exactly the
//       same 27 cards (count + every title, in order), and
//   (b) profile modals keep their badge and stat lines byte-identical.
// Captured from a pre-deletion run at HEAD 1d8080a; it must pass both before
// and after the dead-stat removal.

// Every card the sample data renders in the Superlatives grid, in DOM order.
const EXPECTED_CARD_TITLES = [
  "Late Night Owl", "Reaction Magnet", "Emoji Enthusiast", "Media Hog",
  "The Yapper", "The Caveman", "The Inquisitor", "The Narcissist",
  "The Giver", "Thread Starter", "Thread Killer", "The Double Texter",
  "Weekend Warrior", "The Work Slacker", "The Ghost", "The Ghoster",
  "The Flash", "The Scholar", "The Novelist", "The Early Bird",
  "Vampiric Owl", "The Deserter", "Crowd Pleaser", "The Ignored",
  "Gratitude King", "The Optimist", "The Zoomer",
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

  const titles = section.locator(".card .stat-lbl");
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

  // 1005 is the sample data's big winner: 8 of the 10 badge stats.
  await openProfile("1005");
  await expect(page.locator(".profile-modal .profile-badge")).toHaveText([
    "🦉\nLate Night Owl", "⭐\nReaction Magnet", "😂\nEmoji Enthusiast",
    "📷\nMedia Hog", "🤬\nThe Sailor", "💀\nThread Killer",
    "📚\nThe Scholar", "👏\nCrowd Pleaser",
  ]);
  await expect(page.locator(".profile-modal .profile-stat-val")).toHaveText(["18", "6.4", "77"]);
  await expect(page.locator(".profile-modal .profile-stat-lbl")).toHaveText(["Messages", "Words/Msg", "Vocab Size"], { ignoreCase: true });
  await closeProfile();

  // 1002 holds the remaining Yapper badge — a second, independent winner path.
  await openProfile("1002");
  await expect(page.locator(".profile-modal .profile-badge")).toHaveText(["🗣️\nThe Yapper"]);
  await expect(page.locator(".profile-modal .profile-stat-val")).toHaveText(["17", "9.5", "76"]);
  await closeProfile();

  expect(errors).toEqual([]);
});
