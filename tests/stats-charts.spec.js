const { test, expect } = require("@playwright/test");
const { bootViewer, collectErrors } = require("./_viewer-fixture.js");

// SP4 AN-6: every month series is continuous — a silent month is a 0, not a
// missing point that makes Jan → Sep look like consecutive months (months
// chart, hero sparkline, sidebar sparkline, keyword trend).
test.use({ timezoneId: "UTC" });

const msgs = [];
let n = 0;
const push = (s, iso, x) => msgs.push({ i: "m" + ++n, s, t: Date.parse(iso), x });
for (let k = 0; k < 6; k++) push(k % 2 ? "u1" : "u2", "2023-01-1" + k + "T12:00:00Z", "lol january " + k);
for (let k = 0; k < 4; k++) push(k % 2 ? "u1" : "u2", "2023-09-0" + (k + 1) + "T12:00:00Z", "lol september " + k);
const DATA = { conversations: [{ id: "G", type: "group", title: "Gap", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };

const MONTHS = ["2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08", "2023-09"];

async function openStats(page) {
  await bootViewer(page, DATA);
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
}
const chart = (page, id, fn) => page.evaluate(([cid, f]) => {
  const c = window.Chart.getChart(document.getElementById(cid));
  return c ? (0, eval)(f)(c) : null;
}, [id, String(fn)]);

test("month series are zero-filled across silent months", async ({ page }) => {
  const errors = collectErrors(page);
  await openStats(page);
  expect(await chart(page, "chart-months", (c) => c.data.labels)).toEqual(MONTHS);
  expect(await chart(page, "chart-months", (c) => c.data.datasets[0].data)).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 4]);
  await expect.poll(() => chart(page, "chart-trends", (c) => c.data.labels)).toEqual(MONTHS);
  expect(await chart(page, "chart-trends", (c) => c.data.datasets[0].data)).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 4]);
  // Hero sparkline: one vertex per month.
  const d = await page.locator(".hero .spark svg path").nth(1).getAttribute("d");
  expect(d.match(/[ML]/g).length).toBe(9);
  // Sidebar sparkline too.
  await expect(page.locator("#sidebar-spark .spark")).toHaveAttribute("title", /9 months/);
  expect(await page.locator("#sidebar-spark polyline").getAttribute("points")).toMatch(/^(\S+ ){8}\S+$/);
  expect(errors).toEqual([]);
});
