const { test, expect } = require("@playwright/test");
const { bootViewer, conv, afterSearchRun } = require("./_viewer-fixture.js");

// UX-9 / VC-28 (SP8): jump-to-date reads natural dates through the one shared
// parser (GCAShared.parseJumpDate), rejects dates that don't exist, and is
// honest when the date is outside the archive or has no messages — it says
// where it actually landed instead of "Jumped to <date>". before:/after: in
// Search use the same parser: both are INCLUSIVE of the named period.
const T = (s) => Date.parse(s);
const LIST = [
  { i: "a0", s: "u1", t: T("2024-01-05T10:00:00Z"), x: "jan five one" },
  { i: "a1", s: "u2", t: T("2024-01-05T11:00:00Z"), x: "jan five two" },
  { i: "a2", s: "u1", t: T("2024-01-07T03:00:00Z"), x: "jan seven early utc" },   // Jan 6 22:00 in New York
  { i: "a3", s: "u2", t: T("2024-01-07T12:00:00Z"), x: "jan seven noon" },
  { i: "a4", s: "u1", t: T("2024-01-09T12:00:00Z"), x: "jan nine" },
  { i: "a5", s: "u2", t: T("2024-03-15T12:00:00Z"), x: "march fifteen" },
  { i: "a6", s: "u1", t: T("2024-03-31T23:00:00Z"), x: "march last hour" },
  { i: "a7", s: "u2", t: T("2024-04-02T12:00:00Z"), x: "april two" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const UTC = { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) };

async function paletteJump(page, text) {
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill(text);
  const row = page.locator(".cmdk-row").first();
  await expect(row.locator(".cmdk-hint")).toHaveText("Date");
  return row;
}
const landed = (page, idx) => expect(page.locator('#tl-list .msg[data-idx="' + idx + '"]')).toHaveClass(/flash/);

test.describe("jump to date (UX-9)", () => {
  test.beforeEach(async ({ page }) => { await bootViewer(page, DATA, { ls: UTC }); });

  test("natural day forms land on that day's first message", async ({ page }) => {
    for (const text of ["Jan 7 2024", "7 Jan 2024", "2024-01-07"]) {
      const row = await paletteJump(page, text);
      await expect(row.locator(".cmdk-label")).toHaveText("Jump to Jan 7, 2024");
      await row.click();
      await landed(page, 2);
      await expect(page.locator(".toast")).toHaveText("Jumped to Jan 7, 2024");
    }
  });

  test("month and year forms land on the period's first message", async ({ page }) => {
    const row = await paletteJump(page, "March 2024");
    await expect(row.locator(".cmdk-label")).toHaveText("Jump to March 2024");
    await page.keyboard.press("Enter");
    await landed(page, 5);
    await expect(page.locator(".toast")).toHaveText("Jumped to March 2024");
    await paletteJump(page, "2024-04");
    await page.keyboard.press("Enter");
    await landed(page, 7);
    await paletteJump(page, "2024");
    await page.keyboard.press("Enter");
    await landed(page, 0);
    await expect(page.locator(".toast")).toHaveText("Jumped to 2024");
  });

  test("after the last message: lands on the latest and says so", async ({ page }) => {
    await paletteJump(page, "2031-05-05");
    await page.keyboard.press("Enter");
    await landed(page, 7);
    await expect(page.locator(".toast")).toHaveText("No messages after Apr 2, 2024 — jumped to the latest one");
  });

  test("before the first message: lands on the first and says so", async ({ page }) => {
    await paletteJump(page, "June 2021");
    await page.keyboard.press("Enter");
    await landed(page, 0);
    await expect(page.locator(".toast")).toHaveText("No messages before Jan 5, 2024 — jumped to the first one");
  });

  test("a day without messages lands on the next one and says so", async ({ page }) => {
    await paletteJump(page, "2024-01-08");
    await page.keyboard.press("Enter");
    await landed(page, 4);
    await expect(page.locator(".toast")).toHaveText("No messages on Jan 8, 2024 — jumped to the next one, Jan 9, 2024");
    await paletteJump(page, "Feb 2024");
    await page.keyboard.press("Enter");
    await landed(page, 5);
    await expect(page.locator(".toast")).toHaveText("No messages in February 2024 — jumped to the next one, Mar 15, 2024");
  });

  test("a date that doesn't exist is rejected, not rolled over", async ({ page }) => {
    const row = await paletteJump(page, "2023-02-30");
    await expect(row.locator(".cmdk-label")).toHaveText("No such date: 2023-02-30");
    const before = await page.locator("#tl-scroll").evaluate((s) => s.scrollTop);
    await page.keyboard.press("Enter");
    await expect(page.locator(".toast")).toHaveText("No such date: 2023-02-30");
    await expect(page.locator("#tl-list .msg.flash")).toHaveCount(0);
    expect(await page.locator("#tl-scroll").evaluate((s) => s.scrollTop)).toBe(before);
  });

  test("a day-first date says to use an unambiguous form; the hint names month/day/year", async ({ page }) => {
    const row = await paletteJump(page, "13/01/2024");
    await expect(row.locator(".cmdk-label")).toHaveText("13/01/2024 isn't month/day/year");
    await expect(row.locator(".cmdk-sub")).toHaveText("Use YYYY-MM-DD or Jan 7 2024");
    await page.keyboard.press("Enter");
    await expect(page.locator(".toast")).toHaveText("13/01/2024 isn't month/day/year. Use YYYY-MM-DD or Jan 7 2024");
    await expect(page.locator("#tl-list .msg.flash")).toHaveCount(0);
    // the "not a date" hint names the slashed form's order
    await page.locator("#tl-jumpdate").click();
    const box = page.getByRole("textbox", { name: "Date to jump to" });
    await box.fill("someday");
    await box.press("Enter");
    await expect(page.locator(".cal-msg")).toHaveText("Not a date. Try 2021-06-14, June 2021, Jan 7 2024 or 6/14/2021 (month/day/year)");
    await box.fill("13/01/2024");
    await box.press("Enter");
    await expect(page.locator(".cal-msg")).toHaveText("13/01/2024 isn't month/day/year. Use YYYY-MM-DD or Jan 7 2024");
  });
});

test("jump-to-date buckets days in the configured zone", async ({ page }) => {
  // 2024-01-07T03:00Z is Jan 6 in New York, so New York's Jan 7 starts at a3.
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "America/New_York", tzExplicit: true }) } });
  await paletteJump(page, "Jan 7 2024");
  await page.keyboard.press("Enter");
  await landed(page, 3);
});

test.describe("before:/after: share the parser and are inclusive (VC-28)", () => {
  test.beforeEach(async ({ page }) => {
    await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  });
  const count = (page) => page.locator("#s-list .msg").count();

  test("a month or a year is a whole period, both ends inclusive", async ({ page }) => {
    await afterSearchRun(page, () => page.locator("#s-input").fill("before:2024-03 "));
    expect(await count(page)).toBe(7);    // all of March 2024 included, incl. its last hour
    await afterSearchRun(page, () => page.locator("#s-input").fill("after:2024-03 "));
    expect(await count(page)).toBe(3);    // March 15, March 31, April 2
    await afterSearchRun(page, () => page.locator("#s-input").fill("after:2024-01-07 before:2024-01-07"));
    expect(await count(page)).toBe(2);    // exactly that day
    await afterSearchRun(page, () => page.locator("#s-input").fill('after:"Jan 9 2024" before:"March 2024"'));
    expect(await count(page)).toBe(3);
    await afterSearchRun(page, () => page.locator("#s-input").fill("before:2023"));
    expect(await count(page)).toBe(0);
  });

  test("a date that doesn't exist is ignored with a note, never rolled over or searched as text", async ({ page }) => {
    await afterSearchRun(page, () => page.locator("#s-input").fill("before:2024-01-32"));
    expect(await count(page)).toBe(8);
    await expect(page.locator("#s-meta")).toContainText("Ignored before:2024-01-32 — no such date");
    await afterSearchRun(page, () => page.locator("#s-input").fill("after:13/01/2024"));
    expect(await count(page)).toBe(8);
    await expect(page.locator("#s-meta")).toContainText("Ignored after:13/01/2024 — use YYYY-MM-DD or Jan 7 2024");
  });
});
