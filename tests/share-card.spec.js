const { test, expect } = require("@playwright/test");
const fs = require("fs");
const zlib = require("zlib");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// SP10: one canvas share-card renderer for message cards, Hall of Fame cards
// and Wrapped slides, behind a Share dialog (modal stack) with a name-
// redaction toggle and a PNG download. Offline: no request leaves the page.
// Synthetic data only; the names below are made up for the test.
const T = Date.parse("2024-05-01T15:00:00Z");
const LIST = (() => {
  const out = [];
  for (let k = 0; k < 24; k++) out.push({ i: "w" + k, s: ["u1", "u2", "u3"][k % 3], t: T + k * 3600000, x: "pizza night " + k + " 🎉 with friends" });
  out.push({ i: "q1", s: "u1", t: T + 30 * 3600000, x: "told Sam and Jo Quill that @rivera_al booked it 👨‍👩‍👧 — Alex out", r: [{ s: "u2", k: "funny" }, { s: "u3", k: "like" }, { s: "u2", k: "like" }] });
  out.push({ i: "q2", s: "u2", t: T + 31 * 3600000, x: "ok", r: [{ s: "u1", k: "funny" }] });
  return out;
})();
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const NAMES = { u1: "Alex Rivera", u2: "Sam Okafor", u3: "Jo Quill" };
// every spelling that identifies someone: display names, their words, the
// generic "User N" aliases, the handle and the avatar initials
const SECRETS = ["alex", "rivera", "sam", "okafor", "jo quill", "quill", "user 1", "user 2", "user 3", "@rivera_al", "rivera_al"];
const INITIALS = ["AR", "SO", "JQ"];
const SETTINGS = (extra) => JSON.stringify(Object.assign({ names: NAMES }, extra || {}));

// Record every string the page draws on a canvas (the renderer's text
// source), every image drawn, and swallow nothing else.
async function recordCanvas(page) {
  await page.addInitScript(() => {
    window.__drawn = []; window.__images = 0;
    const P = CanvasRenderingContext2D.prototype, ft = P.fillText, st = P.strokeText, di = P.drawImage;
    P.fillText = function (t) { window.__drawn.push(String(t)); return ft.apply(this, arguments); };
    P.strokeText = function (t) { window.__drawn.push(String(t)); return st.apply(this, arguments); };
    P.drawImage = function () { window.__images++; return di.apply(this, arguments); };
  });
}
const drawn = (page) => page.evaluate(() => window.__drawn.slice());
const resetDrawn = (page) => page.evaluate(() => { window.__drawn = []; window.__images = 0; });
const leaks = (strings) => strings.filter((s) => SECRETS.some((n) => s.toLowerCase().includes(n)) || INITIALS.includes(s.trim()));

// Requests made after `since` (http(s)/ws — a blob: download is local).
function trackRequests(page) {
  const log = [];
  page.on("request", (r) => log.push(r.url()));
  return { mark: () => log.length, since: (n) => log.slice(n).filter((u) => !/^(blob|data):/.test(u)) };
}

// A real PNG: signature, IHDR size, IDAT inflates to exactly h rows of w px.
function checkPng(buf) {
  expect(buf.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let off = 8, w = 0, h = 0, depth = 0, type = 0, end = false;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.slice(off + 4, off + 8).toString("ascii");
    const data = buf.slice(off + 8, off + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    if (kind === "IDAT") idat.push(data);
    if (kind === "IEND") end = true;
    off += 12 + len;
  }
  expect(end).toBe(true);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = { 2: 3, 6: 4 }[type];
  expect(depth).toBe(8);
  expect(raw.length).toBe(h * (1 + w * ch));
  return { w, h };
}

async function openShareOnMessage(page, text) {
  const row = page.locator("#view-timeline .msg", { hasText: text }).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole("button", { name: "Share", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Share image" });
  await expect(dlg).toBeVisible();
  return dlg;
}
async function download(page, dlg) {
  const dl = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download PNG" }).click();
  const d = await dl;
  return { name: d.suggestedFilename(), buf: fs.readFileSync(await d.path()) };
}

test.describe("Share: message cards", () => {
  test("Share opens a dialog; Download saves a decodable PNG with no name in the filename and no request", async ({ page }) => {
    const errors = [], logs = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => logs.push(m.text()));
    await recordCanvas(page);
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const req = trackRequests(page);
    const url = page.url();
    const n0 = req.mark(), l0 = logs.length;
    const dlg = await openShareOnMessage(page, "booked it");
    await expect(dlg.locator("canvas")).toBeVisible();
    await expect(dlg.getByRole("checkbox", { name: /Hide names/ })).not.toBeChecked();
    const { name, buf } = await download(page, dlg);
    expect(name).toMatch(/^message-[\w-]+\.png$/);
    for (const s of SECRETS) expect(name.toLowerCase()).not.toContain(s);
    const { w, h } = checkPng(buf);
    expect(w).toBeGreaterThanOrEqual(720);
    expect(h).toBeGreaterThanOrEqual(200);
    expect(h).toBeLessThan(4000);
    expect(req.since(n0)).toEqual([]);
    expect(page.url()).toBe(url);
    expect(logs.slice(l0)).toEqual([]);
    expect(errors).toEqual([]);
    // without redaction the card says who wrote it
    expect((await drawn(page)).some((s) => s.includes("Alex Rivera"))).toBe(true);
  });

  test("Hide names: no name, alias, handle or initials reach the canvas; avatars become plain discs", async ({ page }) => {
    await recordCanvas(page);
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS(), "gca.pfps": JSON.stringify({ u1: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }) } });
    const dlg = await openShareOnMessage(page, "booked it");
    await resetDrawn(page);
    await dlg.getByRole("checkbox", { name: /Hide names/ }).check();
    await expect.poll(async () => (await drawn(page)).length).toBeGreaterThan(2);
    const after = await drawn(page);
    expect(leaks(after), after.join(" | ")).toEqual([]);
    expect(after.some((s) => s.includes("Person A"))).toBe(true);
    expect(after.some((s) => s.includes("@someone"))).toBe(true);
    expect(after.join(" ")).toContain("👨‍👩‍👧");                       // the emoji survives whole
    expect(await page.evaluate(() => window.__images)).toBe(0);     // the photo isn't drawn
    // the saved PNG is the redacted render
    await resetDrawn(page);
    const { buf } = await download(page, dlg);
    checkPng(buf);
    expect(leaks(await drawn(page))).toEqual([]);
  });

  test("the choice is remembered for the next share", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    let dlg = await openShareOnMessage(page, "booked it");
    await dlg.getByRole("checkbox", { name: /Hide names/ }).check();
    await page.keyboard.press("Escape");
    await page.reload();
    dlg = await openShareOnMessage(page, "booked it");
    await expect(dlg.getByRole("checkbox", { name: /Hide names/ })).toBeChecked();
  });

  test("the dialog is a modal layer: focus moves in and is trapped, Esc closes it and returns focus", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const dlg = await openShareOnMessage(page, "booked it");
    await expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(await page.evaluate(() => !!document.activeElement.closest(".share-modal"))).toBe(true);
    for (let k = 0; k < 8; k++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement.closest(".share-modal"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    // focus goes back to the message (its toolbar hid behind the dialog)
    await expect(page.locator("#view-timeline .msg", { hasText: "booked it" }).first()).toBeFocused();
  });

  test("the card wears the theme: a light card on Light, a dark one on Lights-out, the accent edge", async ({ page }) => {
    const px = async (th) => {
      await page.evaluate((t) => localStorage.setItem("gca.theme", t), th);
      await page.reload();
      const dlg = await openShareOnMessage(page, "booked it");
      const c = await dlg.locator("canvas").evaluate((cv) => {
        const g = cv.getContext("2d");
        return { bg: [...g.getImageData(cv.width - 4, cv.height / 2, 1, 1).data], edge: [...g.getImageData(2, cv.height / 2, 1, 1).data] };
      });
      await page.keyboard.press("Escape");
      return c;
    };
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS({ accent: "#ff0000" }) } });
    const light = await px("light"), dark = await px("lightsout");
    expect(Math.min(...light.bg.slice(0, 3))).toBeGreaterThan(200);
    expect(Math.max(...dark.bg.slice(0, 3))).toBeLessThan(50);
    for (const c of [light, dark]) { expect(c.edge[0]).toBeGreaterThan(200); expect(c.edge[1]).toBeLessThan(60); }
  });
});

test.describe("Share: Hall of Fame and Wrapped", () => {
  test("a Hall of Fame card carries its rank and reactions", async ({ page }) => {
    await recordCanvas(page);
    await bootViewer(page, DATA, { ls: { "gca.settings": SETTINGS() } });
    await page.locator('.nav-item[data-view="hof"]').click();
    const row = page.locator("#hof-list .msg", { hasText: "booked it" });
    await row.hover();
    await row.getByRole("button", { name: "Share", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "Share image" });
    const { name, buf } = await download(page, dlg);
    expect(name).toMatch(/^hall-of-fame-[\w-]+\.png$/);
    checkPng(buf);
    const all = (await drawn(page)).join(" | ");
    expect(all).toMatch(/#1/);
    expect(all).toMatch(/hall of fame/i);
    expect(all).toMatch(/3 reactions/);
  });

  test("Wrapped: a ranking slide hides names by default; the PNG is offline and redacted", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await recordCanvas(page);
    await bootViewer(page, DATA, { ls: { "gca.settings": SETTINGS() } });
    const req = trackRequests(page);
    await page.locator('.nav-item[data-view="wrapped"]').click();
    for (let k = 0; k < 6 && !(await page.locator("#wr-slide .pl-row").count()); k++) await page.locator("#wr-next").click();
    await expect(page.locator("#wr-slide .pl-row")).toHaveCount(3);
    const n0 = req.mark();
    await resetDrawn(page);
    await page.getByRole("button", { name: "Share slide" }).click();
    const dlg = page.getByRole("dialog", { name: "Share image" });
    await expect(dlg.getByRole("checkbox", { name: /Hide names/ })).toBeChecked();
    const { name, buf } = await download(page, dlg);
    expect(name).toMatch(/^wrapped-2024-\d+\.png$/);
    const { w, h } = checkPng(buf);
    expect(w).toBeGreaterThanOrEqual(720);
    expect(h).toBeGreaterThanOrEqual(720);
    const all = await drawn(page);
    expect(leaks(all), all.join(" | ")).toEqual([]);
    expect(all.some((s) => s.includes("Person A"))).toBe(true);
    expect(req.since(n0)).toEqual([]);
    // turning it off puts the ranking back
    await resetDrawn(page);
    await dlg.getByRole("checkbox", { name: /Hide names/ }).uncheck();
    await expect.poll(async () => (await drawn(page)).join(" | ")).toContain("Alex Rivera");
  });

  test("Wrapped: autoplay pauses while the share dialog is open", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.settings": SETTINGS() } });
    await page.locator('.nav-item[data-view="wrapped"]').click();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-auto\b/);
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
    await page.getByRole("button", { name: "Share slide" }).click();
    await expect(page.locator("#wr-stage")).toHaveClass(/\bwr-paused\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wr-stage")).not.toHaveClass(/\bwr-paused\b/);
    await expect(page.getByRole("button", { name: "Share slide" })).toBeFocused();
  });
});

test.describe("Share at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the dialog fits the screen and its controls are 44px targets", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootViewer(page, DATA, { ls: { "gca.settings": SETTINGS() } });
    await page.evaluate(() => document.querySelector('.nav-item[data-view="wrapped"]').click());
    await page.getByRole("button", { name: "Share slide" }).tap();
    const dlg = page.getByRole("dialog", { name: "Share image" });
    await expect(dlg).toBeVisible();
    const card = await dlg.locator(".share-card").boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.y + card.height).toBeLessThanOrEqual(844);
    for (const b of await dlg.locator("button:visible, label.share-redact").all()) {
      const r = await b.boundingBox();
      expect(r.width, await b.textContent()).toBeGreaterThanOrEqual(44);
      expect(r.height, await b.textContent()).toBeGreaterThanOrEqual(44);
    }
  });
});

// SP10 review fixes: a name said on its own, a stale render racing a newer
// one, and both Copy image paths plus a failing Download.
test.describe("Share: review fixes", () => {
  test("Hide names: a two-letter first name said on its own (\"Jo\") is not drawn", async ({ page }) => {
    const D = { conversations: [conv("A", "Alpha", [
      { i: "j1", s: "u1", t: T, x: "Jo said hi, ask Jo about it" },
      { i: "j2", s: "u3", t: T + 60000, x: "ok" },
    ])] };
    await recordCanvas(page);
    await bootViewer(page, D, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const dlg = await openShareOnMessage(page, "Jo said hi");
    await resetDrawn(page);
    await dlg.getByRole("checkbox", { name: /Hide names/ }).check();
    await expect.poll(async () => (await drawn(page)).join(" | ")).toContain("Person");
    const all = await drawn(page);
    expect(all.filter((s) => /(^|[^\p{L}])Jo([^\p{L}]|$)/u.test(s)), all.join(" | ")).toEqual([]);
    expect(leaks(all), all.join(" | ")).toEqual([]);
  });

  test("a slow photo from an older render never overwrites the redacted preview or the PNG", async ({ page }) => {
    // every `new Image()` load is held back by __imgDelay ms
    await page.addInitScript(() => {
      window.__imgDelay = 0;
      const Real = window.Image;
      window.Image = function () {
        const img = new Real();
        let h = null;
        Object.defineProperty(img, "onload", { get: () => h, set: (f) => { h = f; } });
        img.addEventListener("load", () => setTimeout(() => { if (h) h.call(img); }, window.__imgDelay));
        return img;
      };
    });
    await recordCanvas(page);
    const PFP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS(), "gca.pfps": JSON.stringify({ u1: PFP }) } });
    await page.evaluate(() => { window.__imgDelay = 1000; });
    const dlg = await openShareOnMessage(page, "booked it");           // render 1: names + slow photo
    const cb = dlg.getByRole("checkbox", { name: /Hide names/ });
    await cb.check();                                                   // render 2: redacted, instant
    await cb.uncheck();                                                 // render 3: names + slow photo
    await resetDrawn(page);
    await cb.check();                                                   // render 4: redacted, instant
    await page.waitForTimeout(1600);                                    // the slow photos land
    const after = await drawn(page);
    expect(leaks(after), after.join(" | ")).toEqual([]);
    expect(after.some((s) => s.includes("Person A"))).toBe(true);
    expect(await page.evaluate(() => window.__images)).toBe(0);
    const { buf } = await download(page, dlg);
    checkPng(buf);
    expect(leaks(await drawn(page))).toEqual([]);
    expect(await page.evaluate(() => window.__images)).toBe(0);
    // the PNG is byte-for-byte a fresh redacted render (no photo, no names)
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__imgDelay = 0; });
    const again = await openShareOnMessage(page, "booked it");
    await expect(again.getByRole("checkbox", { name: /Hide names/ })).toBeChecked();
    const fresh = await download(page, again);
    expect(buf.equals(fresh.buf), "the downloaded PNG matches a clean redacted render").toBe(true);
  });

  test("Copy image is hidden when the browser has no ClipboardItem", async ({ page }) => {
    await page.addInitScript(() => { delete window.ClipboardItem; });
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const dlg = await openShareOnMessage(page, "booked it");
    await expect(dlg.locator(".share-copy")).toBeHidden();
    await expect(dlg.getByRole("button", { name: "Download PNG" })).toBeVisible();
  });

  test("Copy image: a refused clipboard write says to use Download PNG; an accepted one copies a PNG", async ({ page }) => {
    await page.addInitScript(() => {
      window.__copied = [];
      window.__refuse = true;
      Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: (items) => {
        if (window.__refuse) return Promise.reject(new DOMException("denied", "NotAllowedError"));
        window.__copied.push(items.map((it) => it.types.join(",")).join(";"));
        return Promise.resolve();
      } });
    });
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const dlg = await openShareOnMessage(page, "booked it");
    const copy = dlg.getByRole("button", { name: "Copy image" });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(page.locator(".toast")).toHaveText(/Couldn.t copy the image.*Download PNG/);
    await page.evaluate(() => { window.__refuse = false; });
    await copy.click();
    await expect(page.locator(".toast")).toHaveText("Copied image");
    expect(await page.evaluate(() => window.__copied)).toEqual(["image/png"]);
  });

  test("a Download whose render fails says so instead of failing silently", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => { HTMLCanvasElement.prototype.toBlob = function () { throw new Error("tainted"); }; });
    await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": SETTINGS() } });
    const dlg = await openShareOnMessage(page, "booked it");
    await dlg.getByRole("button", { name: "Download PNG" }).click();
    await expect(page.locator(".toast")).toHaveText("Could not render image");
    expect(errors).toEqual([]);
  });
});
