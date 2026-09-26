const { test, expect } = require("@playwright/test");

// P1-2: "The Laugh Track" and "The Hater" superlative cards never rendered
// because computeStats compared a reaction's *key* (e.g. "funny", "disagree")
// against emoji *glyphs* (e.g. "😂", "👎") that reaction records never carry
// (see scripts/build-core.js rawToRec and scripts/make_sample.js, both of
// which write `{k: reactionKey, s: senderId}`). The counters stayed at 0
// forever, so the render filter (`x.win.val > 0`) always dropped both cards.
// u2 gives the only "funny" reaction (to u1's message) and u1 gives the only
// "disagree" reaction (to u2's message), so the winners are unambiguous.
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Reacts", participants: ["u1", "u2"], count: 2,
      msgs: [
        { i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "one", r: [{ k: "funny", s: "u2" }] },
        { i: "m2", s: "u2", t: Date.parse("2020-01-01T10:01:00Z"), x: "two", r: [{ k: "disagree", s: "u1" }] },
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

test("Laugh Track and Hater superlative cards render when funny/disagree reactions exist", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await routeData(page);
  await page.goto("/");

  await page.locator('.nav-item[data-view="stats"]').click();

  const laughTrackCard = page.locator(".card", { hasText: "The Laugh Track" });
  await expect(laughTrackCard).toHaveCount(1);
  await expect(laughTrackCard).toContainText("1 laughing reaction given");

  const haterCard = page.locator(".card", { hasText: "The Hater" });
  await expect(haterCard).toHaveCount(1);
  await expect(haterCard).toContainText("1 👎/😡 reaction given");

  expect(errors).toEqual([]);
});
