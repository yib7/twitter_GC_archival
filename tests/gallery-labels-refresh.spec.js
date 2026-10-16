const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// Gallery cells carry the sender and date in their alt / title / accessible
// name. After a timezone change or a rename they must say the new zone's date
// and the new name, not what they said when the Gallery was first built.
// Synthetic data only.
test.use({ timezoneId: "UTC" });

// 23:30 UTC on Mar 10 is Mar 11 in Tokyo
const T = Date.parse("2024-03-10T23:30:00Z");
const DATA = { conversations: [conv("A", "Alpha", [
  { i: "p1", s: "u1", t: T, x: "a photo", m: "sample/photo-1.svg", k: "img" },
  { i: "p2", s: "u2", t: T + 60000, x: "ok" },
])] };
const cell = (page) => page.locator("#view-gallery .gcell").first();

test("a timezone change re-dates the Gallery cells", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expect(cell(page)).toHaveAttribute("title", /Mar 10, 2024/);
  await page.locator('[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("Asia/Tokyo");
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expect(cell(page)).toHaveAttribute("title", /Mar 11, 2024/);
  await expect(cell(page)).toHaveAttribute("aria-label", /Mar 11, 2024/);
  await expect(cell(page).locator("img")).toHaveAttribute("alt", /Mar 11, 2024/);
});

test("a rename in People renames the Gallery cells", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expect(cell(page)).toHaveAttribute("title", /^User 1 · /);
  await page.locator('.nav-item[data-view="people"]').click();
  await page.locator('#view-people .person-name-input').first().fill("Robin");
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expect(cell(page)).toHaveAttribute("title", /^Robin · /);
  await expect(cell(page)).toHaveAttribute("aria-label", /Robin/);
});
