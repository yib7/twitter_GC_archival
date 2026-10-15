require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForBootLine } = require("./wait-for-boot-line.js");

// the launcher's server must not quit under a tab that is merely hidden
// (Chromium throttles hidden-tab timers to ~1/min; sleeping tabs stop them).
// So each page pings with its own id, says goodbye with a beacon when it
// closes, re-pings when it becomes visible again, and if the server is gone
// says so plainly instead of failing later with "Failed to fetch".

const pingsOf = (reqs) => reqs.filter((u) => /\/api\/ping\?c=/.test(u)).map((u) => /c=([^&]+)/.exec(u)[1]);

for (const pagePath of ["/setup.html", "/index.html"]) {
  test(pagePath + ": pings carry a per-page id; a reload gets a new one", async ({ page }) => {
    const reqs = [];
    page.on("request", (r) => reqs.push(r.url()));
    await page.goto(pagePath);
    await expect.poll(() => pingsOf(reqs).length).toBeGreaterThan(0);
    const id = pingsOf(reqs)[0];
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await page.reload();
    await expect.poll(() => pingsOf(reqs).filter((x) => x !== id).length).toBeGreaterThan(0);
  });
}

// End to end against a server of our own with the launcher's auto-exit on
// (GCA_AUTO_EXIT=1 = --open without opening a browser): a reload or a step to
// another page keeps it running; closing the last page stops it within the
// few-second grace, because the page said goodbye (beacons can't be observed
// from Playwright, so the server's exit is the proof).
test.describe("launcher auto-exit", () => {
  let proc, base, personal, exited;
  test.beforeEach(async () => {
    personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-keepalive-"));
    proc = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "server.js")], {
      cwd: path.join(__dirname, ".."),
      env: Object.assign({}, process.env, { GCA_PERSONAL: personal, GCA_PORT: "0", GCA_NO_ROOT_FALLBACK: "1", GCA_NO_NATIVE_PICKER: "1", GCA_AUTO_EXIT: "1" }),
      stdio: "pipe",
    });
    exited = new Promise((res) => proc.on("exit", () => res(true)));
    base = "http://127.0.0.1:" + (await waitForBootLine(proc, 10000));
  });
  test.afterEach(() => {
    try { proc.kill(); } catch (e) { /* already gone */ }
    fs.rmSync(personal, { recursive: true, force: true });
  });

  // Headless tabs are never throttled or frozen, so model one the way the
  // server sees it: the page stays open but no ping reaches the server.
  test("a throttled / sleeping background tab (pings stop, page still open) does not stop the server", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(base + "/setup.html");
    await page.route("**/api/ping*", () => { /* swallowed: like a frozen tab's timers */ });
    await new Promise((r) => setTimeout(r, 9000));                     // the old rule quit after 6 s of silence
    expect(proc.exitCode, "still running while the tab is silent").toBe(null);
    await page.unroute("**/api/ping*");
  });

  // index.html loaded keepalive.js after the archive
  // data, so a big data.js took longer to load than the 5 s goodbye grace and
  // the server quit under the page that was still loading. keepalive.js now
  // loads first, and the grace is about 20 s.
  test("a slow-loading archive page survives the goodbye from the page before it", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(base + "/setup.html");
    await page.route("**/data.sample.js", async (route) => { await new Promise((r) => setTimeout(r, 12000)); await route.continue().catch(() => {}); });
    await page.goto(base + "/index.html", { waitUntil: "commit" });   // setup.html says goodbye
    await page.waitForTimeout(9000);                                     // longer than the old 5 s grace
    expect(proc.exitCode, "still running while the archive page loads").toBe(null);
    await page.unroute("**/data.sample.js");
  });

  test("reloading and moving between pages keeps the server; closing the last page stops it", async ({ context }) => {
    test.setTimeout(60000);   // the goodbye grace is ~20 s
    const page = await context.newPage();
    await page.goto(base + "/setup.html");
    await page.reload();
    await page.goto(base + "/index.html");
    await page.waitForTimeout(6500);                       // longer than the grace
    expect(proc.exitCode, "still running after reload + navigation").toBe(null);
    await page.close({ runBeforeUnload: false });
    const gone = await Promise.race([exited, new Promise((res) => setTimeout(() => res(false), 35000))]);
    expect(gone, "server exits within the grace after the last page closed").toBe(true);
  });
});

test("index.html and setup.html load keepalive.js before anything else (it has no dependencies)", () => {
  for (const f of ["index.html", "setup.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.filter((s) => s !== "src/theme-boot.js")[0], f).toBe("src/keepalive.js");
  }
});

test("coming back to the tab re-pings at once", async ({ page }) => {
  const reqs = [];
  await page.goto("/setup.html");
  page.on("request", (r) => reqs.push(r.url()));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => pingsOf(reqs).length, { timeout: 1500 }).toBeGreaterThan(0);
});

test("when the server has stopped, the page says so and how to fix it; it clears when the server is back", async ({ page }) => {
  await page.goto("/setup.html");
  const banner = page.locator("#gca-server-down");
  await expect(banner).toHaveCount(0);
  await page.route("**/api/ping*", (route) => route.abort("connectionrefused"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(banner).toContainText(/server has stopped/i);
  await expect(banner).toContainText(/start-setup/);
  await page.unroute("**/api/ping*");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(banner).toBeHidden();
});
