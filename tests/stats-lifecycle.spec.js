const { test, expect } = require("@playwright/test");

// P2-2: renderStats() used to create three untracked `new Chart(...)` instances
// (#chart-months, #chart-hours, #chart-weekdays) on every render and only ever
// destroyed trendChart — so each Stats re-render (view revisit, conversation
// switch) leaked 3 live Chart.js instances holding detached canvases. The
// vendored Chart.js v4 build keeps a static `Chart.instances` registry (object
// keyed by chart id; construction adds, destroy() deletes), which lets us count
// live instances from page context.
//
// P1-2: openProfileModal() used to run the full computeStats() sweep
// synchronously before painting anything. It now paints the shell first and
// fills stats/badges from computeStats() asynchronously when STATS is cold —
// the cold-open test pins that the final modal content is unchanged.

const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1", "u2"], count: 4,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-01-01T10:00:00Z"), x: "good morning alpha crew" },
        { i: "a2", s: "u2", t: Date.parse("2024-01-01T10:05:00Z"), x: "lol thanks for the reminder" },
        { i: "a3", s: "u1", t: Date.parse("2024-01-02T22:00:00Z"), x: "did anyone see this? 😂", r: [{ s: "u2", k: "😂" }] },
        { i: "a4", s: "u2", t: Date.parse("2024-01-03T09:00:00Z"), x: "great stuff honestly" },
      ], events: [] },
    { id: "B", type: "group", title: "Beta", participants: ["u3"], count: 2,
      msgs: [
        { i: "b1", s: "u3", t: Date.parse("2024-02-01T10:00:00Z"), x: "beta says hello" },
        { i: "b2", s: "u3", t: Date.parse("2024-02-02T11:00:00Z"), x: "beta says goodbye!" },
      ], events: [] },
  ],
};

async function bootInjected(page, savedConv) {
  await page.addInitScript((saved) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    if (saved) localStorage.setItem("gca.conv", saved);
  }, savedConv);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

// Live (constructed, not-yet-destroyed) Chart.js instances in the page.
function liveChartCount(page) {
  return page.evaluate(() => {
    const inst = window.Chart.instances;
    return (inst instanceof Map) ? inst.size : Object.keys(inst).length;
  });
}

// Instances whose canvas is no longer in the document — leaked charts.
function detachedChartCount(page) {
  return page.evaluate(() => {
    const inst = window.Chart.instances;
    const charts = (inst instanceof Map) ? [...inst.values()] : Object.values(inst);
    return charts.filter((c) => !c.canvas || !c.canvas.isConnected).length;
  });
}

async function visitStats(page) {
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#chart-months")).toBeVisible();
  // trendChart is created by updateTrendChart("lol") at the end of renderStats.
  await expect(page.locator("#chart-trends")).toBeVisible();
}

test("stats charts don't leak across re-renders and follow the current canvases", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await bootInjected(page, "A");
  await visitStats(page);

  // First render: months + hours + weekdays + trend = exactly 4 live charts.
  expect(await liveChartCount(page)).toBe(4);

  // Re-render Stats 4 more times: conversation A → B → A, then a view
  // round-trip (timeline → stats) twice. Each renderStats() must destroy the
  // previous render's charts, not abandon them.
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator("#chart-months")).toBeVisible();

  await page.locator("#conv-select").selectOption("A");
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  await expect(page.locator("#chart-months")).toBeVisible();

  for (let i = 0; i < 2; i++) {
    await page.locator('.nav-item[data-view="timeline"]').click();
    await visitStats(page);
  }

  // Bounded: still exactly the 4 charts of the LAST render — not 4 + 3·N.
  expect(await liveChartCount(page)).toBe(4);
  expect(await detachedChartCount(page)).toBe(0);

  // And they are bound to the canvases currently in the DOM.
  for (const id of ["chart-months", "chart-hours", "chart-weekdays", "chart-trends"]) {
    expect(await page.evaluate(
      (cid) => !!window.Chart.getChart(document.getElementById(cid)), id,
    )).toBe(true);
  }

  expect(errors).toEqual([]);
});

test("profile modal cold-open (avatar click before ever visiting Stats) renders full stats + badges", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  // Real repo sample data — expected values mirror stats-superlatives-guard.
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");

  // STATS is cold: click an avatar straight from the default view.
  await page.locator('.av-clickable[data-id="1005"]').locator("visible=true").first().click();
  await expect(page.locator(".profile-modal")).toBeVisible();

  // Content must end up equivalent to the old synchronous render.
  await expect(page.locator(".profile-modal .profile-stat-val")).toHaveText(["18", "6.4", "77"]);
  await expect(page.locator(".profile-modal .profile-stat-lbl")).toHaveText(
    ["Messages", "Words/Msg", "Vocab Size"], { ignoreCase: true });
  await expect(page.locator(".profile-modal .profile-badge")).toHaveText([
    "🦉\nLate Night Owl", "⭐\nReaction Magnet", "😂\nEmoji Enthusiast",
    "📷\nMedia Hog", "🤬\nThe Sailor", "💀\nThread Killer",
    "📚\nThe Scholar", "👏\nCrowd Pleaser",
  ]);

  await page.locator(".profile-card-close").click();
  await expect(page.locator(".profile-modal")).toHaveCount(0);

  // The STATS the modal warmed (or will compute) must leave the Stats view
  // rendering its full pinned surface afterwards.
  await page.locator('.nav-item[data-view="stats"]').click();
  const section = page.locator(".section", { hasText: "Superlatives & Fun Stats" });
  await expect(section).toBeVisible();
  await expect(section.locator(".card .s-title")).toHaveCount(27);

  expect(errors).toEqual([]);
});
