const { test, expect } = require("@playwright/test");
const { bootViewer, collectErrors } = require("./_viewer-fixture.js");

// SP4 AN-20 / UX-31 / AN-21: copy and empty states.
//  - counts are pluralised ("1 message", "1 thread shown"), a short chat's age
//    is "3 days" (not "0.0 yrs");
//  - "Msgs / day" says it is per ACTIVE day;
//  - a Stats panel with no rows is not drawn (no empty bordered box) — here:
//    no links, no reactions, no double texts;
//  - a gallery with no media says so instead of showing a blank grid;
//  - the keyboard help shows ⌘ on a Mac, like the timeline button;
//  - chart canvases name the peak month / hour / weekday.
test.use({ timezoneId: "UTC" });

const msgs = [];
const t0 = Date.parse("2024-03-01T20:00:00Z");
for (let k = 0; k < 10; k++) msgs.push({ i: "m" + k, s: k % 2 ? "u2" : "u1", t: t0 + k * 60000, x: "talking about the plan number " + k });
msgs.push({ i: "z", s: "u1", t: Date.parse("2024-03-04T09:00:00Z"), x: "a lone monday message" });
const DATA = { conversations: [{ id: "G", type: "group", title: "Copy", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };

async function openStats(page) {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
}
const mile = (page, label) => page.locator(".card.mile", { has: page.locator(".stat-lbl", { hasText: label }) });

test("Stats copy: plurals, chat age, per-active-day, hidden empty panels, chart labels", async ({ page }) => {
  const errors = collectErrors(page);
  await openStats(page);
  await expect(mile(page, "Chat age").locator(".stat-num")).toHaveText("3 days");
  await expect(page.locator(".hero .h-inline .l").nth(2)).toHaveText("Msgs / active day");
  // Peak hour 8 PM holds the first day's 10 messages.
  await expect(mile(page, "Peak hour").locator(".mile-sub")).toHaveText("10 messages all-time");
  await expect(page.locator("#view-stats .section-h", { hasText: "busiest day" })).toContainText("(10 messages)");
  // Empty panels are not drawn at all.
  const heads = await page.locator("#view-stats .section-h").allTextContents();
  const has = (re) => heads.some((h) => re.test(h));
  expect(has(/Platform Links/)).toBe(false);
  expect(has(/Reaction Generosity/)).toBe(false);
  expect(has(/Double Texting/)).toBe(false);
  expect(has(/Yapping/)).toBe(true);
  expect(has(/Vocabulary/)).toBe(true);
  await expect(page.locator("#view-stats .bars:empty")).toHaveCount(0);
  // Charts carry a summary.
  await expect(page.locator("#chart-months")).toHaveAttribute("aria-label", /2024-03/);
  await expect(page.locator("#chart-hours")).toHaveAttribute("aria-label", /8pm|20:00/);
  await expect(page.locator("#chart-weekdays")).toHaveAttribute("aria-label", /Friday/);
  expect(errors).toEqual([]);
});

test("threads count, gallery empty state", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="threads"]').click();
  await expect(page.locator("#view-threads")).toContainText("1 thread shown");
  await expect(page.locator("#view-threads .page-sub")).toContainText("1 thread with 8+ messages");
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expect(page.locator("#view-gallery .empty")).toContainText(/No photos or videos/);
});

test("keyboard help uses the platform modifier", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await bootViewer(page, DATA);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("?");
  await expect(page.locator(".kb-modal")).toBeVisible();
  await expect(page.locator(".kb-modal .kb-row").first()).toContainText("⌘");
  await expect(page.locator(".kb-modal .kb-row").first()).not.toContainText("Ctrl");
});
