const { test, expect } = require("@playwright/test");
const { bootViewer } = require("./_viewer-fixture.js");

// SP4 AN-18: the "On This Day" toast samples from EVERY same-day match — it
// picks a random past year first, then a random message of that year. It used
// to stop at the first 20 matches, so a chatty early year hid every later one.
test.use({ timezoneId: "UTC" });

const msgs = [];
for (let k = 0; k < 25; k++) msgs.push({ i: "a" + k, s: "u1", t: Date.parse("2020-05-10T08:00:00Z") + k * 60000, x: "early year message " + k });
msgs.push({ i: "b0", s: "u2", t: Date.parse("2021-05-10T09:00:00Z"), x: "the later year message" });
msgs.push({ i: "c0", s: "u2", t: Date.parse("2021-06-01T09:00:00Z"), x: "not on this day" });
const DATA = { conversations: [{ id: "G", type: "group", title: "OTD", participants: ["u1", "u2"], count: msgs.length, msgs, events: [] }] };

async function boot(page, r) {
  await page.clock.setFixedTime(new Date("2025-05-10T12:00:00Z"));
  await page.addInitScript((v) => { Math.random = () => v; }, r);
  await bootViewer(page, DATA);
}

test("a later year is reachable past the first 20 matches", async ({ page }) => {
  await boot(page, 0.99);
  const t = page.locator(".otd-toast");
  await expect(t).toBeVisible();
  await expect(t.locator(".otd-q")).toContainText("the later year message");
  await expect(t.locator(".otd-yr")).toHaveText("4 years ago");
});

test("the earliest year still shows, with a singular/plural age", async ({ page }) => {
  await boot(page, 0);
  const t = page.locator(".otd-toast");
  await expect(t.locator(".otd-q")).toContainText("early year message 0");
  await expect(t.locator(".otd-yr")).toHaveText("5 years ago");
});
