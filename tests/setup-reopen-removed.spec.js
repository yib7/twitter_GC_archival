require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const X = require("./fixtures/x-export.js");
const { startServer, readData } = require("./_sp6-server.js");

// /api/status didn't return ignoredUsers, so a
// reopened wizard started with nobody removed and its next save un-removed
// everyone (rebuilding them back in). A real server over a synthetic export
// (GCA_PORT=0, mkdtemp GCA_PERSONAL, no native pickers): remove a person,
// reopen the wizard, save without touching anything — they stay removed and
// nothing is rebuilt. The removed person is listed with a way to bring them back.
let S, exportRoot;
test.beforeAll(async () => {
  S = await startServer();
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-reopen-export-"));
  const f = X.writeExport(exportRoot);
  const r = await S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media });
  expect(r.status).toBe(200);
  const id = await S.post("/api/identity", { names: { "222": "Bea" }, pfps: {}, gc: {}, ignoredUsers: ["222"], ignoredGroups: [] });
  expect((await id.json()).rebuilt).toBe(true);
});
test.afterAll(() => { S.stop(); fs.rmSync(exportRoot, { recursive: true, force: true }); });

const cfg = () => JSON.parse(fs.readFileSync(path.join(S.personal, "config.json"), "utf8"));
const dataMtime = () => fs.statSync(path.join(S.personal, "data.js")).mtimeMs;

async function openPeople(page) {
  await page.goto(S.url("/setup.html"));
  await expect(page.locator("#src-locked")).toBeVisible();   // reopened on a built archive
  await page.locator("#src-continue").click();
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person").first()).toBeVisible();
}

test("status reports the removed people", async () => {
  const j = await (await S.get("/api/status")).json();
  expect(j.ignoredUsers).toEqual(["222"]);
});

test("reopening and saving without changes keeps them removed and doesn't rebuild", async ({ page }) => {
  const before = dataMtime();
  await openPeople(page);
  await expect(page.locator("#removed-people")).toContainText("Bea");
  await page.locator('[data-pane="3"] [data-next]').click();
  const reply = page.waitForResponse((r) => r.url().endsWith("/api/identity"));
  await page.locator("#btn-save").click();
  expect((await (await reply).json()).rebuilt).toBe(false);
  await expect(page.locator("#remove-modal")).toBeHidden();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(cfg().ignoredUsers).toEqual(["222"]);
  expect(dataMtime()).toBe(before);
  expect(readData(S.personal).conversations.some((c) => c.msgs.some((m) => m.s === "222"))).toBe(false);
});

test("a removed person can be brought back from the list", async ({ page }) => {
  await openPeople(page);
  await page.locator("#removed-people").getByRole("button", { name: /bring back/i }).click();
  await expect(page.locator("#removed-people")).toBeHidden();
  await page.locator('[data-pane="3"] [data-next]').click();
  const reply = page.waitForResponse((r) => r.url().endsWith("/api/identity"));
  await page.locator("#btn-save").click();
  expect((await (await reply).json()).rebuilt).toBe(true);
  expect(cfg().ignoredUsers).toEqual([]);
  expect(readData(S.personal).conversations.some((c) => c.msgs.some((m) => m.s === "222"))).toBe(true);
});
