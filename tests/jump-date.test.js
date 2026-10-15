// UX-9 / VC-28 (SP8): GCAShared.parseJumpDate(input, clock) is the ONE date
// parser behind the Timeline's jump-to-date (command palette + calendar input)
// and the Search before:/after: operators. It reads YYYY-MM-DD, YYYY-MM, YYYY,
// M/D/YYYY, "June 2021", "Jan 7 2024" and "7 Jan 2024"; rejects dates that do
// not exist (2023-02-30 used to roll over to Mar 2); and returns the period as
// [start, end) epoch-ms bounds at midnight IN THE CONFIGURED ZONE (clock).

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const { parseJumpDate, zonedDayStart, createZoneClock } = require("../src/shared-core.js");

const UTC = createZoneClock("UTC");
const NY = createZoneClock("America/New_York");
const KOL = createZoneClock("Asia/Kolkata");

const pick = (p) => p && !p.error ? { unit: p.unit, y: p.y, mo: p.mo, d: p.d, key: p.key, label: p.label } : p;

test("YYYY-MM-DD is a day", () => {
  assert.deepStrictEqual(pick(parseJumpDate("2024-01-07", UTC)), { unit: "day", y: 2024, mo: 0, d: 7, key: "2024-01-07", label: "Jan 7, 2024" });
  assert.deepStrictEqual(pick(parseJumpDate("  2024-1-7 ", UTC)), { unit: "day", y: 2024, mo: 0, d: 7, key: "2024-01-07", label: "Jan 7, 2024" });
  assert.deepStrictEqual(pick(parseJumpDate("2024/01/07", UTC)).key, "2024-01-07");
});

test("YYYY-MM and YYYY are a month and a year", () => {
  assert.deepStrictEqual(pick(parseJumpDate("2021-06", UTC)), { unit: "month", y: 2021, mo: 5, d: 1, key: "2021-06", label: "June 2021" });
  assert.deepStrictEqual(pick(parseJumpDate("2021", UTC)), { unit: "year", y: 2021, mo: 0, d: 1, key: "2021", label: "2021" });
});

test("natural month and day forms", () => {
  for (const s of ["June 2021", "june 2021", "Jun 2021", "Jun. 2021", "June, 2021"]) {
    assert.deepStrictEqual(pick(parseJumpDate(s, UTC)), { unit: "month", y: 2021, mo: 5, d: 1, key: "2021-06", label: "June 2021" }, s);
  }
  for (const s of ["Jan 7 2024", "Jan 7, 2024", "January 7th, 2024", "jan 07 2024", "7 Jan 2024", "7th January 2024", "07 jan, 2024"]) {
    assert.deepStrictEqual(pick(parseJumpDate(s, UTC)), { unit: "day", y: 2024, mo: 0, d: 7, key: "2024-01-07", label: "Jan 7, 2024" }, s);
  }
  assert.strictEqual(parseJumpDate("Sept 3 2019", UTC).key, "2019-09-03");
});

test("US M/D/YYYY (the palette's old second form) still works", () => {
  assert.strictEqual(parseJumpDate("1/7/2024", UTC).key, "2024-01-07");
  assert.strictEqual(parseJumpDate("12/31/2023", UTC).key, "2023-12-31");
});

test("dates that don't exist are rejected, not rolled over", () => {
  for (const s of ["2023-02-30", "2024-02-30", "2023-02-29", "2021-13", "2021-00", "2021-06-00", "2021-06-31", "Feb 30 2023", "31 April 2022", "13/01/2024", "0000", "0999-01-01"]) {
    const p = parseJumpDate(s, UTC);
    assert.ok(p && p.error === "invalid", s + " → " + JSON.stringify(p));
  }
  // a real leap day is fine
  assert.strictEqual(parseJumpDate("2024-02-29", UTC).key, "2024-02-29");
});

test("input that isn't a date at all is null (the palette shows no date row)", () => {
  for (const s of ["", "   ", "bob", "Go to Bob", "June", "2021-06-07-08", "Foo 2021", "12345", "2021 June 7", null, undefined, 42]) {
    assert.strictEqual(parseJumpDate(s, UTC), null, String(s));
  }
});

test("bounds are [start, end) at midnight in the clock's zone", () => {
  const d = parseJumpDate("2024-01-07", UTC);
  assert.strictEqual(d.start, Date.UTC(2024, 0, 7));
  assert.strictEqual(d.end, Date.UTC(2024, 0, 8));
  const m = parseJumpDate("2024-02", UTC);
  assert.strictEqual(m.start, Date.UTC(2024, 1, 1));
  assert.strictEqual(m.end, Date.UTC(2024, 2, 1));
  const y = parseJumpDate("2023", UTC);
  assert.strictEqual(y.start, Date.UTC(2023, 0, 1));
  assert.strictEqual(y.end, Date.UTC(2024, 0, 1));
  // New York: midnight is 05:00Z in winter, 04:00Z in summer
  const ny = parseJumpDate("2024-01-07", NY);
  assert.strictEqual(ny.start, Date.UTC(2024, 0, 7, 5));
  assert.strictEqual(ny.end, Date.UTC(2024, 0, 8, 5));
  const nyMarch = parseJumpDate("March 2024", NY);   // DST starts Mar 10 → the month ends at 04:00Z
  assert.strictEqual(nyMarch.start, Date.UTC(2024, 2, 1, 5));
  assert.strictEqual(nyMarch.end, Date.UTC(2024, 3, 1, 4));
  // Kolkata (+05:30): midnight is the previous UTC day at 18:30
  const k = parseJumpDate("7 Jan 2024", KOL);
  assert.strictEqual(k.start, Date.UTC(2024, 0, 6, 18, 30));
  // no clock = UTC
  assert.strictEqual(parseJumpDate("2024-01-07").start, Date.UTC(2024, 0, 7));
});

test("zonedDayStart lands on the zone's wall-clock midnight, across DST days", () => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const [y, mo, d] of [[2024, 2, 10], [2024, 2, 11], [2024, 10, 3], [2024, 10, 4], [2023, 0, 1]]) {
    const t = zonedDayStart(y, mo, d, NY);
    const p = {}; for (const x of f.formatToParts(t)) p[x.type] = x.value;
    assert.strictEqual(`${p.year}-${p.month}-${p.day} ${+p.hour % 24}:${p.minute}`, `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")} 0:00`);
    assert.strictEqual(new Date(t - 1).getTime() < t, true);
  }
});

// SP8 fix round 1: a zone whose DST starts AT midnight (negative offsets:
// Santiago, Havana, Asunción, old São Paulo) has no 00:00 that day. The day
// must start at the transition instant (wall clock 01:00) — the earliest
// instant whose wall clock is at/after midnight — never 23:00 of the day
// before, which would bucket the previous evening into it.
const startsAt = (zone, y, mo, d) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const t = zonedDayStart(y, mo, d, createZoneClock(zone));
  const p = {}; for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { t, wall: `${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` };
};
test("a midnight skipped by DST resolves to the transition instant (Santiago, Havana, Asunción, São Paulo)", () => {
  const cases = [
    ["America/Santiago", 2024, 8, 8, Date.UTC(2024, 8, 8, 4), "2024-09-08 01:00"],
    ["America/Havana", 2024, 2, 10, Date.UTC(2024, 2, 10, 5), "2024-03-10 01:00"],
    ["America/Asuncion", 2023, 9, 1, Date.UTC(2023, 9, 1, 4), "2023-10-01 01:00"],
    ["America/Sao_Paulo", 2018, 10, 4, Date.UTC(2018, 10, 4, 3), "2018-11-04 01:00"],
  ];
  for (const [zone, y, mo, d, at, wall] of cases) {
    const r = startsAt(zone, y, mo, d);
    assert.deepStrictEqual(r, { t: at, wall }, zone);
    // the day before is a full 24 h (it runs up to the transition) and the
    // skipped-midnight day itself is 23 h
    assert.strictEqual(r.t - startsAt(zone, y, mo, d - 1).t, 24 * 3600000, zone + " previous day length");
    assert.strictEqual(startsAt(zone, y, mo, d + 1).t - r.t, 23 * 3600000, zone + " day length");
  }
  // the day bound used by jumps / before: / after: follows
  assert.strictEqual(parseJumpDate("2024-09-08", createZoneClock("America/Santiago")).start, Date.UTC(2024, 8, 8, 4));
  assert.strictEqual(parseJumpDate("2024-09-07", createZoneClock("America/Santiago")).end, Date.UTC(2024, 8, 8, 4));
});

test("the same holds for the browser's own zone (\"local\")", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/Santiago";
    const local = createZoneClock("local");
    assert.strictEqual(zonedDayStart(2024, 8, 8, local), Date.UTC(2024, 8, 8, 4));
    assert.strictEqual(zonedDayStart(2024, 8, 9, local), Date.UTC(2024, 8, 9, 3));
    assert.strictEqual(zonedDayStart(2024, 8, 7, local), Date.UTC(2024, 8, 7, 4));
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});
