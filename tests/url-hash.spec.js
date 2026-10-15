const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, collectErrors, afterSearchRun } = require("./_viewer-fixture.js");

// SP8: navigation lives in the URL hash — #v=<view>&c=<convId>&m=<msgId>, ids
// only — written with pushState (a new history entry per navigation) /
// replaceState (search typing), and read back on load and on Back / Forward.
// The search query is private-chat text, so it never goes in the URL (browser
// history can sync to the cloud): it rides in history.state instead, which
// Back / Forward and a reload restore. Garbage is ignored safely; a link into
// a hidden or missing conversation / message says so and falls back.
const A = msgs("a", 400, { s: ["u1", "u2", "u3"], step: 3600000, t0: Date.parse("2023-01-01T00:30:00Z"), x: (k) => "alpha note " + k + (k % 2 ? " odd" : " even") });
const B = msgs("b", 200, { s: ["u1", "u2"], step: 3600000, t0: Date.parse("2023-06-01T00:30:00Z"), x: (k) => "bravo line " + k });
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Bravo", B), conv("H", "Hidden", msgs("h", 5))] };
const SETTINGS = JSON.stringify({ timezone: "UTC", tzExplicit: true, ignoredGroups: ["H"], ignoredUsers: ["u3"] });

const hashOf = (page) => page.evaluate(() => location.hash);
const params = async (page) => Object.fromEntries(new URLSearchParams((await hashOf(page)).slice(1)));
const stateQ = (page) => page.evaluate(() => history.state && history.state.q);
// nothing typed in Search ever reaches the address bar
async function noTextInUrl(page, text) {
  const url = await page.evaluate(() => location.href);
  expect(url).not.toContain(encodeURIComponent(text));
  expect(decodeURIComponent(url)).not.toContain(text);
  expect((await params(page)).q).toBeUndefined();
}
const flashed = (page, idx) => expect(page.locator('#tl-list .msg[data-idx="' + idx + '"]')).toHaveClass(/flash/);
const viewShown = (page, v) => expect(page.locator("#view-" + v)).toBeVisible();

async function boot(page, hash, ls) {
  await bootViewer(page, DATA, { goto: false, ls: Object.assign({ "gca.settings": SETTINGS }, ls || {}) });
  await page.goto("/" + (hash || ""));
  await expect(page.locator("#app")).toBeVisible();
  expect(await page.evaluate(() => window.CHAT_DATA.__sample === true)).toBe(true);
}

test("a #c=&m= deep link opens that message in its conversation", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page, "#c=B&m=b120");
  await viewShown(page, "timeline");
  await expect(page.locator("#conv-select")).toHaveValue("B");
  await flashed(page, 120);
  await expect(page.locator('#tl-list .msg[data-idx="120"]')).toBeInViewport();
  expect(await params(page)).toMatchObject({ v: "timeline", c: "B", m: "b120" });
  expect(errors).toEqual([]);
});

test("view switches are history entries: Back / Forward walk them", async ({ page }) => {
  await boot(page, "");
  expect(await params(page)).toMatchObject({ v: "search", c: "A" });
  const len0 = await page.evaluate(() => history.length);
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.locator('.nav-item[data-view="people"]').click();
  expect(await page.evaluate(() => history.length)).toBe(len0 + 2);
  expect((await params(page)).v).toBe("people");
  await page.goBack();
  await viewShown(page, "stats");
  await page.goBack();
  await viewShown(page, "search");
  await page.goForward();
  await viewShown(page, "stats");
  // a conversation switch is one too, and Back undoes it
  await page.locator("#conv-select").selectOption("B");
  expect((await params(page)).c).toBe("B");
  await page.goBack();
  await expect(page.locator("#conv-select")).toHaveValue("A");
});

test("Back after a Jump returns to the result list at its scroll position; Forward re-opens the message", async ({ page }) => {
  await boot(page, "");
  await afterSearchRun(page, () => page.locator("#s-input").fill("odd"));
  const lenTyped = await page.evaluate(() => history.length);
  // typing replaces the entry, it doesn't add one — and the query is in
  // history.state, not the URL
  expect(await stateQ(page)).toBe("odd");
  await noTextInUrl(page, "odd");
  const scroll = page.locator("#s-scroll");
  await scroll.evaluate((s) => { s.scrollTop = 2400; });
  await expect.poll(() => scroll.evaluate((s) => s.scrollTop)).toBeGreaterThan(2000);
  const card = page.locator("#s-list .msg").filter({ has: page.locator(".bubble") }).nth(30);
  await card.scrollIntoViewIfNeeded();
  const before = await scroll.evaluate((s) => s.scrollTop);
  const idx = await card.getAttribute("data-idx");
  const k = (await card.locator(".bubble").textContent()).match(/alpha note (\d+)/)[1];   // message id "a<k>"
  await card.locator(".bubble").click();
  await flashed(page, idx);
  expect(await page.evaluate(() => history.length)).toBe(lenTyped + 1);
  expect((await params(page)).m).toBe("a" + k);

  await noTextInUrl(page, "odd");

  await page.goBack();
  await viewShown(page, "search");
  await expect(page.locator("#s-input")).toHaveValue("odd");
  await noTextInUrl(page, "odd");
  expect(await scroll.evaluate((s) => s.scrollTop)).toBe(before);
  expect(before).toBeGreaterThan(1000);
  await expect(page.locator('#s-list .msg[data-idx="' + idx + '"]')).toBeInViewport();

  await page.goForward();
  await viewShown(page, "timeline");
  await flashed(page, idx);
});

test("the query is restored from history.state on Back and on reload, never from or into the URL", async ({ page }) => {
  const Q = '"alpha note 7" even';
  await boot(page, "");
  await afterSearchRun(page, () => page.locator("#s-input").fill(Q));
  expect(await stateQ(page)).toBe(Q);
  await noTextInUrl(page, "alpha note 7");
  await page.locator('.nav-item[data-view="stats"]').click();
  await viewShown(page, "stats");
  await page.goBack();
  await viewShown(page, "search");
  await expect(page.locator("#s-input")).toHaveValue(Q);
  await page.reload();
  await viewShown(page, "search");
  await expect(page.locator("#s-input")).toHaveValue(Q);
  await expect(page.locator("#s-meta")).toContainText("found");
  for (const t of await page.locator("#s-list .msg .bubble").allTextContents()) expect(t).toContain("alpha note 7");
  await noTextInUrl(page, "alpha note 7");
  // two entries with the same hash but different queries: Back still restores
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.locator('.nav-item[data-view="search"]').click();
  await afterSearchRun(page, () => page.locator("#s-input").fill("bravo"));
  const h = await hashOf(page);
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.goBack();
  await expect(page.locator("#s-input")).toHaveValue("bravo");
  await page.goBack();
  await viewShown(page, "stats");
  await page.goBack();
  await viewShown(page, "search");
  expect(await hashOf(page)).toBe(h);
  await expect(page.locator("#s-input")).toHaveValue(Q);
});

test("a legacy #q= in a pasted address is ignored and stripped", async ({ page }) => {
  await boot(page, "#v=search&q=" + encodeURIComponent("alpha note 7"));
  await viewShown(page, "search");
  await expect(page.locator("#s-input")).toHaveValue("");
  await noTextInUrl(page, "alpha note 7");
});

test("a link to a hidden conversation, a missing one, or a missing message says so and falls back", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page, "#c=H&m=h1");
  await expect(page.locator(".toast")).toContainText("hidden");
  await expect(page.locator("#conv-select")).toHaveValue("A");
  await page.evaluate(() => { location.hash = "#c=NOPE&v=stats"; });
  await expect(page.locator(".toast")).toContainText("isn't in this archive");
  await viewShown(page, "stats");
  await page.evaluate(() => { location.hash = "#c=A&m=zzz"; });
  await expect(page.locator(".toast")).toContainText("isn't in this conversation");
  await viewShown(page, "timeline");
  // a message whose sender is hidden in Settings
  await page.evaluate(() => { location.hash = "#c=A&m=a2"; });
  await expect(page.locator(".toast")).toContainText("hidden");
  expect(errors).toEqual([]);
});

test("garbage in the hash is ignored safely — no throw, nothing injected", async ({ page }) => {
  const errors = collectErrors(page);
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  await boot(page, "#v=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&c=%E0%A4%A&m=%3Cb%3Ex%3C%2Fb%3E&q=%&&&==&x=1");
  // the unknown view and undecodable conversation are dropped; the unknown
  // message id falls back to the Timeline with a plain-text toast
  await viewShown(page, "timeline");
  await expect(page.locator(".toast")).toHaveText("That message isn't in this conversation");
  await page.evaluate(() => { location.hash = "#v=__proto__&c=constructor&m=toString"; });
  await page.evaluate(() => { location.hash = "#" + "v=".repeat(5000); });
  await page.evaluate(() => { location.hash = "#c=<svg onload=alert(1)>&m=1"; });
  await expect(page.locator("#app")).toBeVisible();
  expect(await page.locator("img[src='x'], b:text('x'), svg[onload]").count()).toBe(0);
  expect(dialogs).toBe(0);
  expect(errors).toEqual([]);
});

test("restoring a hash for another conversation goes through the normal switch: filters don't leak (VC-4)", async ({ page }) => {
  await boot(page, "");
  await page.locator("#f-media").click();
  await expect(page.locator("#f-media")).toHaveClass(/active/);
  await page.evaluate(() => { location.hash = "#v=search&c=B"; });
  await expect(page.locator("#conv-select")).toHaveValue("B");
  await expect(page.locator("#f-media")).not.toHaveClass(/active/);
});

test("Copy link to message copies an ids-only link that opens the message", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await boot(page, "", { "gca.lastView": "timeline" });
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("2023-01-11");
  await page.keyboard.press("Enter");
  const msg = page.locator('#tl-list .msg[data-idx="' + await page.locator("#tl-list .msg.flash").getAttribute("data-idx") + '"]');
  await msg.hover();
  await msg.getByRole("button", { name: "Copy link to message" }).click();
  await expect(page.locator(".toast")).toHaveText("Copied link to message");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const k = (await msg.locator(".bubble").textContent()).match(/alpha note (\d+)/)[1];
  expect(link).toBe(page.url().split("#")[0] + "#v=timeline&c=A&m=a" + k);
  expect(link).not.toMatch(/alpha|note|User/);

  const p2 = await context.newPage();
  await bootViewer(p2, DATA, { goto: false, ls: { "gca.settings": SETTINGS } });
  await p2.goto(link);
  await expect(p2.locator("#tl-list .msg.flash .bubble")).toContainText("alpha note " + k + " ");
});

test("file:// — the hash still drives navigation and Back works", async ({ page }) => {
  const url = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
  const errors = collectErrors(page);
  await page.addInitScript(() => { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) { /* storage blocked */ } });
  await page.goto(url + "#v=timeline");
  await expect(page.locator("#app")).toBeVisible();
  // The committed synthetic sample only (the real-data guard keeps personal_data / data.js out of this checkout).
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample === true)).toBe(true);
  await viewShown(page, "timeline");
  await page.locator('.nav-item[data-view="stats"]').click();
  expect((await params(page)).v).toBe("stats");
  await page.goBack();
  await viewShown(page, "timeline");
  // search text stays out of the file:// URL too, and Back restores it
  await page.locator('.nav-item[data-view="search"]').click();
  await page.locator("#s-input").fill("hello");
  await expect.poll(() => page.evaluate(() => history.state && history.state.q)).toBe("hello");
  expect(decodeURIComponent(await page.evaluate(() => location.href))).not.toContain("hello");
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.goBack();
  await viewShown(page, "search");
  await expect(page.locator("#s-input")).toHaveValue("hello");
  await page.locator('.nav-item[data-view="timeline"]').click();
  await viewShown(page, "timeline");
  const first = await page.evaluate(() => window.CHAT_DATA.conversations[0].msgs[3].i);
  await page.evaluate((h) => { location.hash = h; }, "#m=" + encodeURIComponent(first));
  await expect(page.locator('#tl-list .msg[data-idx="3"]')).toHaveClass(/flash/);
  expect(errors).toEqual([]);
});

// Fix round 1: #m= names the message a jump landed on. Once the reader scrolls
// away from it, the entry stops naming it (replaceState), so a reload reopens
// the reading position instead of snapping back to the jump target.
const firstVisibleText = (page) => page.evaluate(() => {
  const s = document.getElementById("tl-scroll"), top = s.getBoundingClientRect().top;
  for (const n of document.querySelectorAll("#tl-list .msg")) {
    if (n.getBoundingClientRect().top >= top) return n.querySelector(".bubble").textContent.trim();
  }
  return null;
});
async function readOn(page, dy) {
  await page.locator("#tl-scroll").evaluate((s, d) => { s.scrollTop += d; }, dy);
  await expect.poll(async () => (await params(page)).m).toBeUndefined();
  await page.waitForTimeout(400);   // let the debounced reading-position save land
  return firstVisibleText(page);
}
const textInView = (page, text) => expect(page.locator("#tl-list .msg", { has: page.locator(".bubble", { hasText: new RegExp("^" + text + "$") }) })).toBeInViewport();

test("reload after a jump and reading on reopens the reading position, not the jump target", async ({ page }) => {
  await boot(page, "", { "gca.lastView": "timeline" });
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("2023-01-11");
  await page.keyboard.press("Enter");
  const target = (await page.locator("#tl-list .msg.flash .bubble").textContent()).trim();
  expect((await params(page)).m).toBeDefined();
  const reading = await readOn(page, -6000);   // ~70 messages up
  expect(reading).not.toBe(target);
  await page.reload();
  await viewShown(page, "timeline");
  await textInView(page, reading);
  await expect(page.locator("#tl-list .msg.flash")).toHaveCount(0);
});

test("a shared #m= link: read on, reload, and you stay where you read to", async ({ page }) => {
  await boot(page, "#c=B&m=b120");
  await flashed(page, 120);
  const reading = await readOn(page, 6000);
  expect(reading).not.toBe("bravo line 120");
  expect((await params(page)).c).toBe("B");
  await page.reload();
  await viewShown(page, "timeline");
  await expect(page.locator("#conv-select")).toHaveValue("B");
  await textInView(page, reading);
  await expect(page.locator("#tl-list .msg.flash")).toHaveCount(0);
});

// Fix round 1: from file:// the full link would carry the local path (and with
// it the OS user name). Copy only the "#…" part there, and say how to use it.
test("file:// — Copy link copies only the #… part and says where to paste it", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const url = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
  await page.addInitScript(() => { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) { /* storage blocked */ } });
  await page.goto(url + "#v=timeline");
  await expect(page.locator("#app")).toBeVisible();
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample === true)).toBe(true);
  const msg = page.locator("#tl-list .msg").filter({ has: page.locator(".bubble") }).last();
  await msg.hover();
  await msg.getByRole("button", { name: "Copy link to message" }).click();
  await expect(page.locator(".toast")).toHaveText("Copied the message's #link — paste it at the end of this archive's address to open it");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^#v=timeline&c=[^&]+&m=[^&]+$/);
  expect(link).not.toMatch(/file:|[\\/]Users[\\/]|index\.html/i);
  const idx = await msg.getAttribute("data-idx");
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.goto(url + link);
  await expect(page.locator('#tl-list .msg[data-idx="' + idx + '"]')).toHaveClass(/flash/);
});
