const { test, expect } = require("@playwright/test");

// Two people. Participant 1111 owns the first two messages; participant 8888's
// first message is at index 2 — deliberately NOT the global first message — so
// "Go to 8888's first message" must land on index 2, not 0.
const DATA = {
  __sample: true,
  conversations: [{
    id: "G1", type: "group", title: "Jump Group", participants: ["1111", "8888"], count: 5,
    msgs: [
      { i: "m1", s: "1111", t: Date.parse("2020-05-01T10:00:00Z"), x: "alpha one" },
      { i: "m2", s: "1111", t: Date.parse("2020-05-01T10:01:00Z"), x: "alpha two" },
      { i: "m3", s: "8888", t: Date.parse("2020-05-01T10:02:00Z"), x: "bravo first unique" },
      { i: "m4", s: "8888", t: Date.parse("2020-05-01T10:03:00Z"), x: "bravo two" },
      { i: "m5", s: "1111", t: Date.parse("2020-05-01T10:04:00Z"), x: "alpha three" },
    ],
    events: [],
  }],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_NAMES = { "8888": "Bravo" };' }));
});

test("'Go to <person>'s first message' lands on that person's first message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("Bravo");
  // SP9 (UX-8): the palette also lists message hits and a "Search messages
  // for …" row, so pick the person row by its own label.
  await page.locator(".cmdk-row", { hasText: "Go to Bravo" }).click();

  // The timeline anchors (flashes) the jumped-to message. It must be 8888's
  // first message at index 2 — not the global first message at index 0.
  const target = page.locator('#tl-list [data-idx="2"]');
  await expect(target).toHaveClass(/flash/);
  await expect(target).toContainText("bravo first unique");
});
