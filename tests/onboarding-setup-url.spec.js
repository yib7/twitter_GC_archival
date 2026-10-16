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
  // served, the server is already running: no "start the server" instructions
  await expect(page.locator(".onboard-note")).toContainText("runs on this server");
  await expect(page.locator(".onboard-note")).not.toContainText("node scripts/server.js");
  await expect(page.locator(".onboard-note")).not.toContainText("npm start");
  await expect(page.locator(".onboard-note")).not.toContainText("start-setup");
});

// The wizard page lives in src/ and works only through the server, at
// /setup.html. Served, the button opens it on this server. Opened from
// file://, there is probably no server running, so the button opens
// src/setup.html from disk, which shows only how to start the server (never a
// "This site can't be reached" page).
test("the onboarding button opens /setup.html when served", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.onboarded": "0" } });
  const btn = page.locator(".onboard a.btn.primary");
  await expect(btn).toHaveAttribute("href", "setup.html");
  expect(await btn.evaluate((a) => new URL(a.href).pathname)).toBe("/setup.html");
});

test("from file:// the onboarding button opens the start-the-server note", async ({ page }) => {
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  await page.goto(pathToFileURL(path.join(__dirname, "..", "index.html")).href);
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample)).toBe(true);
  // the note leads with the double-click launchers, like the README and the
  // start-the-server page, and names npm start (not node scripts/server.js)
  const note = page.locator(".onboard-note");
  await expect(note).toContainText("start-setup.cmd");
  await expect(note).toContainText("start-setup.command");
  // the .command launcher runs on macOS and Linux, and the card says so
  await expect(note).toContainText("(macOS/Linux)");
  await expect(note).toContainText("npm start");
  await expect(note).not.toContainText("node scripts/server.js");
  const btn = page.locator(".onboard a.btn.primary");
  const target = pathToFileURL(path.join(__dirname, "..", "src", "setup.html")).href;
  expect(await btn.evaluate((a) => a.href)).toBe(target);
  await btn.click();
  await expect(page).toHaveURL(target);
  await expect(page.locator(".su-unserved")).toBeVisible();
  await expect(page.locator(".su-unserved")).toContainText("(macOS/Linux)");
  await expect(page.locator(".setup-shell")).toBeHidden();
});
