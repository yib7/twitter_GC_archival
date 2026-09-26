const { test, expect } = require("@playwright/test");

// P2-5: monologuer badge must fire at exactly 5 consecutive messages from the
// same sender (counting the first message of the run), not 6. u1 sends a run
// of exactly 5 in a row, u2 a run of exactly 4; after that they alternate.
// Only u1 should ever earn "The Monologuer".
// SP4 (AN-7): the Monologuer is now a rate (runs of 5+ per 100 messages) that
// needs 20+ messages per person, so both send 20.
const seq = [].concat(Array(5).fill("u1"), Array(4).fill("u2"));
for (let k = 0; k < 15; k++) seq.push("u1", "u2");
seq.push("u2");
const T0 = Date.parse("2020-01-01T10:00:00Z");
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Runs", participants: ["u1", "u2"], count: seq.length,
      msgs: seq.map((s, k) => ({ i: "m" + k, s, t: T0 + k * 60000, x: "msg " + k })), events: [] },
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
  // Winner is u1 (the run-of-5 sender), never u2 (run-of-4 only): 1 run in 20 msgs.
  await expect(monologuerCard).toHaveAttribute("data-winners", "u1");
  await expect(monologuerCard).toContainText("5.0 runs of 5+ / 100 msgs");

  expect(errors).toEqual([]);
});
