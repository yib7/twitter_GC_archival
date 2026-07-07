const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Regression coverage for P1-1: apiIdentity used to overwrite cfg.names/local.js
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
// Random high port instead of a fixed one: a fixed port let an orphaned server
// from an interrupted earlier run keep listening, so waitForServer polled the
// STALE server (pointed at a dead temp dir) and every assertion here failed.
const PORT = 8700 + Math.floor(Math.random() * 900);
const BASE = "http://127.0.0.1:" + PORT;
let tmpDir;
let exportDir;
let serverProc;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url).then(() => resolve()).catch((e) => {
        if (Date.now() > deadline) return reject(e);
        setTimeout(poll, 100);
      });
    })();
  });
}

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
    env: Object.assign({}, process.env, { GCA_PERSONAL: tmpDir, GCA_PORT: String(PORT) }),
    stdio: "pipe",
  });
  await waitForServer(BASE + "/api/ping", 10000);
  // If our spawn lost the port to another process, waitForServer above just
  // polled that impostor. Only our own live child counts.
  if (serverProc.exitCode !== null) {
    throw new Error("test server exited (code " + serverProc.exitCode + ") — port " + PORT + " likely in use");
  }
});

test.afterAll(async () => {
  if (serverProc) serverProc.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (exportDir) fs.rmSync(exportDir, { recursive: true, force: true });
});

// Drives the real /api/source build (paths typed directly, no native picker)
// so /api/parts has a real roster — matching how every other setup-*.spec.js
// gets past step 1. On a fresh archive the source fields are enabled; on a
// reopened, already-built archive step 1 is locked (by design — see
// src/setup.js lockSource) with no in-UI way to re-advance without either
// rebuilding or "Start over" (which would wipe the very identity this test is
// checking survives). Since re-submitting the SAME source files is exactly
// what the lock banner tells the user to do to make changes, and apiSource
// handles a repeat submission the same way server-side regardless of the
// client-side disabled attribute, re-enabling the (visually locked) build
// button is the least invasive way to reach step 3 on the second visit
// without inventing new app behavior.
async function buildAndGotoPeopleStep(page) {
  await page.goto(BASE + "/setup.html");
  const locked = await page.locator("#src-locked").isVisible();
  if (locked) {
    await page.evaluate(() => {
      ["src-group", "src-headers", "src-media", "btn-build"].forEach((id) => { document.getElementById(id).disabled = false; });
    });
  }
  await page.locator("#src-group").fill(path.join(exportDir, "direct-messages-group.js"));
  await page.locator("#src-headers").fill(path.join(exportDir, "direct-message-group-headers.js"));
  await page.locator("#src-media").fill(path.join(exportDir, "media"));
  await page.locator("#btn-build").click();
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
// the fix's actual guarantee — the thing that makes the client-side prefill
// safe to rely on at all — is server-side: apiIdentity must merge posted names
// over the saved ones, not overwrite. Post directly to /api/identity (bypassing
// the wizard UI/state entirely) to prove that guarantee in isolation, exactly
// as the audit finding's observable describes: "POSTing /api/identity with
// empty names after a save leaves local.js names intact."
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
