const { test, expect } = require("@playwright/test");

// SP3 Stats rendering:
//  - the heavy, text-derived sections (superlatives, latency/pairings, yapping,
//    double-text, generosity, vocab, platforms, emojis, word cloud) are filled
//    AFTER the first paint — the hero, milestones, per-person bars and the four
//    time charts are there synchronously, the rest follows in time-sliced tasks
//    and #view-stats gets data-ready="1" once complete;
//  - a re-render keeps the keyword-trend word the user graphed (it used to reset
//    to "lol" and blank the input on every render);
//  - a conversation switch while Stats is hidden neither renders Stats nor
//    leaves the previous conversation's Stats DOM behind.

const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1", "u2"], count: 4,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-01-01T10:00:00Z"), x: "good morning alpha crew" },
        { i: "a2", s: "u2", t: Date.parse("2024-01-01T10:05:00Z"), x: "lol thanks for the reminder" },
        { i: "a3", s: "u1", t: Date.parse("2024-01-02T22:00:00Z"), x: "did anyone see this? 😂", r: [{ s: "u2", k: "funny" }] },
        { i: "a4", s: "u2", t: Date.parse("2024-02-03T09:00:00Z"), x: "great stuff honestly, beta test tomorrow" },
      ], events: [] },
    { id: "B", type: "group", title: "Beta", participants: ["u3"], count: 2,
      msgs: [
        { i: "b1", s: "u3", t: Date.parse("2024-02-01T10:00:00Z"), x: "beta says hello" },
        { i: "b2", s: "u3", t: Date.parse("2024-02-02T11:00:00Z"), x: "beta says goodbye!" },
      ], events: [] },
  ],
};

async function boot(page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    localStorage.setItem("gca.conv", "A");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

const pickConv = (page, id) => page.evaluate((cid) => {
  const s = document.getElementById("conv-select");
  s.value = cid; s.dispatchEvent(new Event("change"));
}, id);

test("Stats paints the overview first and fills the heavy sections after", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page);
  // Synchronously after the click: overview + charts present, heavy sections pending.
  const sync = await page.evaluate(() => {
    document.querySelector('.nav-item[data-view="stats"]').click();
    const v = document.getElementById("view-stats");
    return {
      hero: !!v.querySelector(".h-num"),
      bars: v.querySelectorAll(".bar-clickable").length,
      months: !!v.querySelector("#chart-months"),
      trend: !!v.querySelector("#chart-trends"),
      supers: v.querySelectorAll(".card.super").length,
      ready: v.dataset.ready || "",
    };
  });
  expect(sync).toEqual({ hero: true, bars: 2, months: true, trend: true, supers: 0, ready: "" });
  // …then the deferred stage completes on its own.
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#view-stats .card.super").first()).toBeVisible();
  await expect(page.locator("#view-stats #words .cloud-word").first()).toBeVisible();
  await expect(page.locator("#view-stats #top-emojis .word")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a Stats re-render keeps the graphed keyword-trend word", async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-view="stats"]').click();
  await page.locator("#trend-input").fill("beta");
  await page.locator("#trend-input").press("Enter");
  const label = () => page.evaluate(() => {
    const c = window.Chart.getChart(document.getElementById("chart-trends"));
    return c ? c.data.datasets[0].label : null;
  });
  await expect.poll(label).toBe('"beta" frequency');
  // Revisit (re-render) — the word and the chart survive.
  await page.locator('.nav-item[data-view="timeline"]').click();
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#trend-input")).toHaveValue("beta");
  await expect.poll(label).toBe('"beta" frequency');
});

test("switching conversation while Stats is hidden leaves no stale Stats DOM", async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats .h-num")).toHaveAttribute("data-count", "4");
  await page.locator('.nav-item[data-view="timeline"]').click();
  await pickConv(page, "B");
  // Not rendered for B while hidden, and A's numbers are gone.
  await expect(page.locator("#view-stats .h-num")).toHaveCount(0);
  await page.locator('.nav-item[data-view="stats"]').click();
  await expect(page.locator("#view-stats .h-num")).toHaveAttribute("data-count", "2");
  await expect(page.locator("#view-stats")).toHaveAttribute("data-ready", "1");
});
