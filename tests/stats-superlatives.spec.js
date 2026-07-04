const { test, expect } = require("@playwright/test");

// P2-5: monologuer badge must fire at exactly 5 consecutive messages from the
// same sender (counting the first message of the run), not 6. u1 sends a run
// of exactly 5 in a row (msgs 1-5), then u2 sends a run of exactly 4 (msgs
// 6-9). Only u1 should ever earn "The Monologuer".
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Runs", participants: ["u1", "u2"], count: 9,
      msgs: [
        { i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "one" },
        { i: "m2", s: "u1", t: Date.parse("2020-01-01T10:01:00Z"), x: "two" },
        { i: "m3", s: "u1", t: Date.parse("2020-01-01T10:02:00Z"), x: "three" },
        { i: "m4", s: "u1", t: Date.parse("2020-01-01T10:03:00Z"), x: "four" },
        { i: "m5", s: "u1", t: Date.parse("2020-01-01T10:04:00Z"), x: "five" },
        { i: "m6", s: "u2", t: Date.parse("2020-01-01T10:05:00Z"), x: "a" },
        { i: "m7", s: "u2", t: Date.parse("2020-01-01T10:06:00Z"), x: "b" },
        { i: "m8", s: "u2", t: Date.parse("2020-01-01T10:07:00Z"), x: "c" },
        { i: "m9", s: "u2", t: Date.parse("2020-01-01T10:08:00Z"), x: "d" },
      ], events: [] },
  ],
};

async function routeData(page) {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
}

test("monologuer badge fires for a run of exactly 5, not for a run of 4", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await routeData(page);
  await page.goto("/");

  await page.locator('.nav-item[data-view="stats"]').click();

  const monologuerCard = page.locator(".card", { hasText: "The Monologuer" });
  await expect(monologuerCard).toHaveCount(1);
  // Winner is u1 (the run-of-5 sender), never u2 (run-of-4 only).
  await expect(monologuerCard).toContainText("1 x 5+ msgs in a row");

  expect(errors).toEqual([]);
});
