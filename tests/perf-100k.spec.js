const { test, expect } = require("@playwright/test");
const { archiveScript } = require("./fixtures/synthetic-archive.js");

// SP3 (UX-4 / AN-13 / VC-18): hard performance budgets on a deterministic
// ~100k-message SYNTHETIC archive (tests/fixtures/synthetic-archive.js — never
// real data). The archive is generated inside the page, so the spec stays well
// under ~20 s and ships no 20 MB fixture.
//
// Budgets (ms of main-thread time, measured at 1x CPU on the dev machine):
//   Stats first render, COLD ....... < 400   (was ~1200) — the first Stats
//     paint after boot PLUS a from-scratch time-index build with a fresh zone
//     clock (the sidebar sparkline builds the index at boot, so the paint alone
//     would hide that cost); asserted on that single cold sample, never on a
//     best-of that includes warm samples
//   convo switch with Stats open ... < 400   (was ~1190)
//   Wrapped first render ........... < 400   (was ~440)
//   Time Capsule ................... < 400   (was ~270)
//   fuzzy keystroke (typo query) ... < 120   (was 160-620)
//   exact keystroke ................ < 120
//   "Show close matches" (forced) .. < 400   (a deliberate click, not a keystroke)
//
// CI robustness: shared CI runners are slower and noisier than a dev box, so
// every budget is multiplied by GCA_PERF_MULT (default 1 locally, 2 when
// process.env.CI is set — at 2 the Stats budgets, 800 ms, are still well under
// the pre-SP3 ~1200 ms, so a full revert fails on CI too).
//
// Machine-independent check: the two Stats metrics are ALSO held to a ratio
// against an in-page yardstick (R.calib: 20k Intl formatToParts calls in
// America/New_York, best of 3 — the per-message work pre-SP3 Stats did many
// times over). Both sides slow down together on a slower runner, so the ratio
// needs no multiplier. On the dev box calib is ~29 ms: SP3 Stats sits at ~4x
// calib, pre-SP3 Stats measured 31-34x, the limit is 14x.
// GCA_PERF_CPU_THROTTLE=<n> slows the page's CPU n-fold (CDP) to rehearse a
// slow runner locally. Each metric is the BEST of a few runs where the
// action can be repeated cold, so a neighbouring worker stealing the CPU for
// one sample doesn't fail the run. Budgets are asserted on the measured value;
// every sample is also attached to the test report (perf-100k.json).
//
// Tagged @perf: `npx playwright test --grep @perf` runs just this;
// `--grep-invert @perf` skips it.
const MULT = Number(process.env.GCA_PERF_MULT) || (process.env.CI ? 2 : 1);
const RATIO = { statsCold: 14, convSwitchStats: 14 };
const THROTTLE = Number(process.env.GCA_PERF_CPU_THROTTLE) || 1;
const BUDGET = { statsFirst: 400, convSwitchStats: 400, wrappedFirst: 400, capsule: 400, fuzzyKey: 120, exactKey: 120, forcedFuzzy: 400 };
const BIG = "910000000000000001", SIDE = "910000000000000002";

test.use({ timezoneId: "America/New_York" });

async function boot(page, settings) {
  await page.addInitScript((s) => {
    try {
      if (sessionStorage.getItem("__perf_seeded")) return;
      sessionStorage.setItem("__perf_seeded", "1");
      localStorage.clear();
      localStorage.setItem("gca.onboarded", "1");
      localStorage.setItem("gca.conv", "910000000000000001");
      localStorage.setItem("gca.lastView", "timeline");
      if (s) localStorage.setItem("gca.settings", JSON.stringify(s));
    } catch (e) { /* storage blocked */ }
    window.__lt = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: "longtask", buffered: true });
    } catch (e) { /* no longtask support */ }
  }, settings || null);
  await page.route("**/data.sample.js", (r) => r.fulfill({ contentType: "text/javascript", body: archiveScript({ main: 100000, side: 20000 }) }));
  await page.route("**/data.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample === true)).toBe(true);
  expect(await page.evaluate(() => window.CHAT_DATA.conversations[0].msgs.length)).toBe(100000);
}

// Run `js` (a statement string) in the page and return the main-thread time
// until the next frame has been produced (2 rAFs) — i.e. what the user waits.
function timed(page, js) {
  return page.evaluate(async (code) => {
    const t0 = performance.now();
    (0, eval)(code);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  }, js);
}
const nav = (v) => `document.querySelector('.nav-item[data-view="${v}"]').click()`;
const pickConv = (id) => `(function(){var s=document.getElementById("conv-select");s.value="${id}";s.dispatchEvent(new Event("change"));})()`;

// One debounced search keystroke: the time from the debounce timer firing to
// the result list being written (#s-meta's data-gen bump), i.e. the work the
// keystroke costs, excluding the fixed 150 ms debounce wait itself. A marker
// timer with the same delay is registered just BEFORE the input event so it
// fires immediately before the app's own debounce timer.
function keystroke(page, q) {
  return page.evaluate(async (query) => {
    const inp = document.getElementById("s-input"), meta = document.getElementById("s-meta");
    const gen0 = meta.dataset.gen;
    let tStart = 0, tDone = 0;
    const mo = new MutationObserver(() => { if (!tDone && meta.dataset.gen !== gen0) tDone = performance.now(); });
    mo.observe(meta, { attributes: true, attributeFilter: ["data-gen"] });
    setTimeout(() => { tStart = performance.now(); }, 150);
    inp.value = query; inp.dispatchEvent(new Event("input", { bubbles: true }));
    const t0 = performance.now();
    while (!tDone && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 5));
    mo.disconnect();
    return { ms: Math.round(tDone - tStart), meta: meta.textContent.slice(0, 90) };
  }, q);
}

test("@perf 100k synthetic archive stays inside the SP3 budgets", async ({ page }, testInfo) => {
  test.setTimeout(90 * 1000);
  // A named DST zone is the slowest path (no native fast path), so it is the
  // one the budgets are held to.
  await boot(page, { timezone: "America/New_York", tzExplicit: true });
  if (THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }
  const R = { mult: MULT, throttle: THROTTLE };
  // Machine-speed yardstick (see RATIO above), best of 3.
  R.calib = await page.evaluate(() => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    let bestMs = Infinity, sink = 0;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      for (let k = 0; k < 20000; k++) sink += f.formatToParts(1546300800000 + k * 3607001).length;
      bestMs = Math.min(bestMs, performance.now() - t0);
    }
    return sink > 0 ? Math.round(bestMs * 10) / 10 : 0;
  });
  const best = (arr) => Math.min(...arr);

  // --- Stats first render (cold caches) -------------------------------------
  R.statsFirst = [await timed(page, nav("stats"))];
  await expect(page.locator("#view-stats .h-num")).toBeVisible();
  // The index + zone-clock work the sidebar already did at boot, redone from
  // scratch (fresh clock, no memo): added to the paint for the COLD figure.
  R.indexCold = await page.evaluate(() => {
    const msgs = window.CHAT_DATA.conversations[0].msgs;
    const t0 = performance.now();
    window.GCAShared.buildTimeIndex(msgs, window.GCAShared.createZoneClock("America/New_York"));
    return Math.round(performance.now() - t0);
  });
  R.statsCold = R.statsFirst[0] + R.indexCold;
  // --- Conversation switch with Stats open (cold compute each time) ---------
  R.convSwitchStats = [];
  for (let k = 0; k < 3; k++) {
    await timed(page, pickConv(SIDE));
    R.convSwitchStats.push(await timed(page, pickConv(BIG)));
    await expect(page.locator("#view-stats .h-num")).toHaveAttribute("data-count", "100000");
  }
  // (These switch samples re-render Stats with a rebuilt index but a warm zone
  // clock, so they are their own metric — not "first render" samples.)

  // --- Wrapped / Capsule (cold; the conversation switch reset their caches) --
  await timed(page, pickConv(SIDE));
  await timed(page, nav("timeline"));
  await timed(page, pickConv(BIG));
  R.wrappedFirst = [await timed(page, nav("wrapped"))];
  await expect(page.locator("#wr-slide")).toBeVisible();
  R.capsule = [await timed(page, nav("capsule")), await timed(page, nav("capsule"))];
  await expect(page.locator("#capsule-body")).toBeVisible();

  // --- Search keystrokes ------------------------------------------------------
  await timed(page, nav("search"));
  await expect(page.locator("#s-input")).toBeVisible();
  // Fuzzy mode (the default). Typo'd / no-literal-hit queries take the fuzzy path.
  R.fuzzyKey = [];
  R.fuzzyMeta = [];
  for (const q of ["hilarous", "movie nite", "the quick brown fox", "hilarious"]) {
    const k = await keystroke(page, q);
    R.fuzzyKey.push(k.ms); R.fuzzyMeta.push(k.meta);
  }
  // Forced fuzzy (VC-18): "hilarious" has exact hits, so it is exact-first;
  // "+ Show close matches" then ranks the whole archive by similarity — the
  // most expensive search path. Timed from the click to the next frame.
  await expect(page.locator("#s-fuzzy-toggle")).toContainText("Show close matches");
  R.forcedFuzzy = [await timed(page, 'document.getElementById("s-fuzzy-toggle").click()')];
  await expect(page.locator("#s-fuzzy-toggle")).toContainText("Exact matches only");
  await expect(page.locator("#s-meta")).toContainText("incl. close matches");
  // Exact mode.
  await page.locator('#f-matchtoggle [data-mode="exact"]').click();
  R.exactKey = [];
  for (const q of ["movie night", "the", "hilarious"]) R.exactKey.push((await keystroke(page, q)).ms);

  R.longTasks = await page.evaluate(() => window.__lt.map(Math.round));
  await testInfo.attach("perf-100k.json", { body: JSON.stringify(R, null, 1), contentType: "application/json" });
  console.log("[perf-100k]", JSON.stringify(R));

  // Every typo'd fuzzy query still finds something (the fallback is real).
  expect(R.fuzzyMeta[0]).toMatch(/[1-9][\d,]* /);

  expect.soft(R.statsCold, "Stats first render, cold (paint + index build)").toBeLessThan(BUDGET.statsFirst * MULT);
  expect.soft(best(R.convSwitchStats), "convo switch with Stats open").toBeLessThan(BUDGET.convSwitchStats * MULT);
  expect(R.calib, "calibration ran").toBeGreaterThan(0);
  expect.soft(R.statsCold / R.calib, "Stats cold / calib").toBeLessThan(RATIO.statsCold);
  expect.soft(best(R.convSwitchStats) / R.calib, "convo switch / calib").toBeLessThan(RATIO.convSwitchStats);
  expect.soft(best(R.wrappedFirst), "Wrapped first render").toBeLessThan(BUDGET.wrappedFirst * MULT);
  expect.soft(best(R.capsule), "Time Capsule").toBeLessThan(BUDGET.capsule * MULT);
  // Keystrokes are each a distinct query, so every one must fit, not the best.
  expect.soft(Math.max(...R.fuzzyKey), "fuzzy keystroke (worst query)").toBeLessThan(BUDGET.fuzzyKey * MULT);
  expect.soft(Math.max(...R.exactKey), "exact keystroke (worst query)").toBeLessThan(BUDGET.exactKey * MULT);
  expect.soft(best(R.forcedFuzzy), "forced fuzzy (Show close matches)").toBeLessThan(BUDGET.forcedFuzzy * MULT);
});
