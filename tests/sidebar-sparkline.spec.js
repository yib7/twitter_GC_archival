const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// VC-14 / AN-4: the sidebar sparkline was insertAdjacentHTML'd into
// #sidebar-foot with no removal (so every timezone change added another one)
// while updateBrand() overwrote #sidebar-foot's innerHTML (so a group rename,
// photo change or import deleted it). The sparkline now has its own container
// that the builder replaces, and updateBrand() only writes the text line.
const MONTH = 30 * 86400000;
const A = msgs("a", 12, { t0: Date.parse("2023-01-15T12:00:00Z"), step: MONTH });   // Jan 2023 .. Dec 2023 -> 12 months
const B = msgs("b", 3, { t0: Date.parse("2024-06-01T12:00:00Z") });               // one month -> no sparkline
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B)] };
const sparks = (page) => page.locator("#sidebar-foot .spark");

test("VC-14: exactly one sidebar sparkline through timezone changes and a group rename", async ({ page }) => {
  await bootViewer(page, DATA);
  await expect(sparks(page)).toHaveCount(1);
  await expect(page.locator("#sidebar-foot")).toContainText("2 people");
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("America/New_York");
  await page.locator("#set-tz").selectOption("Europe/Paris");
  await expect(sparks(page)).toHaveCount(1);
  await page.locator(".gc-name-input").first().fill("Renamed");
  await page.locator(".gc-name-input").first().dispatchEvent("change");
  await expect(page.locator("#brand-title")).toHaveText("Renamed");
  await expect(sparks(page)).toHaveCount(1);
  await expect(page.locator("#sidebar-foot")).toContainText("2 people");
});

test("VC-14: switching to a conversation too short for a sparkline removes it", async ({ page }) => {
  await bootViewer(page, DATA);
  await expect(sparks(page)).toHaveCount(1);
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(sparks(page)).toHaveCount(0);
  await page.locator("#conv-select").selectOption("A");
  await expect(sparks(page)).toHaveCount(1);
});

test("VC-14: the sidebar year range follows a timezone change", async ({ page }) => {
  // 2023-01-01T02:00Z is still Dec 31 2022 in New York.
  const C = [...msgs("c", 1, { t0: Date.parse("2023-01-01T02:00:00Z") }), ...msgs("d", 3, { t0: Date.parse("2023-06-01T12:00:00Z"), step: MONTH })];
  await bootViewer(page, { conversations: [conv("C", "Gamma", C)] }, { ls: { "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#sidebar-foot")).toContainText("2023–2023");
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("America/New_York");
  await expect(page.locator("#sidebar-foot")).toContainText("2022–2023");
});
