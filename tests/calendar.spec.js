const { test, expect } = require("@playwright/test");
const { bootViewer, conv, collectErrors } = require("./_viewer-fixture.js");
const { contrastFailures } = require("./_contrast.js");

// the Timeline's "Jump to date" opens a calendar: a year / month scrubber
// (bars = message volume) over a month heatmap of days. Built from the cached
// time index (timeAgg — zone-aware days, incl. "local"), keyboard operable
// (arrows move by day / week, Page Up/Down by month, Enter jumps; the month
// strip moves by month), named cells, a typed-date box using the shared
// parser, 390px without page overflow, every theme via tokens.
const T = (s) => Date.parse(s);
const LIST = [];
const add = (iso, n) => { for (let k = 0; k < n; k++) LIST.push({ i: "m" + LIST.length, s: k % 2 ? "u2" : "u1", t: T(iso) + k * 60000, x: "msg " + LIST.length + " on " + iso.slice(0, 10) }); };
add("2022-11-20T12:00:00Z", 2);
add("2023-01-05T12:00:00Z", 3);
add("2023-01-07T03:00:00Z", 1);    // Jan 6 22:00 in New York
add("2023-01-07T12:00:00Z", 6);
add("2023-01-09T12:00:00Z", 1);
add("2023-02-14T12:00:00Z", 4);
add("2023-06-01T12:00:00Z", 2);
LIST.sort((a, b) => a.t - b.t).forEach((m, k) => { m.i = "m" + k; });
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const UTC = { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) };
const idxOfDay = (iso) => LIST.findIndex((m) => new Date(m.t).toISOString().slice(0, 10) >= iso);

const dlg = (page) => page.getByRole("dialog", { name: "Jump to date" });
const day = (page, label) => dlg(page).locator(".cal-d[aria-label^='" + label + "']");
async function openCal(page) {
  await page.locator("#tl-jumpdate").click();
  await expect(dlg(page)).toBeVisible();
}

test.describe("calendar heatmap", () => {
  test.beforeEach(async ({ page }) => { await bootViewer(page, DATA, { ls: UTC }); });

  test("opens on the month being read, with named, counted day cells and volume bars", async ({ page }) => {
    const errors = collectErrors(page);
    await page.keyboard.press("Home");   // reading the oldest message (Nov 2022)
    await openCal(page);
    await expect(dlg(page).locator(".cal-yr[aria-pressed='true']")).toHaveText("2022");
    await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName("November 2022: 2 messages");
    await expect(day(page, "Sunday, November 20, 2022")).toHaveAccessibleName("Sunday, November 20, 2022: 2 messages");
    await expect(day(page, "Sunday, November 20, 2022")).toBeFocused();
    await expect(dlg(page).locator(".cal-yr")).toHaveText(["2022", "2023"]);
    // the month strip of 2023
    await dlg(page).locator(".cal-yr", { hasText: "2023" }).click();
    await expect(dlg(page).locator(".cal-mo")).toHaveCount(12);
    await expect(dlg(page).locator(".cal-mo").nth(0)).toHaveAccessibleName("January 2023: 11 messages");
    await expect(dlg(page).locator(".cal-mo").nth(2)).toHaveAccessibleName("March 2023: no messages");
    // a year keeps the selected month (November 2023); pick January
    await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName("November 2023: no messages");
    await dlg(page).locator(".cal-mo").nth(0).click();
    await expect(day(page, "Saturday, January 7, 2023")).toHaveAccessibleName("Saturday, January 7, 2023: 7 messages");
    await expect(day(page, "Sunday, January 8, 2023")).toHaveAccessibleName("Sunday, January 8, 2023: no messages");
    // intensity: the busiest day is the top level, an empty day level 0
    await expect(day(page, "Saturday, January 7, 2023")).toHaveClass(/\blv4\b/);
    await expect(day(page, "Sunday, January 8, 2023")).toHaveClass(/\blv0\b/);
    expect(errors).toEqual([]);
  });

  test("clicking a day jumps to its first message and closes the calendar", async ({ page }) => {
    await openCal(page);
    await dlg(page).locator(".cal-yr", { hasText: "2023" }).click();
    await dlg(page).locator(".cal-mo").nth(0).click();
    await day(page, "Saturday, January 7, 2023").click();
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#tl-list .msg[data-idx="' + idxOfDay("2023-01-07") + '"]')).toHaveClass(/flash/);
    await expect(page.locator(".toast")).toHaveText("Jumped to Jan 7, 2023");
  });

  test("keyboard: arrows by day / week, Page Up/Down by month, Enter jumps; an empty day says so", async ({ page }) => {
    await openCal(page);   // reading the newest message: June 1, 2023
    const focused = () => page.evaluate(() => document.activeElement.getAttribute("aria-label"));
    expect(await focused()).toMatch(/^Thursday, June 1, 2023: 2 messages$/);
    await page.keyboard.press("ArrowRight");
    expect(await focused()).toMatch(/^Friday, June 2, 2023/);
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toMatch(/^Friday, June 9, 2023/);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await focused()).toMatch(/^Wednesday, May 31, 2023/);
    await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName(/^May 2023/);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    expect(await focused()).toMatch(/^Tuesday, February 28, 2023/);
    await page.keyboard.press("Home");
    expect(await focused()).toMatch(/^Wednesday, February 1, 2023/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toMatch(/^Wednesday, February 22, 2023/);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");   // Feb 16: no messages
    expect(await focused()).toMatch(/^Thursday, February 16, 2023: no messages/);
    await page.keyboard.press("Enter");
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveText("No messages on Feb 16, 2023. Jumped to the next one, Jun 1, 2023");
  });

  test("the month strip moves by month with the arrows and Jump to month jumps", async ({ page }) => {
    await openCal(page);
    await dlg(page).locator(".cal-mo[aria-pressed='true']").focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName("February 2023: 4 messages");
    await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toBeFocused();
    await expect(day(page, "Tuesday, February 14, 2023")).toHaveAccessibleName(/4 messages/);
    await dlg(page).getByRole("button", { name: "Jump to February 2023" }).click();
    await expect(page.locator('#tl-list .msg[data-idx="' + idxOfDay("2023-02-14") + '"]')).toHaveClass(/flash/);
  });

  test("the typed-date box uses the shared parser and keeps the dialog open on a bad date", async ({ page }) => {
    await openCal(page);
    const box = dlg(page).getByRole("textbox", { name: "Date to jump to" });
    await box.fill("2023-02-30");
    await box.press("Enter");
    await expect(dlg(page).locator(".cal-msg")).toHaveText("No such date: 2023-02-30");
    await expect(dlg(page)).toBeVisible();
    await box.fill("Jan 9 2023");
    await box.press("Enter");
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#tl-list .msg[data-idx="' + idxOfDay("2023-01-09") + '"]')).toHaveClass(/flash/);
  });

  test("Escape closes it back to the opener; it's in the command palette too", async ({ page }) => {
    await openCal(page);
    await page.keyboard.press("Escape");
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator("#tl-jumpdate")).toBeFocused();
    await page.keyboard.press("Control+K");
    await page.locator(".cmdk-input").fill("calendar");
    await page.keyboard.press("Enter");
    await expect(dlg(page)).toBeVisible();
  });
});

test("days are bucketed in the configured zone", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "America/New_York", tzExplicit: true }) } });
  await openCal(page);
  await dlg(page).locator(".cal-yr", { hasText: "2023" }).click();
  await dlg(page).locator(".cal-mo").nth(0).click();
  await expect(day(page, "Friday, January 6, 2023")).toHaveAccessibleName("Friday, January 6, 2023: 1 message");
  await expect(day(page, "Saturday, January 7, 2023")).toHaveAccessibleName("Saturday, January 7, 2023: 6 messages");
  await day(page, "Saturday, January 7, 2023").click();
  await expect(page.locator('#tl-list .msg[data-idx="' + (idxOfDay("2023-01-07") + 1) + '"]')).toHaveClass(/flash/);
});

test.describe("calendar at 390px on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("no page overflow, 44px targets, every theme readable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootViewer(page, DATA, { ls: UTC });
    await page.locator("#mic-jump").click();
    await page.locator(".cmdk-input").fill("calendar");
    await page.locator(".cmdk-row", { hasText: "calendar" }).first().click();
    await expect(dlg(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const card = await dlg(page).locator(".cal-card").boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    for (const sel of [".cal-d", ".cal-mo", ".cal-yr", ".cal-close"]) {
      const b = await dlg(page).locator(sel).first().boundingBox();
      expect(b.width, sel).toBeGreaterThanOrEqual(44);
      expect(b.height, sel).toBeGreaterThanOrEqual(44);
    }
    expect(await dlg(page).evaluate((n) => getComputedStyle(n).animationDuration)).toMatch(/^(0s|1e-06s|0\.000001s)$/);
    for (const th of ["lightsout", "dim", "light"]) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, th);
      expect(await contrastFailures(page, ".cal-modal"), th).toEqual([]);
    }
  });

  // The Timeline toolbar is hidden on phones, so the calendar has
  // its own entry in the More sheet (not only the palette).
  test("the More sheet opens the calendar on the Timeline; Escape returns to More", async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
    await page.locator("#tab-more").click();
    const item = page.locator("#more-sheet").getByRole("button", { name: "Jump to date" });
    await expect(item).toBeVisible();
    const b = await item.boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(44);
    await item.click();
    await expect(dlg(page)).toBeVisible();
    await expect(page.locator("#view-timeline")).toBeVisible();
    await expect(page.locator("#more-sheet")).not.toHaveClass(/(^|\s)on(\s|$)/);
    await expect(dlg(page).locator(".cal-d[tabindex='0']")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await day(page, "Thursday, June 1, 2023").click();
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveText("Jumped to Jun 1, 2023");
    // Escape from a fresh open goes back to the More tab, not <body>
    await page.locator("#tab-more").click();
    await page.locator("#more-sheet").getByRole("button", { name: "Jump to date" }).click();
    await expect(dlg(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator("#tab-more")).toBeFocused();
  });
});

// With a corrupt outlier the span tops 60 years and only years
// with messages are listed. Stepping out of a listed year (by day, by month,
// or in the month strip) skips to the nearest listed year in that direction,
// so the year strip always keeps a selected button and a Tab stop.
test("an outlier year: stepping between listed years skips the empty span and keeps a Tab stop", async ({ page }) => {
  const L = [{ i: "x0", s: "u1", t: Date.parse("1905-03-01T12:00:00Z"), x: "corrupt" }].concat(LIST.map((m, k) => Object.assign({}, m, { i: "y" + k })));
  await bootViewer(page, { conversations: [conv("A", "Alpha", L)] }, { ls: UTC });
  await openCal(page);   // June 1, 2023
  await expect(dlg(page).locator(".cal-yr")).toHaveText(["1905", "2022", "2023"]);
  const focused = () => page.evaluate(() => document.activeElement.getAttribute("aria-label"));
  const yearStops = async () => ({
    pressed: await dlg(page).locator(".cal-yr[aria-pressed='true']").allTextContents(),
    stops: await dlg(page).locator(".cal-yr[tabindex='0']").allTextContents(),
  });
  for (let k = 0; k < 17; k++) await page.keyboard.press("PageUp");   // → Jan 1, 2022
  expect(await focused()).toMatch(/^Saturday, January 1, 2022/);
  await page.keyboard.press("ArrowLeft");                             // Dec 31, 2021 isn't listed → Dec 31, 1905
  expect(await focused()).toMatch(/^Sunday, December 31, 1905/);
  expect(await yearStops()).toEqual({ pressed: ["1905"], stops: ["1905"] });
  await page.keyboard.press("PageDown");                              // → the next listed year, January 2022
  expect(await focused()).toMatch(/^Monday, January 31, 2022/);
  await page.keyboard.press("PageUp");
  expect(await focused()).toMatch(/^Sunday, December 31, 1905/);
  await page.keyboard.press("ArrowDown");                             // a week on, still skipping the gap
  expect(await focused()).toMatch(/^Friday, January 7, 2022/);
  expect(await yearStops()).toEqual({ pressed: ["2022"], stops: ["2022"] });
  // the month strip skips the gap too
  await dlg(page).locator(".cal-mo[aria-pressed='true']").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName("December 1905: no messages");
  await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toBeFocused();
  expect(await yearStops()).toEqual({ pressed: ["1905"], stops: ["1905"] });
  await page.keyboard.press("ArrowRight");
  await expect(dlg(page).locator(".cal-mo[aria-pressed='true']")).toHaveAccessibleName("January 2022: no messages");
});
