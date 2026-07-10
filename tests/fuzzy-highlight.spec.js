const { test, expect } = require("@playwright/test");

// P2-6: fuzzy search results must be highlighted. The fuzzy branch matches via
// Fuse.js (typo-tolerant), but rendering highlighted only the LITERAL query
// terms — so a typo'd query that Fuse matched near-miss rendered with NO
// <mark> at all, exactly where the visual cue matters most. The fix threads
// Fuse's includeMatches ranges through to the renderer and wraps them in
// <mark>, while Exact mode keeps the existing literal-needle highlighting.
test.use({ timezoneId: "UTC" });

const DATA = {
  __sample: true,
  conversations: [
    {
      id: "G", type: "group", title: "Ops", participants: ["u1", "u2"], count: 3,
      msgs: [
        { i: "m1", s: "u1", t: Date.parse("2024-03-01T10:00:00Z"), x: "the refrigerator hums at night" },
        { i: "m2", s: "u2", t: Date.parse("2024-03-02T10:00:00Z"), x: "unrelated chatter" },
        { i: "m3", s: "u1", t: Date.parse("2024-03-03T10:00:00Z"), x: "banana bread for everyone" },
      ],
      events: [],
    },
  ],
};

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.LOCAL_NAMES = {};" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.locator('.nav-item[data-view="search"]').click();
}

test("fuzzy typo'd query renders the match AND highlights the matched word", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page);

  // 1-char typo: "refrigirator" is not a literal substring of any message, but
  // Fuse (threshold 0.3) matches "refrigerator". Fuzzy is the default mode.
  await page.locator("#s-input").fill("refrigirator");
  await page.waitForTimeout(250); // clear the 150ms debounce

  const hit = page.locator("#s-list .msg", { hasText: "refrigerator" });
  await expect(hit).toBeVisible();

  // The whole point of P2-6: the near-miss match must carry a visible <mark>
  // covering (at least part of) the matched word, not render bare.
  const marks = hit.locator(".bubble mark");
  await expect(marks.first()).toBeVisible();
  // Every mark sits inside the matched region — its text is a fragment of the
  // message, and at least one mark overlaps the word "refrigerator" itself.
  const texts = await marks.allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.some((t) => "refrigerator".includes(t.toLowerCase()) && t.length >= 2)).toBe(true);

  expect(errors).toEqual([]);
});

test("Exact mode literal highlighting is unchanged", async ({ page }) => {
  await boot(page);

  await page.locator('#f-matchtoggle button[data-mode="exact"]').click();
  await page.locator("#s-input").fill("refrigerator");
  await page.waitForTimeout(250);

  const hit = page.locator("#s-list .msg", { hasText: "refrigerator" });
  await expect(hit).toBeVisible();
  await expect(hit.locator(".bubble mark")).toHaveText(/refrigerator/i);

  // And a typo'd query in Exact mode matches nothing (no fuzzy leakage).
  await page.locator("#s-input").fill("refrigirator");
  await page.waitForTimeout(250);
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
});

test("fuzzy query with no plausible match renders no results", async ({ page }) => {
  await boot(page);

  await page.locator("#s-input").fill("zzqqxxplonk");
  await page.waitForTimeout(250);

  await expect(page.locator("#s-meta")).toContainText("0 messages found");
  await expect(page.locator("#s-list .msg")).toHaveCount(0);
  await expect(page.locator("#s-list .empty")).toBeVisible();
});
