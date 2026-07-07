const { test, expect } = require("@playwright/test");

// P1-3 (+P2-7): Import Settings assigns settings.pfps/settings.gc verbatim from
// an arbitrary JSON file, then pfpHtml() interpolates that value into a raw
// HTML string as an unescaped style="...url('...')" attribute. A crafted pfp
// value can close the attribute and inject markup/handlers straight into the
// DOM the moment any pfpHtml() call site renders (e.g. the Stats leaderboard).
// This spec proves the crafted value is neutralized: no script runs, no
// element is injected, and the avatar falls back to initials — while a
// legitimate data: URL still renders as a background-image.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PAYLOAD = "x');\"><img src=x onerror=window.__pwned=1>";

const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "Alpha", participants: ["u1", "u2"], count: 2,
      msgs: [
        { i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hi from alice" },
        { i: "m2", s: "u2", t: Date.parse("2020-01-01T10:01:00Z"), x: "hi from bob" },
      ], events: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("a crafted pfp value in an imported settings file cannot inject markup", async ({ page }) => {
  // Import shows a "this replaces your customizations" confirm — accept it.
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();

  await page.locator('[data-view="settings"]').click();
  const doc = {
    accent: "#3b82f6",
    names: { u1: "Alice", u2: "Bob" },
    pfps: { u1: PAYLOAD, u2: PNG },
  };
  await page.locator("#set-import-file").setInputFiles({
    name: "settings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator(".toast")).toContainText("Settings imported successfully");

  // pfpHtml() is used throughout Stats/Wrapped/Hall of Fame; the "Messages per
  // person" leaderboard needs nothing but participants + messages to render.
  await page.locator('[data-view="stats"]').click();
  await expect(page.locator(".bar-row").first()).toBeVisible();

  // The payload never executed and never landed as a live element.
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator("img[src='x']").count()).toBe(0);

  // Alice's crafted value is rejected: initials fallback, no background-image.
  const aliceAv = page.locator(".bar-row[data-person-id='u1'] .av");
  await expect(aliceAv).not.toHaveCSS("background-image", /url/);
  await expect(aliceAv).toHaveText("AL");

  // Bob's legit data URL still renders as a background-image.
  const bobAv = page.locator(".bar-row[data-person-id='u2'] .av");
  await expect(bobAv).toHaveCSS("background-image", /data:image/);

  // The same crafted value also can't survive in the People tab (applyPfp sink).
  await page.locator('[data-view="people"]').click();
  await expect(page.locator(".person").first()).toBeVisible();
  const alicePersonAv = page.locator(".person .av[data-id='u1']");
  await expect(alicePersonAv).not.toHaveCSS("background-image", /url/);
  await expect(alicePersonAv).toHaveText("AL");
});
