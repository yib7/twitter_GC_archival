require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { checkAndBuild, mockPreflight } = require("./_setup-helpers.js");
const { contrastFailures } = require("./_contrast.js");

// The setup wizard in every theme: each field has an accessible name (its
// visible label), and every visible text run reaches 4.5:1 (3:1 large) against
// what is really behind it (tests/_contrast.js), on each step and on the
// preview / merge notice. Server routes are mocked; nothing real is touched.
const THEMES = ["lightsout", "dim", "light"];
const GROUPS = [{ id: "G1", title: "Alpha", count: 100 }, { id: "G2", title: "Beta", count: 50 }];
const PARTS = [
  { id: "1111", count: 60, samples: ["alpha chatter here"], media: [] },
  { id: "2222", count: 40, samples: ["more alpha chatter"], media: [] },
];
const MERGE = {
  merge: { existingMsgs: 12, added: 3, newGroups: 1, keptGroups: 1, exportNewest: Date.UTC(2021, 6, 1), archiveNewest: Date.UTC(2021, 5, 1) },
  warnings: [{ code: "dm-skipped", text: "1 1:1 conversation (1 message) will be left out — only group chats are imported." }],
};

async function routes(page, { built = false } = {}) {
  await page.route("**/api/status", (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ built, groups: built ? GROUPS : [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ totalMsgs: 150, groups: GROUPS, mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
}

// Every visible field in the current pane is named (a <label for>, or aria).
async function unnamedFields(page) {
  const out = [];
  const fields = page.locator(".setup-pane.active input:not([type=hidden]):not([type=file]), .setup-pane.active select, .setup-pane.active textarea");
  for (let i = 0; i < await fields.count(); i++) {
    const f = fields.nth(i);
    if (!(await f.isVisible())) continue;
    const name = await f.evaluate((e) => {
      if (e.getAttribute("aria-label")) return e.getAttribute("aria-label");
      const lb = e.getAttribute("aria-labelledby");
      if (lb) return lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
      return [...(e.labels || [])].map((l) => l.textContent).join(" ");
    });
    if (!name.trim()) out.push(await f.evaluate((e) => e.id || e.className));
  }
  return out;
}

for (const th of THEMES) {
  test.describe(th, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((t) => { try { localStorage.setItem("gca.theme", t); } catch (e) { /* blocked */ } }, th);
    });

    test("source step and its preview: named fields, readable text", async ({ page }) => {
      await routes(page);
      await page.goto("/setup.html");
      await expect(page.locator('body[data-ready="1"]')).toBeAttached();
      expect(await unnamedFields(page)).toEqual([]);
      await page.locator("#src-group").fill("group.js");   // the filled-path tint is on too
      await page.locator("#src-headers").fill("headers.js");
      await page.locator("#src-media").fill("media");
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
      await mockPreflight(page);
      await page.locator("#btn-build").click();
      await expect(page.locator("#preflight")).toBeVisible();
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
    });

    test("adding a newer export: the merge notice and merge preview are readable", async ({ page }) => {
      await routes(page, { built: true });
      await page.goto("/setup.html");
      await expect(page.locator("#src-locked")).toBeVisible();
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
      await page.locator("#src-add").click();
      await expect(page.locator(".setup-merge")).toBeVisible();
      expect(await unnamedFields(page)).toEqual([]);
      await page.locator("#src-group").fill("group.js");
      await page.locator("#src-headers").fill("headers.js");
      await page.locator("#src-media").fill("media");
      await mockPreflight(page, MERGE);
      await page.locator("#btn-build").click();
      await expect(page.locator("#pf-title")).toHaveText("Add this export to your archive");
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
    });

    test("group, people and finish steps: named fields, readable text", async ({ page }) => {
      await routes(page);
      await page.goto("/setup.html");
      await page.locator("#src-group").fill("group.js");
      await page.locator("#src-headers").fill("headers.js");
      await page.locator("#src-media").fill("media");
      await checkAndBuild(page, { mock: true });
      await expect(page.locator('[data-pane="2"]')).toBeVisible();
      expect(await unnamedFields(page)).toEqual([]);
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
      await page.locator('[data-pane="2"] [data-next]').click();
      await expect(page.locator(".su-person")).toHaveCount(2);
      expect(await unnamedFields(page)).toEqual([]);
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
      await page.locator('[data-pane="3"] [data-next]').click();
      await expect(page.locator('[data-pane="4"]')).toBeVisible();
      expect(await contrastFailures(page, ".setup-shell")).toEqual([]);
    });

    // The two confirm dialogs sit outside the panes. Erase / Remove are
    // never pressed; their endpoints are mocked anyway.
    for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
      test("Start over and Remove dialogs: named field, readable text at " + vp.width, async ({ page }) => {
        await page.setViewportSize(vp);
        await routes(page);
        let erased = false;
        await page.route("**/api/reset", (route) => { erased = true; route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
        await page.route("**/api/removal-preview", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: 40, media: 0 }) }));
        await page.goto("/setup.html");
        await expect(page.locator('body[data-ready="1"]')).toBeAttached();
        await page.locator("#btn-reset").click();
        const reset = page.locator("#reset-modal");
        await expect(reset).toBeVisible();
        expect(await dialogUnnamedFields(page, "#reset-modal")).toEqual([]);
        await page.locator("#reset-confirm").fill("RESET");
        await expect(page.locator("#reset-go")).toBeEnabled();
        expect(await contrastFailures(page, "#reset-modal")).toEqual([]);
        await page.locator("#reset-go").hover();
        expect(await contrastFailures(page, "#reset-modal")).toEqual([]);
        await page.locator("#reset-cancel").click();
        await expect(reset).toBeHidden();
        // Remove: mark a person on step 3, then Save on step 4 asks first
        await page.locator("#src-group").fill("group.js");
        await page.locator("#src-headers").fill("headers.js");
        await page.locator("#src-media").fill("media");
        await checkAndBuild(page, { mock: true });
        await page.locator('[data-pane="2"] [data-next]').click();
        await page.locator(".su-person .su-remove").first().click();
        await page.locator('[data-pane="3"] [data-next]').click();
        await page.locator("#btn-save").click();
        const remove = page.locator("#remove-modal");
        await expect(remove).toBeVisible();
        await expect(page.locator("#remove-msg")).toContainText("40 messages");
        expect(await contrastFailures(page, "#remove-modal")).toEqual([]);
        await page.locator("#remove-cancel").click();
        await expect(remove).toBeHidden();
        expect(erased).toBe(false);
      });
    }
  });
}

// Every visible field inside a dialog is named.
async function dialogUnnamedFields(page, sel) {
  return page.locator(sel + " input, " + sel + " select, " + sel + " textarea").evaluateAll((els) => els.filter((e) => {
    const lb = e.getAttribute("aria-labelledby");
    const name = e.getAttribute("aria-label") ||
      (lb ? lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ") : [...(e.labels || [])].map((l) => l.textContent).join(" "));
    return !name.trim();
  }).map((e) => e.id || e.className));
}
