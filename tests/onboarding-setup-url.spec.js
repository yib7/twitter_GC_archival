const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs } = require("./_viewer-fixture.js");

// The first-run card tells the user where the setup wizard is. When the
// local server serves the page it injects its real address, which the card
// must show (the e2e server runs on a non-default port). Synthetic data only.
const DATA = { conversations: [conv("A", "Alpha", msgs("a", 3))] };

test("the onboarding card names the server's real setup address", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.onboarded": "0" } });
  await expect(page.locator(".onboard")).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(await page.evaluate(() => window.GCA_SERVER_URL)).toBe(origin);
  await expect(page.locator("#setup-url-note")).toHaveText(origin + "/setup.html");
});
