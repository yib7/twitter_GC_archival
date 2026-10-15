const { test, expect } = require("@playwright/test");

// one corrupt/outlier timestamp (here the largest valid Date, year
// 275760) used to wrap the Uint16 year and make timeAgg() allocate a dense
// per-day array spanning ~100 million days. The time index now clamps the
// instant it buckets, so the analytics views still render and stay sane.
//
// this spec used to pin UTC, which hid that the zone clock
// (createZoneClock().offset) and zonedParts() were NOT clamped — in the
// browser's own zone or a named (Intl) zone the same instant threw a
// RangeError from updateBrand / the Stats hero. It now runs in four setups.
const SETUPS = [
  { name: "UTC", browserTz: "UTC", ls: {} },
  { name: "local default (New York browser)", browserTz: "America/New_York", ls: {} },
  { name: "explicit America/New_York (Tokyo browser)", browserTz: "Asia/Tokyo", ls: { "gca.settings": JSON.stringify({ timezone: "America/New_York", tzExplicit: true }) } },
  { name: "explicit Asia/Tokyo (UTC browser)", browserTz: "UTC", ls: { "gca.settings": JSON.stringify({ timezone: "Asia/Tokyo", tzExplicit: true }) } },
];

const msgs = [];
for (let k = 0; k < 30; k++) msgs.push({ i: "m" + k, s: k % 2 ? "u1" : "u2", t: Date.UTC(2024, 0, 1 + k, 12), x: "hello number " + k });
msgs.push({ i: "bad", s: "u1", t: 8.64e15, x: "a message from the far future" });
const DATA = { __sample: true, conversations: [{ id: "G", type: "group", title: "Outlier", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };

for (const S of SETUPS) {
  test.describe(S.name, () => {
    test.use({ timezoneId: S.browserTz });

    test("an absurd timestamp does not break Stats, Wrapped or the sidebar", async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.addInitScript((ls) => {
        localStorage.setItem("gca.onboarded", "1"); localStorage.removeItem("gca.lastView");
        for (const k in ls) localStorage.setItem(k, ls[k]);
      }, S.ls);
      await page.route("**/data.sample.js", (r) => r.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
      await page.route("**/data.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
      await page.route("**/local.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
      await page.goto("/");
      await expect(page.locator("#app")).toBeVisible();
      // The sidebar footer's year range is formatted through zonedParts() — the
      // outlier lands in the clamp year, never NaN / 275760. The clamp is on the
      // UTC instant (2199-12-31T23:59:59.999Z), so a zone east of UTC shows its
      // wall clock in 2200 — the same year buildTimeIndex gives it.
      await expect(page.locator("#sidebar-foot-text")).toContainText(/2024–(2199|2200) /);

      // Stats: timeAgg()'s per-day array spans the index's (clamped) day range —
      // ~64k days at most here, not the ~100 million a raw year-275760 instant
      // would size it to (hundreds of MB, seconds of work).
      const statsMs = await page.evaluate(async () => {
        const t0 = performance.now();
        document.querySelector('.nav-item[data-view="stats"]').click();
        while (document.getElementById("view-stats").dataset.ready !== "1" && performance.now() - t0 < 20000) {
          await new Promise((r) => setTimeout(r, 10));
        }
        return performance.now() - t0;
      });
      console.log("[time-outlier] " + S.name + " stats ms", Math.round(statsMs));
      await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
      await expect(page.locator("#view-stats .h-num")).toHaveAttribute("data-count", "31");
      expect(statsMs).toBeLessThan(3000);

      // Wrapped years come from the index: the outlier sits in the clamp year,
      // never in a wrapped-around Uint16 year (275760 % 65536 = 13616).
      await page.locator('.nav-item[data-view="wrapped"]').click();
      await expect(page.locator(".wr-yr").first()).toBeVisible();
      const yrs = await page.locator(".wr-yr[data-yr]").evaluateAll((els) => els.map((e) => e.dataset.yr));
      expect(yrs).toContain("2024");
      expect(yrs).not.toContain("13616");
      for (const y of yrs) expect(Number(y)).toBeLessThanOrEqual(2200);
      expect(errors).toEqual([]);
    });
  });
}
