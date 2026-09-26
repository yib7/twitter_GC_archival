const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// VC-13: renderChunk() started prevDay / prevSenderId / prevTimestamp fresh for
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

test("VC-13: one day spanning several chunks gets one day pill and unbroken sender runs", async ({ page }) => {
  // 150 messages from one sender, 1 minute apart, all on Sunday March 10 (UTC).
  const DATA = { conversations: [conv("A", "Alpha", msgs("a", 150, { s: ["u1"], t0: T0 }))] };
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC" }) } });
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

test("VC-13: a new day that starts exactly at a chunk boundary still gets its in-flow pill", async ({ page }) => {
  const day1 = msgs("d", 50, { s: ["u1"], t0: T0 });
  const day2 = msgs("e", 30, { s: ["u1"], t0: T0 + 86400000 });
  await bootViewer(page, { conversations: [conv("A", "Alpha", [...day1, ...day2])] }, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC" }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  const c = await chunks(page, 2);
  expect(c[1].inFlowPills).toEqual(["Monday, March 11, 2024"]);
  expect(c[1].contPills).toEqual([]);
  expect(c[1].firstMsgConsecutive).toBe(false);
});

test("VC-13: an event closing the previous chunk breaks the sender run", async ({ page }) => {
  const list = msgs("a", 80, { s: ["u1"], t0: T0 });
  // Event at the same instant as message 49 (last of chunk 0) -> bucketed into chunk 0, after it.
  const events = [{ type: "join", s: "u1", ids: ["u2"], t: list[49].t }];
  await bootViewer(page, { conversations: [conv("A", "Alpha", list, { events })] }, { ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ timezone: "UTC" }) } });
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  const c = await chunks(page, 2);
  expect(c[1].firstMsgConsecutive).toBe(false);
  expect(c[1].inFlowPills).toEqual([]);
});
