const { expect } = require("@playwright/test");

// Shared synthetic-data harness for the viewer specs (SP2). Routes a fixture
// in place of data.sample.js (always flagged __sample so the app treats it as
// the demo), blanks data.js, and optionally supplies a local.js. localStorage
// is seeded on the FIRST load of the page only, so specs that reload keep
// whatever the app itself persisted.
//
//   await bootViewer(page, DATA, { local: "window.LOCAL_NAMES = {...};", ls: { "gca.lastView": "timeline" } });
async function bootViewer(page, data, opts = {}) {
  await page.addInitScript((ls) => {
    try {
      if (sessionStorage.getItem("__gca_seeded")) return;
      sessionStorage.setItem("__gca_seeded", "1");
      localStorage.setItem("gca.onboarded", "1");
      localStorage.removeItem("gca.lastView");
      for (const k in ls) localStorage.setItem(k, ls[k]);
    } catch (e) { /* storage blocked — the spec is testing that */ }
  }, opts.ls || {});
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(Object.assign({ __sample: true }, data)) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: opts.local || "" }));
  if (opts.goto === false) return;
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();
  expect(await page.evaluate(() => window.CHAT_DATA && window.CHAT_DATA.__sample === true)).toBe(true);
}

// Minute-spaced messages: msgs("a", 10, { s: ["u1","u2"], t0, x: (k) => "..." })
function msgs(prefix, n, o = {}) {
  const senders = o.s || ["u1", "u2"];
  const t0 = o.t0 != null ? o.t0 : Date.parse("2024-03-10T12:00:00Z");
  const step = o.step != null ? o.step : 60000;
  const out = [];
  for (let k = 0; k < n; k++) {
    const m = { i: prefix + k, s: senders[k % senders.length], t: t0 + k * step, x: o.x ? o.x(k) : prefix + " text " + k };
    if (o.extra) Object.assign(m, o.extra(k) || {});
    out.push(m);
  }
  return out;
}

function conv(id, title, list, extra) {
  const parts = [...new Set(list.map((m) => m.s))];
  return Object.assign({ id, type: "group", title, participants: parts, count: list.length, msgs: list, events: [] }, extra || {});
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

// Wait until a search run has completed after `fn` (s-meta's data-gen bumps
// once per runSearch — see QA-15 in app.js).
async function afterSearchRun(page, fn) {
  const before = await page.locator("#s-meta").getAttribute("data-gen");
  await fn();
  await expect(page.locator("#s-meta")).not.toHaveAttribute("data-gen", before || "");
}

// Timeline reading position: scrollTop + index of the first message whose top
// is inside the scroller.
function timelineSnap(page) {
  return page.evaluate(() => {
    const s = document.getElementById("tl-scroll"); const sr = s.getBoundingClientRect();
    const vis = [...document.querySelectorAll("#view-timeline .msg")].filter((m) => { const r = m.getBoundingClientRect(); return r.top >= sr.top && r.top < sr.bottom; });
    return { scrollTop: Math.round(s.scrollTop), first: vis.length ? +vis[0].dataset.idx : null,
      heights: [...document.querySelectorAll("#tl-list .tl-chunk")].slice(0, 3).map((c) => c.getBoundingClientRect().height) };
  });
}
// Poll `read` until two consecutive reads agree (layout + virtualization have
// settled) and `ok(value)` holds; returns the settled value. Replaces fixed
// sleeps after a scroll / view switch.
async function settled(read, ok = () => true, same = (a, b) => JSON.stringify(a) === JSON.stringify(b)) {
  let prev, cur;
  await expect.poll(async () => {
    cur = await read();
    const done = prev !== undefined && same(prev, cur) && ok(cur);
    prev = cur;
    return done;
  }, { intervals: [50, 100, 100, 150, 200, 250], timeout: 10000 }).toBe(true);
  return cur;
}
const settledTimeline = (page) => settled(() => timelineSnap(page), (v) => v.first !== null, (a, b) => a.first === b.first && a.scrollTop === b.scrollTop);

module.exports = { bootViewer, msgs, conv, collectErrors, afterSearchRun, timelineSnap, settled, settledTimeline };
