const { test, expect } = require("@playwright/test");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "Alpha", participants: ["u1"], count: 1,
      msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hi from alpha" }], events: [] },
    { id: "G2", type: "group", title: "Beta", participants: ["u2"], count: 1,
      msgs: [{ i: "m2", s: "u2", t: Date.parse("2020-01-02T10:00:00Z"), x: "hi from beta" }], events: [] },
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

test("editing a group's name + photo in Settings updates that group's brand only", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await expect(page.locator("#brand-title")).toHaveText("Alpha");

  // Open Settings → Group chats; G1 (Alpha) is the first row.
  await page.locator('[data-view="settings"]').click();
  const g1row = page.locator("#set-gcs .gc-item").first();
  await g1row.locator(".gc-name-input").fill("Renamed Alpha");
  await g1row.locator('input[type="file"]').setInputFiles({
    name: "g.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64"),
  });

  // The active group's brand updates live.
  await expect(page.locator("#brand-title")).toHaveText("Renamed Alpha");
  await expect(page.locator(".brand-mark")).toHaveCSS("background-image", /data:image/);

  // Switch to Beta — it has no override, so it keeps its own name + no photo.
  await page.selectOption("#conv-select", "G2");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator(".brand-mark")).not.toHaveCSS("background-image", /data:image/);

  // Back to Alpha — the override persists.
  await page.selectOption("#conv-select", "G1");
  await expect(page.locator("#brand-title")).toHaveText("Renamed Alpha");
  await expect(page.locator(".brand-mark")).toHaveCSS("background-image", /data:image/);
});

// A custom group name (Settings or the wizard's local.js) is the chat's name
// everywhere: both pickers and the Pinned headers, not only the brand. The
// pickers follow a rename at once. Untitled groups would otherwise read "Group 1234".
test("a custom group name shows in both pickers and the Pinned headers", async ({ page }) => {
  const UNTITLED = { __sample: true, conversations: [
    DATA.conversations[0],
    Object.assign({}, DATA.conversations[1], { id: "900000001234", title: null }),
  ] };
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(UNTITLED) + ";" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_GC = {"G1":{"name":"Wizard Alpha"}};' }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("gca.gc", JSON.stringify({ "900000001234": { name: "Family" } }));
    localStorage.setItem("gca.settings", JSON.stringify({ pins: ["m1", "m2"] }));
  });
  await page.goto("/");
  await expect(page.locator("#brand-title")).toHaveText("Wizard Alpha");
  const opts = (sel) => page.locator(sel + " option");
  await expect(opts("#conv-select")).toHaveText(["Wizard Alpha · 1", "Family · 1"]);
  await expect(opts("#mobile-conv")).toHaveText(["Wizard Alpha · 1", "Family · 1"]);
  await page.locator('.nav-item[data-view="pins"]').click();
  await expect(page.locator("#view-pins")).toContainText("Family");
  await expect(page.locator("#view-pins")).not.toContainText("Group 1234");
  // a rename in Settings reaches the pickers right away
  await page.locator('[data-view="settings"]').click();
  await page.locator("#set-gcs .gc-item").nth(1).locator(".gc-name-input").fill("Cousins");
  await expect(opts("#conv-select")).toHaveText(["Wizard Alpha · 1", "Cousins · 1"]);
  await expect(opts("#mobile-conv")).toHaveText(["Wizard Alpha · 1", "Cousins · 1"]);
});
