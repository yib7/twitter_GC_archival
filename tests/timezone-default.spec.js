const { test, expect } = require("@playwright/test");

// UX-20 (SP3): the default timezone is the browser's own ("local"), not UTC.
//  - fresh settings → local;
//  - a stored "UTC" WITHOUT the tzExplicit marker is the old default: migrated
//    once to local, and the migration is persisted;
//  - a stored "UTC" WITH the marker (a user who chose it) is preserved;
//  - choosing any zone in Settings — UTC included — sets the marker;
//  - the picker offers every IANA zone Intl knows (filterable), with
//    "Browser local" and "UTC" pinned at the top.
test.use({ timezoneId: "Asia/Tokyo" });

// 2024-01-01T20:30Z is Jan 2 05:30 in Tokyo — the label tells the zones apart.
const DATA = {
  __sample: true,
  conversations: [{
    id: "G", type: "group", title: "Zones", participants: ["u1"], count: 1,
    msgs: [{ i: "m1", s: "u1", t: Date.parse("2024-01-01T20:30:00Z"), x: "zone probe" }],
    events: [],
  }],
};

async function boot(page, stored) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.clear();
    localStorage.setItem("gca.onboarded", "1");
    if (s) localStorage.setItem("gca.settings", JSON.stringify(s));
  }, stored || null);
  await page.route("**/data.sample.js", (r) => r.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings") || "null"));
const openSettings = (page) => page.locator('.nav-item[data-view="settings"]').click();

test("fresh settings default to the browser's local zone", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".msg .msg-time").first()).toContainText("Jan 2, 2024");
  await openSettings(page);
  await expect(page.locator("#set-tz")).toHaveValue("local");
});

test("a stored UTC without the marker migrates to local, once, and is persisted", async ({ page }) => {
  await boot(page, { timezone: "UTC" });
  await expect(page.locator(".msg .msg-time").first()).toContainText("Jan 2, 2024");
  const s = await stored(page);
  expect(s.timezone).toBe("local");
  expect(s.tzExplicit).toBe(false);
  await openSettings(page);
  await expect(page.locator("#set-tz")).toHaveValue("local");
});

test("an explicitly chosen UTC is preserved", async ({ page }) => {
  await boot(page, { timezone: "UTC", tzExplicit: true });
  await expect(page.locator(".msg .msg-time").first()).toContainText("Jan 1, 2024");
  expect((await stored(page)).timezone).toBe("UTC");
  await openSettings(page);
  await expect(page.locator("#set-tz")).toHaveValue("UTC");
});

test("choosing UTC in Settings sets the marker and survives a reload", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await page.locator("#set-tz").selectOption("UTC");
  const s = await stored(page);
  expect(s.timezone).toBe("UTC");
  expect(s.tzExplicit).toBe(true);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  expect((await stored(page)).timezone).toBe("UTC");
  await openSettings(page);
  await expect(page.locator("#set-tz")).toHaveValue("UTC");
});

test("any other stored zone is kept as-is", async ({ page }) => {
  await boot(page, { timezone: "Europe/Paris" });
  await openSettings(page);
  await expect(page.locator("#set-tz")).toHaveValue("Europe/Paris");
});

test("the zone picker lists every Intl zone, filterable, with local + UTC on top", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  const tz = page.locator("#set-tz");
  const total = await page.evaluate(() => (Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone").length : 0));
  expect(await tz.locator("option").count()).toBeGreaterThanOrEqual(Math.min(total, 100));
  expect(await tz.locator("option").evaluateAll((o) => o.slice(0, 2).map((x) => x.value))).toEqual(["local", "UTC"]);

  await page.locator("#set-tz-filter").fill("tokyo");
  const vals = await tz.locator("option").evaluateAll((o) => o.map((x) => x.value));
  expect(vals.slice(0, 2)).toEqual(["local", "UTC"]);
  expect(vals).toContain("Asia/Tokyo");
  expect(vals.length).toBeLessThan(6);

  await tz.selectOption("Asia/Tokyo");
  expect((await stored(page)).timezone).toBe("Asia/Tokyo");
  expect((await stored(page)).tzExplicit).toBe(true);
  // Clearing the filter brings the full list back with the choice still selected.
  await page.locator("#set-tz-filter").fill("");
  await expect(tz).toHaveValue("Asia/Tokyo");
  expect(await tz.locator("option").count()).toBeGreaterThanOrEqual(Math.min(total, 100));
});
