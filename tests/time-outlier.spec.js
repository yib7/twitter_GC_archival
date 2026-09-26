const { test, expect } = require("@playwright/test");

// SP3 review: one corrupt/outlier timestamp (here the largest valid Date, year
// 275760) used to wrap the Uint16 year and make timeAgg() allocate a dense
// per-day array spanning ~100 million days. The time index now clamps the
// instant it buckets, so the analytics views still render and stay sane.
test.use({ timezoneId: "UTC" });

const msgs = [];
for (let k = 0; k < 30; k++) msgs.push({ i: "m" + k, s: k % 2 ? "u1" : "u2", t: Date.UTC(2024, 0, 1 + k, 12), x: "hello number " + k });
msgs.push({ i: "bad", s: "u1", t: 8.64e15, x: "a message from the far future" });
const DATA = { __sample: true, conversations: [{ id: "G", type: "group", title: "Outlier", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };

test("an absurd timestamp does not break Stats, Wrapped or the sidebar", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("gca.onboarded", "1"); localStorage.removeItem("gca.lastView"); });
  await page.route("**/data.sample.js", (r) => r.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();

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
  console.log("[time-outlier] stats ms", Math.round(statsMs));
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
  for (const y of yrs) expect(Number(y)).toBeLessThanOrEqual(2199);
  expect(errors).toEqual([]);
});
