const { test, expect } = require("@playwright/test");

// P1-4: a corrupt/ported gca.settings.timezone must not brick app boot.
// initDateFormatters() runs at top-level module init and feeds settings.timezone
// straight into `new Intl.DateTimeFormat(..., { timeZone })` with no guard. An
// invalid IANA zone throws a RangeError there, aborting the whole app IIFE
// before the app ever leaves the boot skeleton — this is exactly the vector a
// ported/edited settings.json (see settings-portable.spec.js) can hit.

const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "TZ Boot", participants: ["u1"], count: 1,
      msgs: [{ i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "hello there" }], events: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("an invalid stored timezone falls back to UTC instead of bricking boot", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e));

  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    localStorage.setItem("gca.settings", JSON.stringify({ timezone: "Not/AZone" }));
  });
  await page.goto("/");

  // App must leave the boot skeleton and render real content, not hang forever.
  await expect(page.locator(".msg").first()).toBeVisible();

  // No uncaught RangeError (or anything else) from the bad Intl.DateTimeFormat zone.
  expect(pageErrors).toEqual([]);
});

test("an invalid stored timezone is normalized to UTC in the settings UI", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    localStorage.setItem("gca.settings", JSON.stringify({ timezone: "Not/AZone" }));
  });
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.locator('[data-view="settings"]').click();
  // The bad value must not leak into the UI. Assert via the UTC option's
  // `selected` MARKUP (defaultSelected), NOT the select's `.value`: value would
  // report "UTC" for free because UTC is the first <option> and a select with no
  // explicitly-selected option defaults .value to its first option — so a
  // toHaveValue("UTC") check passes even if normalization is gone. defaultSelected
  // is only true when render actually emitted `selected` on UTC, i.e. when
  // settings.timezone was normalized to "UTC" (not the leaked "Not/AZone").
  const utcSelected = await page.locator('#set-tz option[value="UTC"]').evaluate((el) => el.defaultSelected);
  expect(utcSelected).toBe(true);
  // And the corrupt value must not have rendered as a selected option anywhere.
  const selectedValue = await page.locator("#set-tz").evaluate((el) => {
    const opt = el.querySelector("option[selected]");
    return opt ? opt.value : null;
  });
  expect(selectedValue).toBe("UTC");
});

test("'local' is still accepted and does not fall back to UTC", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    localStorage.setItem("gca.settings", JSON.stringify({ timezone: "local" }));
  });
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.locator('[data-view="settings"]').click();
  await expect(page.locator("#set-tz")).toHaveValue("local");
});
