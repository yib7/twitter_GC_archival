require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// UX-25: a person's avatar colour in the setup wizard is the colour the
// viewer gives them (shared-core hueVars → the theme's --f-<hue>), in every
// theme. The viewer runs over the bundled sample archive; the wizard's /api
// routes are mocked with the same person id. Nothing real is touched.
const THEMES = ["light", "dim", "lightsout"];

async function colorsByTheme(page, selector) {
  const out = {};
  for (const t of THEMES) {
    out[t] = await page.evaluate(([sel, theme]) => {
      document.documentElement.setAttribute("data-theme", theme);
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : null;
    }, [selector, t]);
  }
  return out;
}

test("the same person has the same avatar colour in the viewer and the wizard", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("gca.onboarded", "1"); localStorage.removeItem("gca.lastView"); });
  await page.goto("/");
  // an initials avatar (no photo) of some person in the sample archive
  const av = page.locator('.msg .av[data-id]:not([style*="background-image"])').first();
  await expect(av).toBeVisible();
  const id = await av.getAttribute("data-id");
  const viewer = await colorsByTheme(page, '.msg .av[data-id="' + id + '"]:not([style*="background-image"])');

  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ totalMsgs: 5, groups: [{ id: "G1", title: "Grp", count: 5 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: [{ id, count: 5, samples: ["hello"], media: [] }] }) }));
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person .su-av")).toBeVisible();
  const wizard = await colorsByTheme(page, ".su-person .su-av");

  for (const t of THEMES) {
    expect(viewer[t], t).toMatch(/^rgb/);
    expect(wizard[t], t).toBe(viewer[t]);
  }
  // and it is the person's own hue (shared-core personHue), not the accent fallback
  const ref = await page.evaluate((pid) => {
    const probe = (bg) => { const d = document.createElement("div"); d.style.background = bg; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
    return { hue: probe("var(--f-" + window.GCAShared.personHue(pid) + ")"), accent: probe("var(--accent-fill)") };
  }, id);
  expect(wizard.lightsout).toBe(ref.hue);
  expect(wizard.lightsout).not.toBe(ref.accent);
});
