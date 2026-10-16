const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, afterSearchRun } = require("./_viewer-fixture.js");

// The date in an export file name is today in the zone the app displays
// (the settings zone, or the browser's own), not the UTC date.

const DATA = {
  conversations: [
    conv("A", "Alpha", msgs("a", 4, { x: (k) => "export me " + k })),
    conv("B", "Beta", msgs("b", 2, { x: (k) => "export too " + k })),
  ],
};

async function search(page, q) {
  await page.locator("#s-input").fill(q);
  await expect(page.locator("#s-meta")).toContainText(/message(s)? found/);
}

test.describe("the export file name's date is the viewer's day", () => {
  // 20:00Z on 1 May is already 2 May at UTC+14.
  test.describe("browser zone ahead of UTC, zone setting left on local", () => {
    test.use({ timezoneId: "Pacific/Kiritimati" });
    test("search results", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-05-01T20:00:00Z"));
      await bootViewer(page, DATA);
      await search(page, "export");
      const dlP = page.waitForEvent("download");
      await page.locator("#f-export").click();
      expect((await dlP).suggestedFilename()).toBe("search-results-2025-05-02.txt");
    });
    test("all-chats search results", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-05-01T20:00:00Z"));
      await bootViewer(page, DATA);
      await search(page, "export");
      await afterSearchRun(page, () => page.locator('#s-scope button[data-scope="all"]').click());
      const dlP = page.waitForEvent("download");
      await page.locator("#f-export").click();
      expect((await dlP).suggestedFilename()).toBe("search-results-all-chats-2025-05-02.txt");
    });
  });

  // 03:00Z on 2 May is still 1 May in Los Angeles (UTC-7), though the browser's own zone is UTC.
  test.describe("a zone chosen in settings that is not the browser's", () => {
    test.use({ timezoneId: "UTC" });
    test("search results and pinned messages use that zone's day", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-05-02T03:00:00Z"));
      await bootViewer(page, DATA, { ls: { "gca.settings": JSON.stringify({ timezone: "America/Los_Angeles", tzExplicit: true }) } });
      await search(page, "export");
      let dlP = page.waitForEvent("download");
      await page.locator("#f-export").click();
      expect((await dlP).suggestedFilename()).toBe("search-results-2025-05-01.txt");

      await page.locator('.nav-item[data-view="timeline"]').click();
      const msg = page.locator("#view-timeline .msg", { hasText: "export me 1" }).first();
      await msg.hover();
      await msg.locator(".act-pin").click();
      await page.locator('.nav-item[data-view="pins"]').click();
      dlP = page.waitForEvent("download");
      await page.locator("#pins-export").click();
      expect((await dlP).suggestedFilename()).toBe("pinned-messages-2025-05-01.txt");
    });
  });
});
