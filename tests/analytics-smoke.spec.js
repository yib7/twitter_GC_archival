const { test, expect } = require("@playwright/test");

// Smoke coverage for the six analytics views that previously had zero specs:
// Threads, Reply Chains, Word Battles, Wrapped, Hall of Fame, Time Capsule.
// Each test asserts (1) no pageerror while the view loads and (2) the view
// renders non-trivial content. Cheap and stable on purpose — not golden masters.
//
// data.sample.js only spans a single year (2024) and has no bursts dense
// enough to reliably feed every analytic, so a richer synthetic fixture is
// injected via the same route pattern the other specs use. It deterministically
// produces:
//   - two years (2023/2024) with different totals  → Wrapped year navigation
//   - a 12-msg u1↔u2 burst, 60s apart              → a Thread (8+) and a Reply
//     Chain (6+ volleys, gaps < 10 min)
//   - a 10-msg u1↔u3 burst in 2024                 → a second thread/chain
//   - reacted messages in both years               → Hall of Fame podium
//   - messages on today's month/day (UTC — the app's default timezone) in
//     2023 and 2024                                → Time Capsule sections
//   - battle-word-rich texts ("lmao", "bro", …)    → Word Battles rows

function makeData() {
  const msgs = [];
  let n = 0;
  const push = (s, t, x, r) => { msgs.push(Object.assign({ i: "m" + ++n, s, t, x }, r ? { r } : {})); };

  // 2023 burst: 12 alternating u1/u2 messages, one minute apart.
  let t = Date.parse("2023-03-05T18:00:00Z");
  for (let k = 0; k < 12; k++) {
    push(
      k % 2 ? "u2" : "u1",
      t,
      k % 2 ? "nah lmao that is honestly wild bro" : "yeah lol some wild stuff bro",
      k === 0 ? [{ k: "funny", s: "u2" }, { k: "like", s: "u3" }, { k: "excited", s: "u2" }] : undefined
    );
    t += 60000;
  }
  push("u3", Date.parse("2023-06-01T12:00:00Z"), "summer check in lmao", [{ k: "like", s: "u1" }]);

  // 2024 burst: 10 alternating u1/u3 messages, two minutes apart.
  t = Date.parse("2024-08-10T20:00:00Z");
  for (let k = 0; k < 10; k++) {
    push(
      k % 2 ? "u3" : "u1",
      t,
      k % 2 ? "bruh literally facts man" : "gonna say lmao again bro",
      k === 1 ? [{ k: "like", s: "u1" }, { k: "like", s: "u2" }] : undefined
    );
    t += 120000;
  }

  // Time Capsule: one message on today's UTC month/day in each past year.
  // Date.UTC rolls invalid days over (Feb 29 → Mar 1 in non-leap 2023), in
  // which case that one message just misses the capsule — 2023 and 2024
  // (a leap year) can never both roll over, so the view always has content.
  const now = new Date();
  push("u2", Date.UTC(2023, now.getUTCMonth(), now.getUTCDate(), 12), "capsule memory from twenty three");
  push("u1", Date.UTC(2024, now.getUTCMonth(), now.getUTCDate(), 12), "capsule memory from twenty four");

  msgs.sort((a, b) => a.t - b.t);
  return {
    __sample: true,
    conversations: [
      { id: "A", type: "group", title: "Analytics Fixture", participants: ["u1", "u2", "u3"], count: msgs.length, msgs, events: [] },
    ],
  };
}

const DATA = makeData();

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function openView(page, view) {
  await page.goto("/");
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await expect(page.locator(`#view-${view}`)).toBeVisible();
}

test("threads view renders detected activity bursts", async ({ page }) => {
  await openView(page, "threads");
  await expect(page.locator("#view-threads .page-title")).toContainText("Threads");
  // Both bursts qualify (8+ msgs, 1h gaps) — at least two cards render.
  expect(await page.locator("#thr-grid .thr-card").count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#thr-grid .thr-card").first()).toContainText("msgs");
  // Year filter chips exist for both fixture years plus "All".
  expect(await page.locator(".thr-yr").count()).toBeGreaterThanOrEqual(3);
});

test("reply chains view renders back-and-forth exchanges", async ({ page }) => {
  await openView(page, "chains");
  await expect(page.locator("#view-chains .page-title")).toContainText("Reply Chains");
  // The alternating bursts are 6+ volleys with <10 min gaps — chains render.
  expect(await page.locator(".chain-list .chain-card").count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".chain-card").first()).toContainText("exchanges");
});

test("word battles renders default rows and a driven custom battle", async ({ page }) => {
  await openView(page, "battles");
  await expect(page.locator("#view-battles .page-title")).toContainText("Word Battles");

  // Pick the two burst participants explicitly.
  await page.locator("#battle-p1").selectOption("u1");
  await page.locator("#battle-p2").selectOption("u2");

  // Default battle rows: fixture texts contain "lmao"/"bro"/"nah" etc.
  expect(await page.locator("#battle-results .battle-row").count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".battle-summary")).toContainText("wins");

  // Drive a custom battle: both people say "wild" in the 2023 burst.
  await page.locator("#battle-word").fill("wild");
  await page.locator("#battle-go").click();
  const added = page.locator(".battle-row.battle-added");
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("wild");
  // Both sides counted at least one usage.
  const counts = await added.locator(".battle-count").allInnerTexts();
  expect(counts.some((c) => parseInt(c, 10) >= 1)).toBe(true);
});

test("wrapped renders and navigating years changes the label and stats", async ({ page }) => {
  await openView(page, "wrapped");
  await expect(page.locator("#view-wrapped .page-title")).toContainText("Wrapped");

  // Fixture spans exactly 2023 and 2024; default is the latest year.
  await expect(page.locator(".wr-yr")).toHaveCount(2);
  await expect(page.locator("#wr-stage .wr-big")).toHaveText("2024");

  // Slide 2 is the message-count stat for the year. The visible text counts up
  // (SP3 story mode), so assert on the raw data-count target instead.
  await page.locator("#wr-next").click();
  await expect(page.locator("#wr-stage .wr-label")).toContainText("messages sent in 2024");
  const stat2024 = await page.locator("#wr-stage .wr-big").getAttribute("data-count");

  // Switch year: label resets to the intro of 2023, then the stat differs.
  await page.locator('.wr-yr[data-yr="2023"]').click();
  await expect(page.locator("#wr-stage .wr-big")).toHaveText("2023");
  await page.locator("#wr-next").click();
  await expect(page.locator("#wr-stage .wr-label")).toContainText("messages sent in 2023");
  const stat2023 = await page.locator("#wr-stage .wr-big").getAttribute("data-count");
  expect(stat2023).not.toEqual(stat2024);
});

test("hall of fame renders podium and ranked reacted messages", async ({ page }) => {
  await openView(page, "hof");
  await expect(page.locator("#view-hof .page-title")).toContainText("Hall of Fame");
  // Three reacted messages in the fixture → a full podium.
  await expect(page.locator("#hof-podium .hof-card")).toHaveCount(3);
  // Top card is the 3-reaction 2023 burst opener.
  await expect(page.locator("#hof-podium .hof-card.rank-1")).toContainText("3 reactions");
  expect(await page.locator("#hof-list .msg").count()).toBeGreaterThanOrEqual(1);
  // Year chips: "All time" + each year that has reacted messages.
  expect(await page.locator(".hof-yr").count()).toBeGreaterThanOrEqual(3);
});

test("time capsule renders on-this-day sections from past years", async ({ page }) => {
  await openView(page, "capsule");
  await expect(page.locator("#view-capsule .page-title")).toContainText("Time Capsule");
  // The fixture plants messages on today's UTC date in 2023 and 2024, so at
  // least one "N years ago today" section renders (both, except a Feb 29
  // "today" where the 2023 message rolls over to Mar 1 and is skipped).
  expect(await page.locator("#capsule-body .section-h").count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#capsule-body .section-h").first()).toContainText(/ago today/);
  expect(await page.locator("#capsule-body .msg").count()).toBeGreaterThanOrEqual(1);
});
