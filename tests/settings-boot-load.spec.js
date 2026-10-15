const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

const DATA = { conversations: [conv("A", "Alpha", msgs("m", 12))] };

// Found while restructuring loadSettings: PFPS_KEY / GC_KEY were declared
// with `const` BELOW the top-level `let settings = loadSettings()`, so at boot
// loadPfps()/loadGc() hit a temporal-dead-zone ReferenceError (swallowed by
// their own try/catch) and silently fell back to {} — every photo uploaded in
// the People tab and every in-app group rename vanished on reload.
test("persisted photos (gca.pfps) and group names (gca.gc) are loaded at boot", async ({ page }) => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await bootViewer(page, DATA, { ls: {
    "gca.pfps": JSON.stringify({ u1: PNG }),
    "gca.gc": JSON.stringify({ A: { name: "Renamed Alpha" } }),
  } });
  await expect(page.locator("#brand-title")).toHaveText("Renamed Alpha");
  const bg = await page.locator('#s-list .msg .av[data-id="u1"]').first().evaluate((n) => n.style.backgroundImage);
  expect(bg).toContain("data:image/png");
});
