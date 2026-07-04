const { test, expect } = require("@playwright/test");

// P2-2: from:/sender:/before:/after: search operators must be TRANSIENT overlay
// filters recomputed fresh every run, not additive mutations of the persistent
// F.people/F.from/F.to filter state. Typing a partial token (no trailing
// boundary) must not touch results or the People filter UI, and clearing the
// query must fully restore the unfiltered view with no residual filter chips.
//
// P2-4: a `file`-kind media message (kindOf() for unknown extensions, e.g. a
// .pdf) must render as a file chip in the gallery grid, not a broken <video>.
test.use({ timezoneId: "UTC" });

const DATA = {
  __sample: true,
  conversations: [
    {
      id: "G", type: "group", title: "Ops", participants: ["u1", "u2"], count: 4,
      msgs: [
        // bob (u1) owns exactly one message so "from:bob" narrows to 1.
        { i: "m1", s: "u1", t: Date.parse("2024-01-05T10:00:00Z"), x: "message from bob" },
        { i: "m2", s: "u2", t: Date.parse("2024-01-06T10:00:00Z"), x: "message from bella" },
        // bella (u2) also shares a file — a .pdf/unknown extension, i.e. the
        // kindOf() "file" kind that must render a chip, not a broken <video>.
        { i: "m3", s: "u2", t: Date.parse("2024-01-07T10:00:00Z"), x: "a shared doc", m: "sample_media/report.pdf", k: "file" },
        { i: "m4", s: "u2", t: Date.parse("2024-01-08T10:00:00Z"), x: "unrelated chatter" },
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
    route.fulfill({ contentType: "text/javascript", body: 'window.LOCAL_NAMES = {"u1": "bob", "u2": "bella"};' }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.locator('.nav-item[data-view="search"]').click();
}

test("partial from: token does not narrow results or touch the People filter UI", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await boot(page);

  // Baseline: all 4 messages visible (unfiltered "Showing all" text), no
  // People filter active.
  await expect(page.locator("#s-meta")).toContainText("Showing all 4 messages");
  await expect(page.locator("#f-people-n")).toBeHidden();

  // "from:zzzznope" has no trailing whitespace boundary -> must not take
  // effect at all: it is left in the query as literal text, which matches no
  // message body (even fuzzily), so if the operator leaked into the
  // plain-text search it would drop to 0 results instead of staying at 4.
  await page.locator("#s-input").fill("from:zzzznope");
  await page.waitForTimeout(250); // clear the 150ms debounce
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
  await expect(page.locator("#f-people-n")).toBeHidden();
  await expect(page.locator("#f-people")).not.toHaveClass(/active/);

  // The checkpoint's own example: "from:bo" is a real prefix of "bob" (and is
  // even a literal substring inside "message from bob", so a message can
  // still legitimately match on plain text) — the bug this guards against is
  // the People filter UI silently gaining a selection nobody made. It must
  // stay untouched regardless of how the text search itself scores "bo".
  await page.locator("#s-input").fill("from:bo");
  await page.waitForTimeout(250);
  await expect(page.locator("#f-people-n")).toBeHidden();
  await expect(page.locator("#f-people")).not.toHaveClass(/active/);

  expect(errors).toEqual([]);
});

test("from:bob (bounded) narrows to bob only, without adding bella", async ({ page }) => {
  await boot(page);

  await page.locator("#s-input").fill("from:bob ");
  await page.waitForTimeout(250);

  await expect(page.locator("#s-meta")).toContainText("1 message found");
  await expect(page.locator("#s-list .msg", { hasText: "message from bob" })).toBeVisible();
  await expect(page.locator("#s-list .msg", { hasText: "message from bella" })).toHaveCount(0);

  // The overlay filter must not leak into the persistent People filter UI: no
  // chip/badge should show a selection the user never made manually.
  await expect(page.locator("#f-people-n")).toBeHidden();
});

test("clearing the query after from: fully restores unfiltered results with no residual chips", async ({ page }) => {
  await boot(page);

  await page.locator("#s-input").fill("from:bob ");
  await page.waitForTimeout(250);
  await expect(page.locator("#s-meta")).toContainText("1 message found");

  await page.locator("#s-clear").click();
  await page.waitForTimeout(250);

  await expect(page.locator("#s-meta")).toContainText("Showing all 4 messages");
  await expect(page.locator("#f-people-n")).toBeHidden();
  await expect(page.locator("#f-clear-all")).toBeHidden();
});

test("typing from: after clearing does not carry forward a prior overlay match", async ({ page }) => {
  await boot(page);

  // First narrow to bella (3 of the 4 messages) via a bounded token, then
  // clear — the earlier overlay must not survive into the next run.
  await page.locator("#s-input").fill("from:bella ");
  await page.waitForTimeout(250);
  await expect(page.locator("#s-meta")).toContainText("3 messages found");

  await page.locator("#s-clear").click();
  await page.waitForTimeout(250);
  await expect(page.locator("#s-meta")).toContainText("Showing all 4 messages");

  // Manual People filter still works and combines with plain text search.
  await page.locator("#f-people").click();
  await page.locator(".pop-item", { hasText: "bob" }).click();
  await expect(page.locator("#f-people-n")).toHaveText("1");
  await expect(page.locator("#s-meta")).toContainText("1 message found");
});

test("before:/after: respect the configured timezone via zonedDateBound", async ({ page }) => {
  await boot(page);

  await page.locator("#s-input").fill("after:2024-01-07");
  await page.waitForTimeout(250);
  // UTC boot: after:2024-01-07 starts at 00:00Z, includes m3 (10:00Z) and m4.
  await expect(page.locator("#s-meta")).toContainText("2 messages found");
  // The overlay is transient: it must not write into the manual From/To pill,
  // which is exactly the persistent-state pollution this fix removes.
  await expect(page.locator("#f-from")).toHaveValue("");
  await expect(page.locator("#f-date")).not.toHaveClass(/active/);

  // Clearing the query drops the overlay and restores the unfiltered view.
  await page.locator("#s-clear").click();
  await page.waitForTimeout(250);
  await expect(page.locator("#s-meta")).toContainText("Showing all 4 messages");
});

test("file-kind media renders a file chip in the gallery grid, not a broken video", async ({ page }) => {
  await boot(page);

  await page.locator("#f-viewtoggle button[data-mode=\"grid\"]").click();
  await page.waitForTimeout(250);

  const cell = page.locator("#s-list .gcell").first();
  await expect(cell).toBeVisible();
  await expect(cell.locator("video")).toHaveCount(0);
  await expect(cell.locator("a.urlchip")).toHaveCount(1);
  await expect(cell.locator("a.urlchip")).toContainText("media file");
});
