const { test, expect } = require("@playwright/test");
const fs = require("fs");

// P2-5: settings.pins is one global list of message ids, but renderPins()
// resolved them only through ID2IDX — which rebuildIndexes() rebuilds for the
// ACTIVE conversation — so bookmarks made in other group chats silently
// vanished from the Pinned view (and its export). Message ids are globally
// unique (real builds keep the original X message id — scripts/build-core.js
// rawToRec; the sample generator shares one counter — scripts/make_sample.js),
// so the view must show EVERY conversation's bookmarks, grouped per chat with
// the active chat first, and clicking another chat's pin must switch to that
// conversation and jump to the message.
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1"], count: 3,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-01-01T10:00:00Z"), x: "alpha one" },
        { i: "a2", s: "u1", t: Date.parse("2024-01-02T10:00:00Z"), x: "alpha two keep this" },
        { i: "a3", s: "u1", t: Date.parse("2024-01-03T10:00:00Z"), x: "alpha three" },
      ], events: [] },
    { id: "B", type: "group", title: "Beta", participants: ["u2"], count: 2,
      msgs: [
        { i: "b1", s: "u2", t: Date.parse("2024-02-01T10:00:00Z"), x: "beta one keep this" },
        { i: "b2", s: "u2", t: Date.parse("2024-02-02T10:00:00Z"), x: "beta two" },
      ], events: [] },
  ],
};

async function boot(page, { savedConv } = {}) {
  await page.addInitScript((saved) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    if (saved) localStorage.setItem("gca.conv", saved);
  }, savedConv);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

// Bookmark a timeline message via the real ★ hover action.
async function pinFromTimeline(page, text) {
  await page.locator('.nav-item[data-view="timeline"]').click();
  const msg = page.locator("#view-timeline .msg", { hasText: text }).first();
  await msg.hover();
  const star = msg.locator(".act-pin");
  await star.click();
  await expect(star).toHaveClass(/on/);
}

// Pin one message in Alpha, one in Beta, ending with Beta active.
async function pinInBothChats(page) {
  await pinFromTimeline(page, "alpha two keep this");
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await pinFromTimeline(page, "beta one keep this");
}

test("Pinned view shows every chat's bookmarks grouped, active chat first", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { savedConv: "A" });
  await pinInBothChats(page);

  // Open Pinned while Beta is active: BOTH pins must be there, grouped under
  // per-conversation headers, with the active chat (Beta) first.
  await page.locator('.nav-item[data-view="pins"]').click();
  const heads = page.locator("#view-pins .pins-conv-head");
  await expect(heads).toHaveCount(2);
  await expect(heads.nth(0)).toContainText("Beta");
  await expect(heads.nth(1)).toContainText("Alpha");

  const rows = page.locator("#view-pins .msg");
  await expect(rows).toHaveCount(2);
  await expect(page.locator("#view-pins .msg", { hasText: "beta one keep this" })).toBeVisible();
  await expect(page.locator("#view-pins .msg", { hasText: "alpha two keep this" })).toBeVisible();

  // The count the header advertises must match what the view shows.
  await expect(page.locator("#view-pins .page-sub")).toContainText("2 bookmarked messages");

  // Clicking Alpha's pin from Beta activates Alpha and jumps to the message.
  await page.locator("#view-pins .msg", { hasText: "alpha two keep this" }).click();
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  await expect(page.locator("#conv-select")).toHaveValue("A");
  await expect(page.locator("#view-timeline")).toBeVisible();
  await expect(page.locator("#view-timeline .msg", { hasText: "alpha two keep this" }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("pins export includes every conversation's bookmarks, grouped per chat", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { savedConv: "A" });
  await pinInBothChats(page);

  await page.locator('.nav-item[data-view="pins"]').click();
  const dlPromise = page.waitForEvent("download");
  await page.locator("#pins-export").click();
  const dl = await dlPromise;
  const content = fs.readFileSync(await dl.path(), "utf8");

  // Grouped output: active chat's section first, both pins present.
  expect(content).toContain("== Beta ==");
  expect(content).toContain("== Alpha ==");
  expect(content.indexOf("== Beta ==")).toBeLessThan(content.indexOf("== Alpha =="));
  expect(content).toContain("beta one keep this");
  expect(content).toContain("alpha two keep this");

  expect(errors).toEqual([]);
});
