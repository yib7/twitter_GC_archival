const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// renderChunk() started prevDay / prevSenderId / prevTimestamp fresh for
// every 50-message chunk, so a single busy day showed its "Sunday, March 10"
// pill again at every chunk boundary (20x for a 1,000-message day) and the
// first message of each chunk re-showed avatar + name mid-run. The state is
// now seeded from the previous message; a chunk that continues a day only gets
// a zero-height, aria-hidden "continuation" pill so the sticky day header
// still shows while reading it (chunks are contain:paint, so a sticky pill
// cannot outlive its own chunk).
const T0 = Date.parse("2024-03-10T08:00:00Z");

async function chunks(page, n = 3) {
  const out = [];
  for (let k = 0; k < n; k++) {
    // Bring chunk k into view so the virtualizer renders it, then read it.
    await page.locator('.tl-chunk[data-c="' + k + '"]').evaluate((c) => { document.getElementById("tl-scroll").scrollTop = c.offsetTop; });
    await expect(page.locator('.tl-chunk[data-c="' + k + '"] .msg').first()).toBeAttached();
    out.push(await page.locator('.tl-chunk[data-c="' + k + '"]').evaluate((c) => ({
      rendered: !!c.firstElementChild,
      inFlowPills: [...c.querySelectorAll(".daysep:not(.cont)")].map((p) => p.textContent.trim()),
      contPills: [...c.querySelectorAll(".daysep.cont")].map((p) => ({ text: p.textContent.trim(), h: p.getBoundingClientRect().height, hidden: p.getAttribute("aria-hidden") })),
      firstMsgConsecutive: c.querySelector(".msg").classList.contains("consecutive"),
    })));
  }
  return out;
}

test("one day spanning several chunks gets one day pill and unbroken sender runs", async ({ page }) => {
  // 150 messages from one sender, 1 minute apart, all on Sunday March 10 (UTC).
  const DATA = { conversations: [conv("A", "Alpha", msgs("a", 150, { s: ["u1"], t0: T0 }))] };
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  const c = await chunks(page);
  expect(c.every((x) => x.rendered)).toBe(true);
  expect(c[0].inFlowPills).toEqual(["Sunday, March 10, 2024"]);
  expect(c[1].inFlowPills).toEqual([]);
  expect(c[2].inFlowPills).toEqual([]);
  // continuation pills: sticky-only, take no layout space, hidden from AT
  for (const k of [1, 2]) {
    expect(c[k].contPills).toHaveLength(1);
    expect(c[k].contPills[0].text).toBe("Sunday, March 10, 2024");
    expect(c[k].contPills[0].h).toBe(0);
    expect(c[k].contPills[0].hidden).toBe("true");
    expect(c[k].firstMsgConsecutive, "chunk " + k + " first message continues the run").toBe(true);
  }
});

test("a new day that starts exactly at a chunk boundary still gets its in-flow pill", async ({ page }) => {
  const day1 = msgs("d", 50, { s: ["u1"], t0: T0 });
  const day2 = msgs("e", 30, { s: ["u1"], t0: T0 + 86400000 });
  await bootViewer(page, { conversations: [conv("A", "Alpha", [...day1, ...day2])] }, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  const c = await chunks(page, 2);
  expect(c[1].inFlowPills).toEqual(["Monday, March 11, 2024"]);
  expect(c[1].contPills).toEqual([]);
  expect(c[1].firstMsgConsecutive).toBe(false);
});

test("an event closing the previous chunk breaks the sender run", async ({ page }) => {
  const list = msgs("a", 80, { s: ["u1"], t0: T0 });
  // Event at the same instant as message 49 (last of chunk 0) -> bucketed into chunk 0, after it.
  const events = [{ type: "join", s: "u1", ids: ["u2"], t: list[49].t }];
  await bootViewer(page, { conversations: [conv("A", "Alpha", list, { events })] }, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  const c = await chunks(page, 2);
  expect(c[1].firstMsgConsecutive).toBe(false);
  expect(c[1].inFlowPills).toEqual([]);
});

// Day pills are sticky siblings inside one chunk, so every day already
// scrolled past stayed stuck at the same spot under the current one and showed
// through its translucent background as a stack of ghost labels. Only the
// newest stuck pill may be visible there.
test("only one day pill shows at the sticky spot, with no ghost of earlier days under it", async ({ page }) => {
  // 40 messages, 4 per day over 10 days: all in the first chunk.
  const list = [];
  for (let d = 0; d < 10; d++) for (let k = 0; k < 4; k++)
    list.push({ i: "d" + d + "k" + k, s: k % 2 ? "u2" : "u1", t: T0 + d * 86400000 + k * 60000, x: "day " + d + " message " + k });
  await bootViewer(page, { conversations: [conv("A", "Alpha", list)] },
    { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC", tzExplicit: true }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  for (const day of [4, 7]) {
    // scroll so day `day`'s pill is stuck and earlier days are behind it
    await page.locator("#tl-list .msg", { hasText: "day " + day + " message 1" }).evaluate((m) => {
      const s = document.getElementById("tl-scroll");
      s.scrollTop += m.getBoundingClientRect().top - s.getBoundingClientRect().top - 60;
    });
    await expect.poll(() => page.evaluate(() => {
      // the sticky line: where the earliest pills of the chunk are pinned
      const s = document.getElementById("tl-scroll").getBoundingClientRect();
      const pills = [...document.querySelectorAll("#tl-list .daypill")].filter((p) => p.getBoundingClientRect().height);
      const line = Math.min(...pills.map((p) => p.getBoundingClientRect().top).filter((t) => t >= s.top));
      return pills.filter((p) => {
        const r = p.getBoundingClientRect(), cs = getComputedStyle(p);
        return Math.abs(r.top - line) < 2 && cs.visibility !== "hidden" && +cs.opacity > 0.01;
      }).map((p) => p.textContent.trim());
    })).toEqual([new Date(T0 + day * 86400000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })]);
  }
});
