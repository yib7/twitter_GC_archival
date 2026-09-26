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

// SP4 (AN-3 / AN-7): superlatives were redefined — rates per 100 messages with
// a minimum sample (MIN_MSGS = 20 messages), median reply times, tie / all-tie
// rules and a definition line. The 64-message sample gives nobody 20 messages,
// so every rate / average card is hidden until SP11 regenerates a bigger demo;
// the golden now also pins the "tied with" line.
const GOLDEN = [
  { name: "User 1", tie: "", title: "Reaction Magnet", stat: "10 reactions received" },
  { name: "User 1", tie: "tied with User 3", title: "Media Hog", stat: "2 files shared" },
  { name: "User 4", tie: "", title: "The Giver", stat: "10 reactions given" },
  { name: "User 4", tie: "", title: "Thread Starter", stat: "2 days started" },
  { name: "User 1", tie: "tied with User 3, User 5", title: "Thread Killer", stat: "1 day ended" },
  { name: "User 5", tie: "", title: "The Ghost", stat: "Only 7 messages total" },
  { name: "User 4", tie: "", title: "The Ghoster", stat: "1.1h median reply" },
  { name: "User 2", tie: "", title: "The Flash", stat: "19.0m median reply" },
  { name: "User 2", tie: "", title: "The Novelist", stat: "84 characters (longest msg)" },
  { name: "User 3", tie: "", title: "The Laugh Track", stat: "2 laughing reactions given" },
  { name: "User 4", tie: "", title: "The Hater", stat: "4 👎/😡 reactions given" },
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
      tie: n.querySelector(".s-tie") ? n.querySelector(".s-tie").textContent : "",
      title: n.querySelector(".s-title") ? n.querySelector(".s-title").textContent : null,
      stat: n.querySelector(".s-stat") ? n.querySelector(".s-stat").textContent : null,
    })));

  // Dump for regenerating the golden (harmless once the golden is baked in).
  console.log("CHARACTERIZATION_GOLDEN=" + JSON.stringify(cards));

  expect(cards).toEqual(GOLDEN);
  expect(errors).toEqual([]);
});
