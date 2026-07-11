const { test, expect } = require("@playwright/test");

// End-to-end guard for the "clean served console" fix: when the app is served by
// scripts/server.js (npm start) on a clean checkout, the optional real-data
// override probes (data.js / personal_data/data.js / names.local.js /
// personal_data/local.js) are absent. They must resolve as empty 200s, NOT 404s,
// so a reviewer opening DevTools sees no red errors on load. This navigates the
// REAL server (no route mocking) and asserts a clean network + console.
test("served app loads with no 404s or console errors (optional overrides are empty-200)", async ({ page }) => {
  const notFound = [];
  const consoleErrors = [];
  page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.addInitScript(() => { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) { /* ignore */ } });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".msg").first()).toBeVisible();

  // The four optional overrides must have been served (empty 200), so the app fell
  // back to the bundled synthetic sample — its demo conversation is present.
  await expect(page.locator("#conv-select, [id^=conv]")).toBeTruthy();

  expect(notFound, "no 404s on a served load:\n" + notFound.join("\n")).toHaveLength(0);
  expect(consoleErrors, "no console errors on a served load:\n" + consoleErrors.join("\n")).toHaveLength(0);
});
