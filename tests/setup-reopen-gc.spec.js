require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");

// /api/status didn't return the saved group names and photos, and the
// wizard's empty { name: "" } entry wiped a saved group name on the next
// Save. A real server over a synthetic export (GCA_PORT=0, mkdtemp
// GCA_PERSONAL, no native pickers): save a group name + photo, reopen the
// wizard — both show — and Save without touching anything keeps them.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
let S, exportRoot;
test.beforeAll(async () => {
  S = await startServer();
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-reopen-gc-export-"));
  const f = X.writeExport(exportRoot);
  expect((await S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media })).status).toBe(200);
  const r = await S.post("/api/identity", { names: {}, pfps: {}, gc: { 1000000001: { name: "Crew", photo: PNG } }, ignoredUsers: [], ignoredGroups: [] });
  expect(r.status).toBe(200);
});
test.afterAll(() => { S.stop(); fs.rmSync(exportRoot, { recursive: true, force: true }); });

const cfg = () => JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));

test("a reopened wizard shows the saved group name and photo, and saving keeps them", async ({ page }) => {
  const photo = cfg().gc["1000000001"].photo;
  await page.goto(S.url("/setup.html"));
  await expect(page.locator("#src-locked")).toBeVisible();
  await page.locator("#src-continue").click();
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  await expect(page.locator("#gc-name")).toHaveValue("Crew");
  await expect(page.locator("#gc-preview")).toHaveCSS("background-image", new RegExp(photo.split("/").pop().replace(/\./g, "\\.")));
  // the other group has nothing saved: still empty
  await page.locator("#gc-group").selectOption("1000000002");
  await expect(page.locator("#gc-name")).toHaveValue("");
  await page.locator("#gc-group").selectOption("1000000001");
  await page.locator('[data-pane="2"] [data-next]').click();
  await page.locator('[data-pane="3"] [data-next]').click();
  await expect(page.locator("#fin-receipt .fr-name")).toHaveText("Crew");
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(cfg().gc["1000000001"]).toEqual({ name: "Crew", photo });
  expect(cfg().gc["1000000002"] && cfg().gc["1000000002"].name || "").toBe("");
});

test("the group name can still be changed and cleared after reopening", async ({ page }) => {
  await page.goto(S.url("/setup.html"));
  await page.locator("#src-continue").click();
  await page.locator("#gc-name").fill("");
  await page.locator('[data-pane="2"] [data-next]').click();
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(cfg().gc["1000000001"].name).toBe("");
  expect(cfg().gc["1000000001"].photo).toBeTruthy();
});
