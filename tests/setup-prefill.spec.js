require("./_real-data-guard.js");   // refuse to run outside a clean checkout — required first, consistently, even though Playwright already ran it once at the top of playwright.config.js in this same worker process
const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForBootLine } = require("./_wait-for-boot-line.js");   // dedup — see that file

// Regression coverage: apiIdentity used to overwrite cfg.names/local.js
// verbatim from the POST body, so reopening the wizard and saving again (with
// the name fields empty/unloaded) silently wiped every previously saved name.
//
// The existing setup-*.spec.js specs mock every /api/* route, so they never
// exercise real persistence — a mocked route never touches disk, so there is
// nothing to "reload" and observe. Proving the fix needs a REAL server writing
// to a REAL (throwaway) personal_data/, so this spec spawns its own
// scripts/server.js — on its own port, pointed at a fresh GCA_PERSONAL temp
// dir via env vars — instead of using the shared webServer from
// playwright.config.js. The temp dir is created under the OS temp dir and
// removed afterward; the real project's personal_data/ is never touched.
// a random port from a fixed range (8700-9599) used to let this collide
// with someone else's server — the range even included 8765, the default
// archive port. Worse, the old "poll /api/ping, then check exitCode !== null"
// guard has a race: if the port was already taken, the poll can succeed
// before our own losing child has actually exited, so the guard passes and
// this file's real /api/source + /api/identity writes land on a FOREIGN
// server (reproduced in scratchpad/race.js). GCA_PORT=0 asks the OS for a
// genuinely free ephemeral port instead of guessing one, removing the
// collision outright; server.js prints the port it actually bound, so parse
// that instead of assuming.
let PORT;
let BASE;
let tmpDir;
let exportDir;
let serverProc;

test.beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-prefill-"));
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-prefill-export-"));

  // A minimal real group export: one group ("G1"), one sender ("1111") with two
  // messages long enough to pass collectParticipants' sample-message filter.
  const groupJs = "window.YTD.direct_messages_group.part0 = " + JSON.stringify([
    { dmConversation: { conversationId: "G1", messages: [
      { messageCreate: { id: "m1", senderId: "1111", createdAt: "2020-01-01T00:00:00.000Z", text: "hello there this is a real message" } },
      { messageCreate: { id: "m2", senderId: "1111", createdAt: "2020-01-01T00:01:00.000Z", text: "another real message here too" } },
    ] } },
  ]) + ";\n";
  fs.writeFileSync(path.join(exportDir, "direct-messages-group.js"), groupJs);
  const headersJs = "window.YTD.direct_message_group_headers.part0 = " + JSON.stringify([
    { dmConversation: { conversationId: "G1", messages: [] } },
  ]) + ";\n";
  fs.writeFileSync(path.join(exportDir, "direct-message-group-headers.js"), headersJs);
  fs.mkdirSync(path.join(exportDir, "media"));

  serverProc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { GCA_PERSONAL: tmpDir, GCA_PORT: "0" }),
    stdio: "pipe",
  });
  PORT = await waitForBootLine(serverProc, 10000);
  BASE = "http://127.0.0.1:" + PORT;
});

test.afterAll(async () => {
  if (serverProc) serverProc.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (exportDir) fs.rmSync(exportDir, { recursive: true, force: true });
});

// Drives the real /api/source build (paths typed directly, no native picker)
// so /api/parts has a real roster — matching how every other setup-*.spec.js
// gets past step 1. On a reopened, already-built archive step 1 is locked;
// the second visit now goes through the wizard's own "Add a
// newer export" (the same export again) instead of re-enabling the locked
// fields by script — the identity saved on the first visit must survive it.
async function buildAndGotoPeopleStep(page) {
  await page.goto(BASE + "/setup.html");
  // the source locks only once /api/status is in; reading it sooner sees it unlocked
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  const locked = await page.locator("#src-locked").isVisible();
  if (locked) await page.locator("#src-add").click();
  await page.locator("#src-group").fill(path.join(exportDir, "direct-messages-group.js"));
  await page.locator("#src-headers").fill(path.join(exportDir, "direct-message-group-headers.js"));
  await page.locator("#src-media").fill(path.join(exportDir, "media"));
  // Check export → preview → Build. The same export again adds nothing
  // new, so it needs the extra "merge anyway" confirm.
  await checkAndBuild(page, { olderOk: locked });
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
  await page.locator('[data-pane="2"] [data-next]').click();
  await expect(page.locator(".su-person").first()).toBeVisible();
}

test("saving a name then reopening prefills it, and a no-op re-save does not wipe it", async ({ page }) => {
  await buildAndGotoPeopleStep(page);

  const card = page.locator(".su-person").first();
  await expect(card.locator(".su-meta")).toContainText("id 1111");
  await card.locator(".su-name").fill("Alice");
  await card.getByRole("radio").check();

  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);

  // Confirm the name actually landed in local.js (real file, real server).
  const afterFirstSave = await page.evaluate((base) => fetch(base + "/personal_data/local.js").then((r) => r.text()), BASE);
  expect(afterFirstSave).toContain("Alice");

  // Reopen: the wizard should show the previously saved name/me, not blank
  // fields — this is the "prefill" half of the fix.
  await buildAndGotoPeopleStep(page);
  const reopened = page.locator(".su-person").first();
  await expect(reopened.locator(".su-name")).toHaveValue("Alice");
  await expect(reopened.getByRole("radio")).toBeChecked();

  // Save again WITHOUT retyping the name (simulates reopening only to tweak
  // something else, e.g. a group photo, then hitting Save). Before the fix,
  // apiIdentity overwrote cfg.names/local.js with {} here.
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);

  const afterSecondSave = await page.evaluate((base) => fetch(base + "/personal_data/local.js").then((r) => r.text()), BASE);
  expect(afterSecondSave).toContain("Alice");
});

// The wizard's own client-side prefill (loadStatus → state.names) means a
// normal reopen-and-resave never posts an empty names map in practice. But
// the actual guarantee — the thing that makes the client-side prefill
// safe to rely on at all — is server-side: apiIdentity must merge posted names
// over the saved ones, not overwrite. Post directly to /api/identity (bypassing
// the wizard UI/state entirely) to prove that guarantee in isolation, exactly
// as the test title says: posting empty names after a save leaves the local.js
// names intact.
test("POST /api/identity with empty names after a save leaves local.js names intact", async ({ page }) => {
  await page.goto(BASE + "/setup.html");   // establishes a same-origin page to fetch() from

  const save = (names) => page.evaluate(
    ({ base, names }) => fetch(base + "/api/identity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: null, gc: {}, names, pfps: {}, ignoredUsers: [], ignoredGroups: [] }),
    }).then((r) => r.json()),
    { base: BASE, names },
  );

  await save({ "1111": "Bob" });
  const afterFirstSave = await page.evaluate((base) => fetch(base + "/personal_data/local.js").then((r) => r.text()), BASE);
  expect(afterFirstSave).toContain("Bob");

  await save({});   // the exact regression trigger: an empty names map
  const afterEmptySave = await page.evaluate((base) => fetch(base + "/personal_data/local.js").then((r) => r.text()), BASE);
  expect(afterEmptySave).toContain("Bob");
});

const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The brief warns that saved pfp paths are display-only: they must repaint the
// avatar background on reopen but never be written into state.pfps (that map
// holds fresh data-URLs the server decodes; a path string there would be
// posted back to /api/identity as if it were image data and break the save).
test("a saved photo repaints the avatar on reopen without corrupting a later save", async ({ page }) => {
  await buildAndGotoPeopleStep(page);

  const card = page.locator(".su-person").first();
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    card.locator(".su-pick").click(),
  ]);
  await fileChooser.setFiles({ name: "pic.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1.split(",")[1], "base64") });
  await page.getByRole("button", { name: /use this photo/i }).click();

  await page.locator('[data-pane="3"] [data-next]').click();
  let saveBody = null;
  await page.route("**/api/identity", (route) => {
    saveBody = JSON.parse(route.request().postData() || "{}");
    route.continue();
  });
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(saveBody.pfps["1111"]).toMatch(/^data:image\/png/);   // fresh upload posts a data URL

  // Reopen: the avatar should show the saved photo (a served personal_data/…
  // path), painted as a CSS background-image — not left as bare initials.
  await buildAndGotoPeopleStep(page);
  const av = page.locator(".su-person").first().locator(".su-av");
  await expect(av).not.toHaveCSS("background-image", "none");

  // Save again with nothing re-uploaded: the posted pfps map must NOT contain
  // the saved path string (that would be posted back as if it were a fresh
  // data URL and fail server-side decoding).
  let secondSaveBody = null;
  await page.route("**/api/identity", (route) => {
    secondSaveBody = JSON.parse(route.request().postData() || "{}");
    route.continue();
  });
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(secondSaveBody.pfps).not.toHaveProperty("1111");
});
