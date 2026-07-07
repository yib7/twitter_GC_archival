const { test, expect } = require("@playwright/test");
const fs = require("fs");

const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "Raw One", participants: ["u1"], count: 1,
      msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hello there everyone" }], events: [] },
    { id: "G2", type: "group", title: "Raw Two", participants: ["u2"], count: 1,
      msgs: [{ i: "m2", s: "u2", t: Date.parse("2020-01-02T10:00:00Z"), x: "second group here" }], events: [] },
  ],
};

// Wizard identity lives only in local.js (LOCAL_*), NOT in app settings.
const LOCAL = [
  'window.LOCAL_NAMES = { "u1": "Alice Wizard" };',
  'window.LOCAL_GC = { "G1": { name: "Wizard GC", photo: "" } };',
  'window.LOCAL_IGNORED_GROUPS = ["G2"];',
].join("\n");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("export folds the wizard's local.js identity into one portable file", async ({ page }) => {
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: LOCAL }));
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await page.locator('[data-view="settings"]').click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#set-export").click(),
  ]);
  const json = JSON.parse(fs.readFileSync(await download.path(), "utf8"));

  expect(json.names.u1).toBe("Alice Wizard");          // wizard name, not in settings
  expect(json.gc.G1.name).toBe("Wizard GC");           // wizard group name
  expect(json.ignoredGroups).toContain("G2");          // wizard removal
});

test("import applies names + group info to a clean profile", async ({ page }) => {
  // Clean profile: no wizard identity this time.
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  // Import shows a "this replaces your customizations" confirm — accept it.
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await expect(page.locator("#brand-title")).toHaveText("Raw One");

  await page.locator('[data-view="settings"]').click();
  const doc = {
    accent: "#3b82f6",
    names: { u1: "Imported Bob" },
    gc: { G1: { name: "Imported GC", photo: "" } },
  };
  await page.locator("#set-import-file").setInputFiles({
    name: "settings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });

  await expect(page.locator("#brand-title")).toHaveText("Imported GC");
  const gc = await page.evaluate(() => localStorage.getItem("gca.gc"));
  expect(gc).toContain("Imported GC");
  const s = await page.evaluate(() => localStorage.getItem("gca.settings"));
  expect(s).toContain("Imported Bob");
});

test("dismissing the import confirm leaves existing settings untouched", async ({ page }) => {
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  // Dismiss (cancel) the confirm — the import must be a no-op.
  page.on("dialog", (d) => d.dismiss());
  await page.goto("/");
  await expect(page.locator("#brand-title")).toHaveText("Raw One");

  await page.locator('[data-view="settings"]').click();
  const doc = { accent: "#3b82f6", names: { u1: "Imported Bob" }, gc: { G1: { name: "Imported GC", photo: "" } } };
  await page.locator("#set-import-file").setInputFiles({
    name: "settings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });

  // Nothing changed: brand title and stored settings keep their pre-import values.
  await expect(page.locator("#brand-title")).toHaveText("Raw One");
  const s = await page.evaluate(() => localStorage.getItem("gca.settings"));
  expect(s || "").not.toContain("Imported Bob");
});
