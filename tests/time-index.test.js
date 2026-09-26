// UX-4 / AN-13: GCAShared.buildTimeIndex(msgs, clock) is the pure core of the
// viewer's per-conversation time index (app.js timeIndex() memoizes it per
// conversation + zone). Every analytics bucket reads it, so each field must
// agree with Intl.DateTimeFormat in the same zone — the pre-SP3 source of truth
// — including across DST transition days.

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const { buildTimeIndex, createZoneClock } = require("../src/shared-core.js");

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FMT = new Map();
function intlParts(tz, t) {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", Object.assign(tz === "local" ? {} : { timeZone: tz }, {
      weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }));
    FMT.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  const y = +p.year, mo = +p.month - 1, d = +p.day;
  return {
    year: y, month: mo, mday: d, hour: +p.hour === 24 ? 0 : +p.hour, minute: +p.minute, dow: WD[p.weekday],
    day: Math.floor(Date.UTC(y, mo, d) / 86400000), monthKey: y * 12 + mo,
  };
}

// A sweep over 2019-2025 plus every 7 minutes across the 2024 US and EU DST
// change days (both directions), newest-last like a real conversation.
function messages() {
  const ts = [];
  for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2025, 6, 1); t += 21613457) ts.push(t);
  for (const day of ["2024-03-10", "2024-11-03", "2024-03-31", "2024-10-27", "2024-04-07", "2024-10-06"]) {
    const d0 = Date.parse(day + "T00:00:00Z");
    for (let t = d0 - 86400000; t < d0 + 2 * 86400000; t += 420000) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  return ts.map((t, k) => ({ i: "m" + k, s: "u1", t, x: "" }));
}

const FIELDS = ["day", "year", "month", "mday", "hour", "minute", "dow", "monthKey"];
for (const tz of ["UTC", "America/New_York", "Europe/London", "Australia/Sydney", "Asia/Kathmandu", "local"]) {
  test("buildTimeIndex(" + tz + ") matches Intl field by field, DST days included", () => {
    const msgs = messages();
    const TI = buildTimeIndex(msgs, createZoneClock(tz));
    assert.equal(TI.n, msgs.length);
    for (const f of FIELDS) assert.equal(TI[f].length, msgs.length, f);
    for (let i = 0; i < msgs.length; i++) {
      const want = intlParts(tz, msgs[i].t);
      for (const f of FIELDS) {
        if (TI[f][i] !== want[f]) {
          assert.fail(tz + " " + f + " at " + new Date(msgs[i].t).toISOString() + ": " + TI[f][i] + " !== " + want[f]);
        }
      }
    }
  });
}

test("buildTimeIndex is pure: no globals, empty input, typed arrays", () => {
  const TI = buildTimeIndex([], createZoneClock("UTC"));
  assert.equal(TI.n, 0);
  assert.ok(TI.day instanceof Int32Array && TI.year instanceof Uint16Array && TI.monthKey instanceof Int32Array);
});

// SP3 review: a corrupt/outlier timestamp (year 275760, before 1900, NaN, not a
// number) must not wrap the Uint16 year, throw inside the zone clock, or blow
// the dense per-day span timeAgg() allocates. buildTimeIndex clamps the instant
// it buckets to [1900-01-01, 2199-12-31] (the message keeps its own t).
test("buildTimeIndex clamps outlier timestamps into a sane range", () => {
  const LO = Date.UTC(1900, 0, 1), HI = Date.UTC(2200, 0, 1) - 1;
  const bad = [8.64e15, -8.64e15, NaN, undefined, "2024", Infinity, Date.UTC(2024, 5, 1)];
  for (const tz of ["UTC", "America/New_York", "local"]) {
    const TI = buildTimeIndex(bad.map((t, k) => ({ i: "b" + k, t })), createZoneClock(tz));
    for (let i = 0; i < bad.length; i++) {
      assert.ok(TI.year[i] >= 1899 && TI.year[i] <= 2200, tz + " year " + TI.year[i] + " for " + bad[i]);
      assert.ok(TI.day[i] >= Math.floor(LO / 86400000) - 1 && TI.day[i] <= Math.floor(HI / 86400000) + 1, tz + " day for " + bad[i]);
      assert.ok(TI.hour[i] < 24 && TI.minute[i] < 60 && TI.month[i] < 12 && TI.dow[i] < 7, tz + " fields for " + bad[i]);
    }
    assert.equal(TI.year[0] >= 2199, true, "far future clamps to the top");
    assert.equal(TI.year[1] <= 1900, true, "far past clamps to the bottom");
    assert.equal(TI.year[6], 2024, "a normal timestamp is untouched");
  }
});
