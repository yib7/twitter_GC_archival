require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const X = require("./fixtures/x-export.js");
const { startServer } = require("./_sp6-server.js");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// Values from a hand-edited or shared data.js / config.json that reached the
// page as markup or as a link: a conversation's message count, media paths,
// and saved photo paths in the setup wizard's last step. Each must stay text
// (or be dropped), never become an element or a javascript:/data: link.

const COUNT = '<b id="pwn-count">7</b><a id="pwn-link" href="https://evil.example">reload</a>';
const T0 = Date.parse("2024-03-10T12:00:00Z");

test("a conversation count that is markup renders as a number, in both pickers and Settings", async ({ page }) => {
  const a = conv("G1", "Alpha", msgs("a", 3), { count: COUNT });
  const b = conv("G2", "Beta", msgs("b", 2), { count: [COUNT] });
  await bootViewer(page, { conversations: [a, b] });
  await expect(page.locator("#conv-select")).toBeAttached();
  await expect(page.locator("#conv-select option").first()).toContainText(/· 0$/);
  await page.locator('[data-view="settings"]').click();
  await expect(page.locator(".gc-item-meta").first()).toBeVisible();
  await expect(page.locator(".gc-item-meta").first()).toContainText("0 messages");
  expect(await page.locator("#pwn-count, #pwn-link").count()).toBe(0);
});

test("media paths that are javascript: or data: URLs never become links", async ({ page }) => {
  const list = [
    { i: "m1", s: "u1", t: T0, x: "a file", k: "file", m: "javascript:window.__pwned=1" },
    { i: "m2", s: "u2", t: T0 + 60e3, x: "more files", k: "file", m: "personal_data/media/2-ok.pdf",
      mx: [{ k: "img", m: "javascript:window.__pwned=2" }, { k: "file", m: " data:text/html,<script>window.__pwned=3</script>" }, { k: "file", m: "java\tscript:window.__pwned=4" }] },
  ];
  await bootViewer(page, { conversations: [conv("G1", "Alpha", list)] });
  await expect(page.locator(".media").first()).toBeVisible();
  const hrefs = await page.locator(".media a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(h == null || !/^\s*(?:java\s*script|data):/i.test(h), String(h)).toBe(true);
  expect(hrefs).toContain("personal_data/media/2-ok.pdf");
  for (const a of await page.locator(".media a[href]").all()) {
    const href = await a.getAttribute("href");
    if (href !== "personal_data/media/2-ok.pdf") throw new Error("unexpected link " + href);
  }
});

test("the lightbox's Download link refuses a javascript: media path", async ({ page }) => {
  const list = [{ i: "m1", s: "u1", t: T0, x: "a photo", k: "img", m: "javascript:window.__pwned=1" }];
  await bootViewer(page, { conversations: [conv("G1", "Alpha", list)] });
  await page.locator(".media img").first().dispatchEvent("click");
  await expect(page.locator(".lb-dl")).toBeAttached();
  const href = await page.locator(".lb-dl").getAttribute("href");
  expect(href == null || !/^\s*javascript:/i.test(href), String(href)).toBe(true);
});

test.describe("the setup wizard's last step", () => {
  let S, exportRoot;
  test.beforeAll(async () => {
    S = await startServer();
    exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-inject-export-"));
    const f = X.writeExport(exportRoot);
    expect((await S.post("/api/source", { groupJs: f.group, headersJs: f.headers, mediaDir: f.media })).status).toBe(200);
    // a config.json written before the server checked these, or edited by hand
    const cfgPath = path.join(S.personal, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.gc = { 1000000001: { name: "Crew", photo: "personal_data/pfps/a.png')\"><img id=\"pwn-mark\" src=\"x\"><b x=\"" } };
    cfg.pfps = { 111: "personal_data/pfps/b.png')\"><img id=\"pwn-av\" src=\"x\"><b x=\"" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  });
  test.afterAll(() => { S.stop(); fs.rmSync(exportRoot, { recursive: true, force: true }); });

  test("saved photo paths that break out of url('') stay out of the page", async ({ page }) => {
    await page.goto(S.url("/setup.html"));
    await page.locator("#src-continue").click();
    await page.locator('[data-pane="2"] [data-next]').click();
    await page.locator('[data-pane="3"] [data-next]').click();
    await expect(page.locator("#fin-receipt .fr-name")).toHaveText("Crew");
    expect(await page.locator("#pwn-mark, #pwn-av").count()).toBe(0);
  });
});
