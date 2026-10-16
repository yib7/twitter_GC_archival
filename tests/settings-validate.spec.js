const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, collectErrors } = require("./_viewer-fixture.js");

// the default zone is now the viewer's own ("local"). This spec's
// expected dates were written for UTC, so it pins the browser zone to UTC.
test.use({ timezoneId: "UTC" });

// settings reach the app from two untrusted places — the
// persisted gca.settings blob and an imported JSON file — and neither was
// validated. A crafted colour value was interpolated raw into style="…"
// (markup injection into Hall of Fame / Threads / Battles / Cmd-K), and a
// merely malformed value (accent: 123, colors: {u1: 5}) threw inside
// applyTheme/shade and bricked boot permanently. Import also saved BEFORE the
// throwing applyTheme ran, persisting the bad value, and never applied an
// imported timezone or ignored-user list.

const B = Date.parse("2024-03-10T02:30:00Z");   // 02:30 UTC = 22:30 on Mar 9 in New York
const LIST = msgs("m", 12, { t0: B, extra: (k) => (k === 3 ? { r: [{ k: "funny", s: "u2" }] } : null) });
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const EVIL = 'red"><b id="injected">INJECTED</b><img src="x" onerror="window.__pwned=1" x="';

async function importJson(page, doc) {
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-import-file").setInputFiles({
    name: "settings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });
}

test("an imported colour payload cannot inject markup into any view", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await bootViewer(page, DATA);
  await importJson(page, { names: { u1: "Bob" }, colors: { u1: EVIL, u2: "#ff0000" } });
  await expect(page.locator(".toast")).toContainText("imported");
  for (const v of ["hof", "threads", "battles", "stats", "people", "timeline"]) {
    await page.locator('.nav-item[data-view="' + v + '"]').click();
    await expect(page.locator("#view-" + v)).toBeVisible();
    await expect(page.locator("#injected"), "view " + v).toHaveCount(0);
  }
  await page.keyboard.press("Control+k");
  await expect(page.locator(".cmdk")).toBeVisible();
  await expect(page.locator("#injected")).toHaveCount(0);
  // The invalid colour never reached storage; the valid one did.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings")).colors);
  expect(stored.u1).toBeUndefined();
  expect(stored.u2).toBe("#ff0000");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("a crafted colour already in gca.settings is dropped on load", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "hof", "gca.settings": JSON.stringify({ colors: { u1: EVIL, u2: EVIL } }) } });
  for (const v of ["hof", "threads", "battles"]) {
    await page.locator('.nav-item[data-view="' + v + '"]').click();
    await expect(page.locator("#view-" + v)).toBeVisible();
    await expect(page.locator("#injected"), "view " + v).toHaveCount(0);
  }
});

for (const bad of [{ accent: 123 }, { colors: { u1: 5 } }, { fontSize: "big" }, { density: "cosy", avatars: "yes" }, { saved: "nope", pins: { a: 1 } }, { names: ["x"], colors: null }]) {
  test("malformed persisted settings " + JSON.stringify(bad) + " fall back field-by-field instead of bricking boot", async ({ page }) => {
    const errors = collectErrors(page);
    await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify(bad) } });
    await expect(page.locator("#s-list .msg").first()).toBeVisible();
    expect(errors).toEqual([]);
    const acc = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(acc).toMatch(/^#[0-9a-f]{3,8}$/i);
  });
}

test("valid fields survive next to invalid ones", async ({ page }) => {
  await bootViewer(page, DATA, { local: 'window.LOCAL_NAMES = {"u1":"Alice","u2":"Bob"};',
    ls: { "gca.settings": JSON.stringify({ accent: "nope", names: { u1: "Zed" }, fontSize: 99, pins: ["m1"] }) } });
  await expect(page.locator("#s-list .msg-name", { hasText: "Zed" }).first()).toBeVisible();
  const fs = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim());
  expect(fs).toBe("19px");   // clamped to the slider's max, not dropped
  await page.locator('.nav-item[data-view="pins"]').click();
  await expect(page.locator("#view-pins .msg")).toHaveCount(1);
});

test("a malformed import is validated BEFORE it is saved, and the app keeps working", async ({ page }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => d.accept());
  await bootViewer(page, DATA);
  await importJson(page, { accent: 123, colors: { u1: 5 }, names: { u1: "Imported" }, fontSize: "big" });
  await expect(page.locator(".toast")).toContainText("imported");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings")));
  expect(stored.accent).toBe("#1d9bf0");
  expect(stored.colors).toEqual({});
  expect(stored.fontSize).toBe(15);
  expect(stored.names.u1).toBe("Imported");
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("an imported timezone is validated and applied immediately", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await bootViewer(page, DATA, { ls: { "gca.lastView": "search" } });
  await expect(page.locator("#s-list .msg-time").first()).toContainText("Mar 10, 2024");
  await importJson(page, { names: {}, timezone: "America/New_York" });
  await expect(page.locator(".toast")).toContainText("imported");
  await expect(page.locator("#set-tz")).toHaveValue("America/New_York");
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-list .msg-time").first()).toContainText("Mar 9, 2024");

  // An invalid imported zone keeps the user's CURRENT zone (it does not reset to
  // the default), like any other invalid imported field.
  await importJson(page, { names: {}, timezone: "Not/AZone" });
  await expect(page.locator(".toast").last()).toContainText("imported");
  await expect(page.locator("#set-tz")).toHaveValue("America/New_York");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings")).timezone)).toBe("America/New_York");
});

test("imported ignored users are filtered out right away", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await bootViewer(page, DATA, { local: 'window.LOCAL_NAMES = {"u1":"Alice","u2":"Bob"};' });
  await expect(page.locator("#s-list .msg-name", { hasText: "Bob" }).first()).toBeVisible();
  await importJson(page, { names: { u1: "Alice", u2: "Bob" }, ignoredUsers: ["u2"] });
  await expect(page.locator(".toast")).toContainText("imported");
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  await expect(page.locator("#s-list .msg-name", { hasText: "Bob" })).toHaveCount(0);
});


// Import replaces only what the file carries. A file with no `pfps` leaves every
// saved profile photo (and "me", the appearance, …) alone, and the confirm
// mentions what will change.
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const SEEDED = {
  "gca.pfps": JSON.stringify({ u1: PNG }),
  "gca.settings": JSON.stringify({ me: "u2", accent: "#ff0000", fontSize: 17, pins: ["m1"], timezone: "America/New_York" }),
};

test("import keeps what the file does not carry, and the confirm says so", async ({ page }) => {
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
  await bootViewer(page, DATA, { ls: SEEDED });
  await importJson(page, { names: { u1: "Imported" }, colors: { u2: "#00ff00" } });
  await expect(page.locator(".toast")).toContainText("imported");
  expect(asked).toHaveLength(1);
  const [replaces, keeps] = asked[0].split(/\n\s*\n/).slice(1);
  expect(replaces).toMatch(/^Replaces:/);
  expect(replaces).toContain("people names");
  expect(replaces).toContain("person colors");
  expect(keeps).toMatch(/^Keeps:/);
  for (const k of ["profile photos", "“this is me”", "appearance", "bookmarks", "timezone", "theme"]) expect(keeps).toContain(k);
  const st = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem("gca.settings")), p: JSON.parse(localStorage.getItem("gca.pfps")) }));
  expect(st.p).toEqual({ u1: PNG });
  expect(st.s.me).toBe("u2");
  expect(st.s.accent).toBe("#ff0000");
  expect(st.s.fontSize).toBe(17);
  expect(st.s.pins).toEqual(["m1"]);
  expect(st.s.timezone).toBe("America/New_York");
  expect(st.s.names).toEqual({ u1: "Imported" });
  expect(st.s.colors).toEqual({ u2: "#00ff00" });
});

test("a full exported file replaces photos, “this is me” and appearance — and the confirm lists them", async ({ page }) => {
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
  await bootViewer(page, DATA, { ls: SEEDED });
  await importJson(page, {
    version: 2, names: {}, colors: {}, pfps: {}, gc: {}, gcName: "", gcPhoto: "", me: null,
    accent: "#1d9bf0", fontSize: 15, density: "compact", avatars: true, timestamps: true,
    saved: [], pins: [], ignoredUsers: [], ignoredGroups: [], timezone: "UTC", tzExplicit: true,
  });
  await expect(page.locator(".toast")).toContainText("imported");
  const replaces = asked[0].split(/\n\s*\n/)[1];
  for (const k of ["appearance", "people names", "person colors", "profile photos", "group names & photos",
    "saved searches", "bookmarks", "“this is me”", "timezone", "hidden people & groups"]) expect(replaces).toContain(k);
  const st = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem("gca.settings")), p: JSON.parse(localStorage.getItem("gca.pfps")) }));
  expect(st.p).toEqual({});
  expect(st.s.me).toBeNull();
  expect(st.s.accent).toBe("#1d9bf0");
  expect(st.s.density).toBe("compact");
  expect(st.s.pins).toEqual([]);
  expect(st.s.timezone).toBe("UTC");
});
