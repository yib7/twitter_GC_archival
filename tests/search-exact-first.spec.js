const { test, expect } = require("@playwright/test");

// VC-18 (SP3): Fuzzy mode is exact-first. A query with literal hits shows just
// those (newest first) plus a "close matches" button that opts into the
// typo-tolerant Fuse ranking for THAT query; a query with no literal hit falls
// back to fuzzy automatically and says so. Exact mode stays literal-only.

const DATA = {
  __sample: true,
  conversations: [{
    id: "G", type: "group", title: "Ops", participants: ["u1", "u2"], count: 5,
    msgs: [
      { i: "m1", s: "u1", t: Date.parse("2024-03-01T10:00:00Z"), x: "movie night tonight?" },
      { i: "m2", s: "u2", t: Date.parse("2024-03-02T10:00:00Z"), x: "movie nite at mine" },
      { i: "m3", s: "u1", t: Date.parse("2024-03-03T10:00:00Z"), x: "banana bread for everyone" },
      { i: "m4", s: "u2", t: Date.parse("2024-03-04T10:00:00Z"), x: "the refrigerator hums" },
      { i: "m5", s: "u1", t: Date.parse("2024-03-05T10:00:00Z"), x: "unrelated chatter" },
    ],
    events: [],
  }],
};

async function boot(page, data) {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(data || DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-input")).toBeVisible();
}

// Type a query and wait until the search has actually re-run (QA-15 data-gen).
async function search(page, q) {
  const gen = await page.locator("#s-meta").getAttribute("data-gen");
  await page.locator("#s-input").fill(q);
  await expect(page.locator("#s-meta")).not.toHaveAttribute("data-gen", gen || "");
}

test("fuzzy mode shows literal hits first and offers close matches on demand", async ({ page }) => {
  await boot(page);
  await search(page, "movie night");
  // Only the literal hit — not the near-miss "movie nite".
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await expect(page.locator("#s-list .msg")).toContainText("movie night tonight");
  await expect(page.locator("#s-meta")).toContainText("1 message found");
  const more = page.locator("#s-fuzzy-toggle");
  await expect(more).toHaveText(/close matches/i);

  // Opt in: Fuse ranking for this query — now the near miss is in too.
  await more.click();
  await expect(page.locator("#s-list .msg")).toHaveCount(2);
  await expect(page.locator("#s-meta")).toContainText("sorted by relevance");
  await expect(page.locator("#s-fuzzy-toggle")).toHaveText(/exact/i);

  // Back to exact-only for the same query.
  await page.locator("#s-fuzzy-toggle").click();
  await expect(page.locator("#s-list .msg")).toHaveCount(1);

  // The opt-in is per query: a new query is exact-first again.
  await more.click();
  await expect(page.locator("#s-list .msg")).toHaveCount(2);
  await search(page, "banana");
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await expect(page.locator("#s-fuzzy-toggle")).toHaveText(/close matches/i);
});

test("no literal hit → automatic fuzzy fallback, labelled as such", async ({ page }) => {
  await boot(page);
  await search(page, "refrigirator");
  await expect(page.locator("#s-meta")).toContainText(/No exact matches — 1 close match\b/);
  await expect(page.locator("#s-list .msg")).toContainText("refrigerator");
  // Nothing to opt into — the list already IS the close matches.
  await expect(page.locator("#s-fuzzy-toggle")).toHaveCount(0);
});

test("Exact mode never offers or runs fuzzy", async ({ page }) => {
  await boot(page);
  await page.locator('#f-matchtoggle button[data-mode="exact"]').click();
  await search(page, "movie night");
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await expect(page.locator("#s-fuzzy-toggle")).toHaveCount(0);
  await search(page, "refrigirator");
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
});

// SP3 review: "incl. close matches" must be literal hits PLUS Fuse's, not Fuse's
// alone — a literal AND-hit Fuse can't score (reordered words, >32-char
// patterns) used to vanish when the user opted in.
const REORDER = {
  __sample: true,
  conversations: [{
    id: "G", type: "group", title: "Ops", participants: ["u1", "u2"], count: 3,
    msgs: [
      { i: "r1", s: "u1", t: Date.parse("2024-03-01T10:00:00Z"), x: "the night we watched a movie outside" },
      { i: "r2", s: "u2", t: Date.parse("2024-03-02T10:00:00Z"), x: "movie nite at mine" },
      { i: "r3", s: "u1", t: Date.parse("2024-03-03T10:00:00Z"), x: "unrelated chatter" },
    ],
    events: [],
  }],
};
test("forced close matches keep every literal hit, literal first", async ({ page }) => {
  await boot(page, REORDER);
  await search(page, "movie night");
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await expect(page.locator("#s-list .msg")).toContainText("the night we watched a movie");
  await page.locator("#s-fuzzy-toggle").click();
  await expect(page.locator("#s-meta")).toContainText("incl. close matches");
  // The reordered literal hit stays (first), and the close match joins it.
  await expect(page.locator("#s-list .msg")).toHaveCount(2);
  await expect(page.locator("#s-list .msg").first()).toContainText("the night we watched a movie");
  await expect(page.locator("#s-list .msg").nth(1)).toContainText("movie nite");
});

// SP3 review: in Grid mode the fallback is decided on what the grid can show —
// literal hits that carry no media must not block the close media matches.
const GRID = {
  __sample: true,
  conversations: [{
    id: "G", type: "group", title: "Ops", participants: ["u1", "u2"], count: 3,
    msgs: [
      { i: "g1", s: "u1", t: Date.parse("2024-03-01T10:00:00Z"), x: "sunset was great" },
      { i: "g2", s: "u2", t: Date.parse("2024-03-02T10:00:00Z"), x: "sunzet pic", m: "sample_media/photo-1.svg", k: "img" },
      { i: "g3", s: "u1", t: Date.parse("2024-03-03T10:00:00Z"), x: "unrelated chatter" },
    ],
    events: [],
  }],
};
test("grid mode falls back to close media matches when the literal hits have no media", async ({ page }) => {
  await boot(page, GRID);
  await page.locator('#f-viewtoggle button[data-mode="grid"]').click();
  await search(page, "sunset");
  await expect(page.locator("#s-list .gcell")).toHaveCount(1);
  await expect(page.locator("#s-meta")).toContainText(/No exact media matches — 1 close media match\b/);
  await expect(page.locator("#s-list .empty")).toHaveCount(0);
  // List mode is still exact-first: the literal (text-only) hit.
  await page.locator('#f-viewtoggle button[data-mode="list"]').click();
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await expect(page.locator("#s-list .msg")).toContainText("sunset was great");
});
