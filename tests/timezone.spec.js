const { test, expect } = require("@playwright/test");

// P1-2: analytics buckets and date filters must be computed in the configured
// Timezone setting, not browser-local time — and each bucket must agree with the
// timestamp label shown on screen for the same message.
//
// The worker browser runs in America/New_York (below) so "browser-local" is
// deterministic and DIFFERENT from UTC; a UTC host would otherwise mask the bug.
test.use({ timezoneId: "America/New_York" });

// One message at 2024-01-01 02:00 UTC. That instant is:
//   UTC              -> Jan 1, 2024  (bucket day 2024-01-01, year 2024)
//   America/New_York -> Dec 31, 2023 21:00 (bucket day 2023-12-31, year 2023)
// A second, far-earlier message gives Wrapped/Stats a 2nd year so year chips and
// the "busiest day" comparison are non-trivial.
const BOUNDARY = Date.UTC(2024, 0, 1, 2, 0); // 2024-01-01T02:00:00Z
const DATA = {
  __sample: true,
  conversations: [
    {
      id: "G", type: "group", title: "TZ", participants: ["u1"], count: 3,
      msgs: [
        { i: "m0", s: "u1", t: Date.UTC(2022, 5, 15, 12, 0), x: "older message" },
        { i: "m1", s: "u1", t: BOUNDARY, x: "boundary message" },
        // A 2nd message on the SAME boundary day (2024-01-01 UTC / 2023-12-31 NY),
        // so the boundary day is unambiguously the busiest single day (2 vs 1).
        { i: "m2", s: "u1", t: Date.UTC(2024, 0, 1, 3, 0), x: "sibling message" },
      ],
      events: [],
    },
  ],
};

async function boot(page, timezone) {
  await page.addInitScript((tz) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    localStorage.setItem("gca.settings", JSON.stringify({ timezone: tz }));
  }, timezone);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

test("UTC setting: boundary message buckets to 2024-01-01 and label agrees", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page, "UTC");

  // Label: the boundary message's rendered timestamp shows Jan 1, 2024.
  const boundaryMsg = page.locator(".msg", { hasText: "boundary message" });
  await expect(boundaryMsg.locator(".msg-time")).toContainText("Jan 1, 2024");

  // Stats bucket: the two boundary-day messages make 2024-01-01 the busiest day.
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats .section-h", { hasText: "busiest day" })).toContainText("2024-01-01");
  // Milestone busiest-day LABEL (DAY.format of the day key) must agree with the
  // bucket — this exercises the dayKey -> zone-correct-instant round trip.
  await expect(page.locator("#view-stats .mile", { hasText: "Busiest single day" })).toContainText("January 1, 2024");

  // Wrapped bucket: 2024 is one of the year chips (boundary counted in 2024).
  await page.locator('.nav-item[data-view="wrapped"]').click();
  await expect(page.locator(".wr-yr[data-yr=\"2024\"]")).toBeVisible();

  expect(errors).toEqual([]);
});

test("America/New_York setting: boundary message buckets to 2023-12-31 and label agrees", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page, "America/New_York");

  const boundaryMsg = page.locator(".msg", { hasText: "boundary message" });
  await expect(boundaryMsg.locator(".msg-time")).toContainText("Dec 31, 2023");

  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats .section-h", { hasText: "busiest day" })).toContainText("2023-12-31");
  await expect(page.locator("#view-stats .mile", { hasText: "Busiest single day" })).toContainText("December 31, 2023");

  // Wrapped: the boundary is counted in 2023, NOT 2024. In NY the two messages
  // are 2022 and 2023, so there is no 2024 chip at all.
  await page.locator('.nav-item[data-view="wrapped"]').click();
  await expect(page.locator(".wr-yr[data-yr=\"2023\"]")).toBeVisible();
  await expect(page.locator(".wr-yr[data-yr=\"2024\"]")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("date-range search filters in the configured zone (UTC includes the boundary)", async ({ page }) => {
  // In UTC, after:2024-01-01 starts at 2024-01-01T00:00Z; the boundary is at
  // 02:00Z, so it is INCLUDED. The older 2022 message is excluded. -> 1 result.
  await boot(page, "UTC");
  await page.locator('.nav-item[data-view="search"]').click();
  await page.locator("#s-input").fill("message after:2024-01-01");
  await expect(page.locator("#s-meta")).toContainText("2 messages found");
  await expect(page.locator("#s-list .msg", { hasText: "boundary message" })).toBeVisible();
  await expect(page.locator("#s-list .msg", { hasText: "older message" })).toHaveCount(0);
});

test("date-range search: America/New_York excludes the boundary from after:2024-01-01", async ({ page }) => {
  // In NY the boundary instant is Dec 31 2023 21:00, and after:2024-01-01 starts
  // at 2024-01-01T00:00 New York, so the boundary is EXCLUDED. Both messages
  // fall before the range -> 0 results.
  await boot(page, "America/New_York");
  await page.locator('.nav-item[data-view="search"]').click();
  await page.locator("#s-input").fill("message after:2024-01-01");
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
  await expect(page.locator("#s-list .msg", { hasText: "boundary message" })).toHaveCount(0);
});
