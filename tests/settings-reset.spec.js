const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv, collectErrors } = require("./_viewer-fixture.js");

// VC-3 / UX-3: "Reset all" said it reset "names, colors, theme and saved
// searches" but actually did Object.assign({}, DEFAULTS, …): it silently wiped
// every bookmark, "this is me", ignored people/groups and the timezone, and it
// aliased DEFAULTS.pins/ignored*/pfps/gc — bookmarking after a reset mutated
// DEFAULTS, so the NEXT reset "restored" those pins. It also never rebuilt the
// date formatters, never re-filtered/re-rendered the conversation, and left
// PFPS out of step with settings.pfps.
//
// New contract: Reset restores appearance + names/colours + saved searches,
// and KEEPS bookmarks, "this is me", ignored people/groups, timezone and
// photos. The confirm text lists both sides.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const LIST = msgs("m", 12, { s: ["u1", "u2", "u3"], t0: Date.parse("2024-03-10T02:30:00Z") });
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const SEEDED = {
  names: { u1: "Zed" }, colors: { u1: "#ff0000" }, accent: "#ff0000", fontSize: 18, density: "compact",
  avatars: false, saved: [{ name: "mine", q: "text", f: {} }],
  pins: ["m1"], me: "u1", ignoredUsers: ["u3"], timezone: "America/New_York",
};

async function reset(page) {
  let msg = null;
  page.once("dialog", (d) => { msg = d.message(); d.accept(); });
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-reset").click();
  await expect(page.locator(".toast")).toContainText(/reset/i);
  return msg;
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings")));

test("VC-3: Reset keeps bookmarks, me, ignored people, timezone and photos — and says so", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA, { ls: {
    "gca.settings": JSON.stringify(SEEDED), "gca.theme": "dim",
    "gca.pfps": JSON.stringify({ u2: PNG }), "gca.gc": JSON.stringify({ A: { name: "GC Name", photo: PNG } }),
  } });
  const msg = await reset(page);
  expect(msg).toMatch(/bookmarks/i);
  expect(msg).toMatch(/keep/i);
  expect(msg).toMatch(/timezone/i);
  expect(msg).toMatch(/saved searches/i);

  const s = await stored(page);
  // kept
  expect(s.pins).toEqual(["m1"]);
  expect(s.me).toBe("u1");
  expect(s.ignoredUsers).toEqual(["u3"]);
  expect(s.timezone).toBe("America/New_York");
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("gca.pfps")))).toEqual({ u2: PNG });
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("gca.gc"))).A.photo).toBe(PNG);
  // reset
  expect(s.names).toEqual({});
  expect(s.colors).toEqual({});
  expect(s.accent).toBe("#1d9bf0");
  expect(s.fontSize).toBe(15);
  expect(s.density).toBe("comfortable");
  expect(s.avatars).toBe(true);
  expect(s.saved).toEqual([]);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("gca.gc"))).A.name).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("gca.theme"))).toBe("lightsout");
  await expect(page.locator("#set-tz")).toHaveValue("America/New_York");
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  expect(errors).toEqual([]);
});

test("VC-3: Reset re-renders views that were already built (names, photos, timezone)", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify(SEEDED), "gca.pfps": JSON.stringify({ u2: PNG }) } });
  await expect(page.locator("#s-list .msg-name", { hasText: "Zed" }).first()).toBeVisible();
  await reset(page);
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  await expect(page.locator("#s-list .msg-name", { hasText: "Zed" })).toHaveCount(0);
  // u3 is still ignored, the kept photo still renders, labels stay in New York time.
  await expect(page.locator('#s-list .av[data-id="u3"]')).toHaveCount(0);
  const bg = await page.locator('#s-list .av[data-id="u2"]').first().evaluate((n) => n.style.backgroundImage);
  expect(bg).toContain("data:image/png");
  await expect(page.locator("#s-list .msg-time").first()).toContainText("Mar 9, 2024");
});

test("VC-3: repeated resets never resurrect or drop bookmarks (no shared DEFAULTS arrays)", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  const pin = async (n) => {
    await page.locator('.nav-item[data-view="timeline"]').click();
    const row = page.locator("#view-timeline .msg").nth(n);
    await row.hover();
    await row.locator(".act-pin").click();
  };
  await pin(0);
  await reset(page);
  expect((await stored(page)).pins).toEqual(["m0"]);
  await pin(1);
  expect((await stored(page)).pins).toEqual(["m0", "m1"]);
  await reset(page);
  expect((await stored(page)).pins).toEqual(["m0", "m1"]);
  await pin(0);   // un-bookmark m0
  await pin(1);   // un-bookmark m1
  expect((await stored(page)).pins).toEqual([]);
  await reset(page);
  expect((await stored(page)).pins).toEqual([]);
  expect(errors).toEqual([]);
});
