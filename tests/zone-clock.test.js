// UX-4 / AN-13: GCAShared.createZoneClock resolves a zone's UTC offset once per
// UTC day (instead of one Intl.formatToParts per message) and exactly on the
// transition days. Every analytics bucket in the viewer is built from it, so it
// must agree with Intl.DateTimeFormat — the old per-message source of truth —
// for every instant, including across DST changes, half-hour / 45-minute zones
// and zones whose offset changes by 30 minutes.

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const { createZoneClock } = require("../src/shared-core.js");

// Reference: wall-clock fields straight from Intl (the pre-SP3 zonedParts).
const FMT = new Map();
function intlWall(tz, t) {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", Object.assign(tz === "local" ? {} : { timeZone: tz }, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }));
    FMT.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  const h = +p.hour === 24 ? 0 : +p.hour;
  return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) + (((t % 1000) + 1000) % 1000);
}

const ZONES = ["UTC", "Etc/UTC", "America/New_York", "Europe/London", "Europe/Paris", "Australia/Sydney",
  "Australia/Lord_Howe", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns", "Pacific/Chatham", "America/Sao_Paulo", "local"];

// Deterministic instants: a sweep every ~7h13m17.123s over 2018-2026 (hits
// every hour/minute phase), plus every 15 minutes around each DST transition.
function instants() {
  const out = [];
  for (let t = Date.UTC(2018, 0, 1); t < Date.UTC(2026, 0, 1); t += 25997123) out.push(t);
  return out;
}

for (const tz of ZONES) {
  test("createZoneClock(" + tz + ") matches Intl for every instant", () => {
    const clock = createZoneClock(tz);
    const ts = instants();
    // Densely sample each transition day the sweep reveals.
    const dense = [];
    for (let k = 1; k < ts.length; k++) {
      if (intlWall(tz, ts[k]) - ts[k] !== intlWall(tz, ts[k - 1]) - ts[k - 1]) {
        for (let t = ts[k - 1]; t <= ts[k]; t += 900000) dense.push(t, t + 1, t - 1);
      }
    }
    let checked = 0;
    for (const t of ts.concat(dense)) {
      assert.equal(t + clock.offset(t), intlWall(tz, t), tz + " at " + new Date(t).toISOString());
      checked++;
    }
    assert.ok(checked > 9000, "checked " + checked);
  });
}

test("createZoneClock: UTC needs no Intl; an invalid zone throws like Intl does", () => {
  assert.equal(createZoneClock("UTC").mode, "utc");
  assert.equal(createZoneClock("Etc/UTC").mode, "utc");
  assert.equal(createZoneClock("local").mode, "local");
  assert.equal(createZoneClock("America/New_York").mode, "intl");
  assert.throws(() => createZoneClock("Not/AZone"), RangeError);
});

test("createZoneClock memoizes per UTC day: far fewer Intl calls than instants", () => {
  const clock = createZoneClock("America/New_York");
  let t = Date.UTC(2020, 0, 1);
  for (let k = 0; k < 100000; k++, t += 150000) clock.offset(t);   // ~174 days, incl. the 2020-03-08 change
  // 2 lookups per day + a ~17-step bisection on the one transition day.
  assert.ok(clock.stats().exact < 400, "exact lookups: " + clock.stats().exact);
});

// SP4 carry-over: offset() used to call Intl / Date on the raw instant, so the
// largest valid Date (8.64e15) threw a RangeError (its UTC day's last ms is past
// the max) and instants before year 1 gave garbage. The lookup instant is now
// clamped to the same 1900..2199 window buildTimeIndex buckets in.
test("createZoneClock.offset clamps absurd instants to the time-index bounds", () => {
  const { TI_T_LO, TI_T_HI } = require("../src/shared-core.js");
  assert.equal(TI_T_LO, Date.UTC(1900, 0, 1));
  assert.equal(TI_T_HI, Date.UTC(2200, 0, 1) - 1);
  for (const tz of ["America/New_York", "Asia/Tokyo", "local", "UTC"]) {
    const c = createZoneClock(tz);
    for (const t of [8.64e15, -8.64e15, -62198755200000 /* year -1 */, NaN, 1e20]) {
      let off;
      assert.doesNotThrow(() => { off = c.offset(t); }, tz + " @ " + t);
      assert.ok(Number.isFinite(off), tz + " @ " + t + " -> " + off);
      const ref = (t > TI_T_HI) ? c.offset(TI_T_HI) : c.offset(TI_T_LO);
      assert.equal(off, ref, tz + " @ " + t);
    }
  }
});
