// Unit coverage for the pure settings validators in src/shared-core.js
// (VC-5 / VC-6). The browser-level behaviour — boot never bricks, an import is
// validated before it is saved — is covered end-to-end by
// tests/settings-validate.spec.js; this file pins the validators themselves.

require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");

const {
  sanitizeColor, sanitizePhoto, isValidTimeZone, isPlainObj, cleanMap, idList, cleanSaved, validateSettings,
} = require("../src/shared-core.js");

// Mirrors the viewer's DEFAULTS / slider range / density names (src/app.js).
const DEFAULTS = Object.freeze({
  names: {}, pfps: {}, gc: {}, gcName: "", gcPhoto: "",
  colors: {}, me: null, accent: "#1d9bf0", fontSize: 15, density: "comfortable", avatars: true, timestamps: true,
  saved: [], pins: [], ignoredUsers: [], ignoredGroups: [], timezone: "UTC",
});
const RULES = { defaults: DEFAULTS, fontMin: 13, fontMax: 19, densities: ["comfortable", "compact"] };
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const EVIL = 'red"><b id="injected">x</b><img src=x onerror=alert(1)>';

test("sanitizeColor accepts only plain hex colours", () => {
  for (const ok of ["#abc", "#AABBCC", "#11223344", "  #fff  "]) assert.equal(sanitizeColor(ok), ok.trim(), ok);
  for (const bad of [EVIL, "red", "#ab", "#abcd1", "rgb(0,0,0)", "#fff;color:red", 123, null, undefined, {}, ["#fff"]]) {
    assert.equal(sanitizeColor(bad), "", JSON.stringify(bad));
  }
});

test("sanitizePhoto accepts image data URLs and wizard slug paths only", () => {
  for (const ok of [PNG, "data:image/svg+xml;base64,AAAA", "personal_data/pfp/u1.jpg", "sample_media/a-b_c.png"]) {
    assert.equal(sanitizePhoto(ok), ok, ok);
  }
  for (const bad of [
    "javascript:alert(1)", "data:text/html;base64,AAAA", PNG + "')",
    "https://evil.example/x.png", "personal_data/a b.png", "/etc/passwd", 5, null,
  ]) {
    assert.equal(sanitizePhoto(bad), "", JSON.stringify(bad));
  }
});

test("isValidTimeZone recognises IANA zones and rejects junk", () => {
  for (const ok of ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]) assert.ok(isValidTimeZone(ok), ok);
  for (const bad of ["Not/AZone", "", "local", "UTC+99"]) assert.ok(!isValidTimeZone(bad), bad);
});

test("isPlainObj is true only for non-array objects", () => {
  assert.ok(isPlainObj({}));
  for (const v of [null, undefined, [], "x", 1, true]) assert.ok(!isPlainObj(v), JSON.stringify(v));
});

test("cleanMap keeps truthy mapped entries and never copies prototype-polluting keys", () => {
  const src = JSON.parse('{"a":"#fff","b":"nope","__proto__":{"polluted":1},"constructor":"#000","prototype":"#000"}');
  const out = cleanMap(src, sanitizeColor);
  assert.deepStrictEqual(out, { a: "#fff" });
  assert.equal(({}).polluted, undefined);
  assert.deepStrictEqual(cleanMap(["#fff"], sanitizeColor), {});
  assert.deepStrictEqual(cleanMap(null, sanitizeColor), {});
});

test("idList keeps non-empty strings and numbers, as strings", () => {
  assert.deepStrictEqual(idList(["u1", 2, "", null, {}, "u3"]), ["u1", "2", "u3"]);
  assert.deepStrictEqual(idList("u1"), []);
});

test("cleanSaved normalizes a saved search and rejects nameless ones", () => {
  assert.equal(cleanSaved({ q: "x" }), null);
  assert.equal(cleanSaved({ name: "   " }), null);
  assert.equal(cleanSaved("x"), null);
  assert.deepStrictEqual(
    cleanSaved({ name: "N", q: 5, f: { people: ["u1", 2, null], from: "2024-01-02", to: "yesterday", media: "yes", links: true, reacts: 1 } }),
    { name: "N", q: "", f: { people: ["u1", "2"], from: "2024-01-02", to: "", media: false, links: true, reacts: false } },
  );
});

test("validateSettings of junk is exactly the defaults (fresh copy)", () => {
  for (const raw of [null, undefined, "x", 5, [], {}]) {
    const s = validateSettings(raw, RULES);
    assert.deepStrictEqual(s, JSON.parse(JSON.stringify(DEFAULTS)), JSON.stringify(raw));
    assert.notStrictEqual(s.pins, DEFAULTS.pins, "must not alias the defaults");
  }
});

test("validateSettings falls back field by field and never throws", () => {
  const s = validateSettings({
    accent: 123, colors: { u1: EVIL, u2: "#ff0000" }, names: { u1: "Zed", u2: "", u3: 7 }, fontSize: 99,
    density: "cosy", avatars: "yes", timestamps: false, me: 42, timezone: "Not/AZone", pins: ["m1", 2, null, ""],
    ignoredUsers: ["u9"], ignoredGroups: "g1", saved: [{ name: "S" }, { q: "no name" }],
    pfps: { u1: PNG, u2: "javascript:x" }, gc: { A: { name: "Alpha", photo: "bad" }, B: "x" }, gcName: 5, gcPhoto: PNG,
  }, RULES);
  assert.equal(s.accent, "#1d9bf0");
  assert.deepStrictEqual(s.colors, { u2: "#ff0000" });
  assert.deepStrictEqual(s.names, { u1: "Zed" });
  assert.equal(s.fontSize, 19, "clamped to the slider max, not dropped");
  assert.equal(validateSettings({ fontSize: "14.4" }, RULES).fontSize, 14);
  assert.equal(validateSettings({ fontSize: "big" }, RULES).fontSize, 15);
  assert.equal(s.density, "comfortable");
  assert.equal(validateSettings({ density: "compact" }, RULES).density, "compact");
  assert.equal(s.avatars, true);
  assert.equal(s.timestamps, false);
  assert.equal(s.me, "42");
  assert.equal(s.timezone, "UTC");
  assert.equal(validateSettings({ timezone: "local" }, RULES).timezone, "local");
  assert.deepStrictEqual(s.pins, ["m1", 2]);
  assert.deepStrictEqual(s.ignoredUsers, ["u9"]);
  assert.deepStrictEqual(s.ignoredGroups, []);
  assert.deepStrictEqual(s.saved, [{ name: "S", q: "", f: { people: [], from: "", to: "", media: false, links: false, reacts: false } }]);
  assert.deepStrictEqual(s.pfps, { u1: PNG });
  assert.deepStrictEqual(s.gc, { A: { name: "Alpha" } });
  assert.equal(s.gcName, "");
  assert.equal(s.gcPhoto, PNG);
});

test("validateSettings takes its fallbacks from rules.defaults, not literals", () => {
  const rules = Object.assign({}, RULES, { defaults: Object.assign({}, DEFAULTS, { timezone: "local", accent: "#123456", fontSize: 17 }) });
  const s = validateSettings({ timezone: "Not/AZone", accent: "nope", fontSize: null }, rules);
  assert.equal(s.timezone, "local");
  assert.equal(s.accent, "#123456");
  assert.equal(s.fontSize, 17);
});

test("with rules.base (Import), absent or invalid fields keep the CURRENT value", () => {
  const base = validateSettings({ me: "u2", accent: "#ff0000", pfps: { u1: PNG }, timezone: "America/New_York", pins: ["m1"], names: { u1: "Old" } }, RULES);
  const rules = Object.assign({ base }, RULES);
  const s = validateSettings({ names: { u1: "New" }, timezone: "Not/AZone", accent: 5 }, rules);
  assert.deepStrictEqual(s.names, { u1: "New" }, "a valid field present in the file replaces");
  assert.equal(s.timezone, "America/New_York", "an invalid zone keeps the current one");
  assert.equal(s.accent, "#ff0000", "an invalid accent keeps the current one");
  assert.deepStrictEqual(s.pfps, { u1: PNG }, "photos absent from the file are kept");
  assert.equal(s.me, "u2");
  assert.deepStrictEqual(s.pins, ["m1"]);
  assert.notStrictEqual(s.pins, base.pins, "must not alias the base object");
  // An explicit value (even an empty one) is honoured.
  const t = validateSettings({ me: null, pfps: {}, pins: [] }, rules);
  assert.equal(t.me, null);
  assert.deepStrictEqual(t.pfps, {});
  assert.deepStrictEqual(t.pins, []);
});
