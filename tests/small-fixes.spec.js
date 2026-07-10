const { test, expect } = require("@playwright/test");
const fs = require("fs");

// Cycle-5 audit batch (P2-4, P2-7, P2-9, P2-10) — four small src/app.js fixes:
//  - P2-4: the Stats "busiest day" header showed the raw "YYYY-MM-DD" bucket
//    key instead of the zone-aware formatted date Milestones already uses.
//  - P2-7: plain-text exports (search results + pinned messages) emitted a
//    message body verbatim, so a multi-line body split one record across
//    several output lines.
//  - P2-9: the quote-card PNG always drew the initials disc even when the
//    person has an uploaded data: URL profile photo.
//  - P2-10: renderChains()'s gap-break left a stale `a`, so a >10-minute gap
//    inside one person's monologue could start a bogus "X & X" self-chain.

// 1x1 PNG, matches sanitizePhoto()'s PHOTO_RE — a legit uploaded pfp shape.
const PFP_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 18:00Z keeps every timestamp on the same calendar day for all zones between
// UTC-18 and UTC+5:59, so the busiest-day bucket is stable on CI machines.
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1", "u2"], count: 6,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-03-01T18:00:00Z"), x: "hello there friend" },
        { i: "a2", s: "u2", t: Date.parse("2024-03-02T18:00:00Z"), x: "movie night plan\nbring snacks\r\nand a blanket" },
        { i: "a3", s: "u1", t: Date.parse("2024-03-05T18:00:00Z"), x: "busy day one" },
        { i: "a4", s: "u2", t: Date.parse("2024-03-05T18:05:00Z"), x: "busy day two" },
        { i: "a5", s: "u1", t: Date.parse("2024-03-05T18:10:00Z"), x: "busy day three" },
        { i: "a6", s: "u1", t: Date.parse("2024-03-07T18:00:00Z"), x: "quote me please this one" },
      ], events: [] },
  ],
};

// P2-10 shape: one person, a >10-minute gap, then a quick monologue. The stale
// gap-break made person B resolve to person A again, and with a === b every
// message extended the "chain", so this used to render a bogus "X & X" chain.
const DATA_GAP = {
  __sample: true,
  conversations: [
    { id: "G", type: "group", title: "Gap", participants: ["u1", "u2"], count: 10,
      msgs: (() => {
        const base = Date.parse("2024-05-01T18:00:00Z");
        const msgs = [{ i: "g0", s: "u1", t: base, x: "before the gap" }];
        for (let n = 0; n < 9; n++) {
          msgs.push({ i: "g" + (n + 1), s: "u1", t: base + 20 * 60000 + n * 60000, x: "monologue " + n });
        }
        return msgs;
      })(), events: [] },
  ],
};

async function bootInjected(page, data, { pfps } = {}) {
  await page.addInitScript((p) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    if (p) localStorage.setItem("gca.pfps", JSON.stringify(p));
  }, pfps || null);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(data) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

// Boot on the real committed sample archive (data.sample.js untouched).
async function bootSample(page) {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  return errors;
}

/* ---- P2-4: busiest-day header is a formatted date, not the ISO key ------- */

test("stats busiest-day header shows the formatted date, not the raw ISO key", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA);

  await page.locator('.nav-item[data-view="stats"]').click();
  const head = page.locator(".section-h", { hasText: "busiest day" });
  await expect(head).toBeVisible();
  const txt = await head.innerText();

  // No raw "YYYY-MM-DD" bucket key…
  expect(txt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  // …but the same zone-aware long-form date Milestones uses (DAY formatter:
  // "Tuesday, March 5, 2024"), with the count intact. Case-insensitive: the
  // section header is uppercased by CSS text-transform.
  expect(txt).toMatch(/busiest day: [a-z]+day, March \d{1,2}, 2024 \(3 msgs\)/i);

  expect(errors).toEqual([]);
});

/* ---- P2-7: plain-text exports keep one record per line ------------------- */

test("search-results export flattens multi-line bodies to one line per record", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA);

  await page.locator("#s-input").fill("movie");
  await expect(page.locator("#s-meta")).toContainText(/message(s)? found/);

  const dlPromise = page.waitForEvent("download");
  await page.locator("#f-export").click();
  const dl = await dlPromise;
  const content = fs.readFileSync(await dl.path(), "utf8");

  const lines = content.split("\n").filter((l) => l.trim());
  // Every record line must carry the "DT | name: text" shape — a multi-line
  // body must never spill bare continuation lines into the file.
  for (const l of lines) expect(l).toMatch(/ \| .+: /);
  const rec = lines.find((l) => l.includes("movie night plan"));
  expect(rec).toBeTruthy();
  expect(rec).toContain("movie night plan bring snacks and a blanket");

  expect(errors).toEqual([]);
});

test("pins export flattens multi-line bodies to one line per record", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA);

  // Pin the multi-line message via the real ★ hover action.
  await page.locator('.nav-item[data-view="timeline"]').click();
  const msg = page.locator("#view-timeline .msg", { hasText: "movie night plan" }).first();
  await msg.hover();
  const star = msg.locator(".act-pin");
  await star.click();
  await expect(star).toHaveClass(/on/);

  await page.locator('.nav-item[data-view="pins"]').click();
  const dlPromise = page.waitForEvent("download");
  await page.locator("#pins-export").click();
  const dl = await dlPromise;
  const content = fs.readFileSync(await dl.path(), "utf8");

  // Grouped format: "== conv ==" headers plus one "DT | name: text" line per pin.
  const lines = content.split("\n").filter((l) => l.trim());
  for (const l of lines) expect(l).toMatch(/^== .+ ==$| \| .+: /);
  const rec = lines.find((l) => l.includes("movie night plan"));
  expect(rec).toBeTruthy();
  expect(rec).toContain("movie night plan bring snacks and a blanket");

  expect(errors).toEqual([]);
});

/* ---- P2-9: quote card exports a PNG with and without a data: pfp --------- */

async function exportQuote(page) {
  await page.locator('.nav-item[data-view="timeline"]').click();
  const msg = page.locator("#view-timeline .msg", { hasText: "quote me please" }).first();
  await msg.hover();
  const dlPromise = page.waitForEvent("download");
  await msg.getByRole("button", { name: "Quote" }).click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
  const stat = fs.statSync(await dl.path());
  expect(stat.size).toBeGreaterThan(0);
}

test("quote card exports a PNG when the sender has a data: URL pfp", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA, { pfps: { u1: PFP_DATA_URL } });
  await exportQuote(page);
  expect(errors).toEqual([]);
});

test("quote card still exports a PNG on the initials-disc path (no pfp)", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA);
  await exportQuote(page);
  expect(errors).toEqual([]);
});

/* ---- P2-10: reply-chain gap-break restarts the outer scan cleanly -------- */

test("a >10min gap inside a monologue does not start a bogus self-chain", async ({ page }) => {
  const errors = collectErrors(page);
  await bootInjected(page, DATA_GAP);

  await page.locator('.nav-item[data-view="chains"]').click();
  await expect(page.locator("#view-chains .page-sub")).toContainText("Found 0 chains");
  await expect(page.locator("#view-chains .chain-card")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("reply-chain count on the committed sample archive is unchanged", async ({ page }) => {
  const errors = collectErrors(page);
  await bootSample(page);

  await page.locator('.nav-item[data-view="chains"]').click();
  const sub = page.locator("#view-chains .page-sub");
  await expect(sub).toBeVisible();
  // Guard, not failing-first: value captured on the pre-fix build — the fix is
  // a latent-bug cleanup and must not change what the sample archive shows.
  await expect(sub).toContainText("Found 0 chains");
  // And no chain may ever pair a person with themselves.
  const names = await page.locator("#view-chains .chain-names").allInnerTexts();
  for (const n of names) {
    const [x, y] = n.split(" & ");
    expect(x).not.toBe(y);
  }

  expect(errors).toEqual([]);
});
