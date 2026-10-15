const { test, expect } = require("@playwright/test");

// P1-1: renderChunk() only rendered a system event (create/name/join/leave) if
// its timestamp fell within [chunk's first msg t, chunk's last msg t]. Two
// classes of event never satisfy that for ANY chunk:
//  - create/name events, which fire at conversation-creation time, strictly
//    BEFORE the first message.
//  - an event whose t exactly equals a value shared by two adjacent chunks'
//    boundary messages (see below) used to satisfy BOTH chunks' inclusive
//    range and render twice.
// CHUNK_SIZE is 50, so 100 messages split into exactly two chunks. Message
// index 49 (last of chunk 0, sent by alice) and index 50 (first of chunk 1,
// sent by bob) share the exact same timestamp T — that tie is what used to
// let an event at T satisfy both chunks' [lo, hi] bounds.
const BASE = Date.parse("2024-01-01T00:00:00Z");
const TIE_T = BASE + 49 * 60000; // shared by msgs[49] (alice) and msgs[50] (bob)

function buildMsgs() {
  const msgs = [];
  for (let i = 0; i < 100; i++) {
    const sender = i < 50 ? "alice001" : "bobber002";
    const t = i === 50 ? TIE_T : BASE + i * 60000;
    msgs.push({ i: "m" + i, s: sender, t, x: (i < 50 ? "alice msg " : "bob msg ") + i });
  }
  return msgs;
}

const DATA = {
  __sample: true,
  conversations: [{
    id: "BND", type: "group", title: "raw boundary group",
    participants: ["alice001", "bobber002"], count: 100,
    msgs: buildMsgs(),
    events: [
      // Pre-first-message events: strictly before msgs[0].t (BASE).
      { t: BASE - 2000, type: "create", s: "alice001" },
      { t: BASE - 1000, type: "name", s: "alice001", name: "Boundary Test Group" },
      // Boundary-tie event: t === msgs[49].t === msgs[50].t. Actor "carol9999"
      // never sends a message; since SP4 (AN-14) a join-only member is still a
      // person (PARTS/GENERIC), named "User 3" — a stable, unique needle.
      { t: TIE_T, type: "join", ids: ["carol9999"] },
    ],
  }],
};

const LOCAL_NAMES = { alice001: "Alice", bobber002: "Bob" };

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.LOCAL_NAMES = " + JSON.stringify(LOCAL_NAMES) + ";" }));
});

test("timeline renders create/name system events that precede the first message", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.locator('.nav-item[data-view="timeline"]').click();
  // SP8: the Timeline opens at the newest message now; Home goes to the
  // oldest, where these events live.
  await expect(page.locator('#tl-list .msg[data-idx="99"]')).toBeVisible();
  await page.keyboard.press("Home");
  const chunk0 = page.locator('#tl-list [data-c="0"]');
  await expect(chunk0.locator(".msg").first()).toBeVisible();

  // Both fire before msgs[0].t — under the pre-fix envelope scan neither
  // chunk's [lo, hi] range ever includes them, so this is the RED assertion.
  await expect(chunk0.locator(".sysline", { hasText: "created the conversation" })).toBeVisible();
  await expect(chunk0.locator(".sysline", { hasText: "created the conversation" })).toContainText("Alice");
  await expect(chunk0.locator(".sysline", { hasText: "named the group" })).toContainText("Boundary Test Group");

  expect(errors).toEqual([]);
});

test("an event tied to a chunk boundary renders in exactly one chunk", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.locator('.nav-item[data-view="timeline"]').click();
  // SP8: the Timeline opens at the newest message now; Home goes to the
  // oldest, where these events live.
  await expect(page.locator('#tl-list .msg[data-idx="99"]')).toBeVisible();
  await page.keyboard.press("Home");
  const chunk0 = page.locator('#tl-list [data-c="0"]');
  await expect(chunk0.locator(".msg").first()).toBeVisible();

  // The "owning chunk = chunk of the first message at-or-after the event"
  // rule assigns TIE_T to chunk 0 (msgs[49] is the first message with
  // t >= TIE_T). It must appear here...
  await expect(chunk0.locator(".sysline", { hasText: "Added User 3" })).toBeVisible();

  // ...and force-render chunk 1 (bob's first message, index 50) via the same
  // "Go to <person>'s first message" command palette jump the app already
  // uses elsewhere, then confirm the same event was NOT also bucketed there.
  await page.keyboard.press("Control+K");
  await page.locator(".cmdk-input").fill("Bob");
  await page.locator(".cmdk-row", { hasText: "Go to Bob's first message" }).click();

  const chunk1 = page.locator('#tl-list [data-c="1"]');
  await expect(chunk1.locator(".msg").first()).toBeVisible();
  await expect(chunk1.locator(".sysline", { hasText: "Added User 3" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
