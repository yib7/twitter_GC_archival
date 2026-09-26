/* global module */
// src/shared-core.js — single source for constants/helpers shared by the viewer
// (src/app.js), the setup wizard (src/setup.js), and the Node build (scripts/build-core.js).
// No bundler: loaded as a plain <script> in index.html/setup.html (sets a global) and require()d in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node
  if (root) root.GCAShared = api;                                              // browser global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Avatar colors — 12-color palette assigned by id hash. MUST match everywhere a
  // person's avatar is drawn (viewer + wizard) or the same person changes color.
  const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#ef4444", "#10b981", "#f97316", "#a855f7", "#14b8a6", "#eab308"];
  // Matches messages containing a Twitter/X link (t.co / twitter.com / x.com, with
  // optional subdomain + scheme). Used by the viewer and the build to drop link-only
  // messages from the naming samples.
  const X_LINK = /(?:https?:\/\/)?(?:t\.co|(?:[\w-]+\.)?twitter\.com|(?:[\w-]+\.)?x\.com)\//i;
  // Stable 32-bit hash of an id → deterministic palette/hue index. String()-coerces
  // (safe superset: the viewer always passes strings, the wizard passes numeric ids).
  function hashId(id) { id = String(id); let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }
  // Up-to-two-letter monogram for an avatar with no photo (first+last initial, or the
  // first two letters of a single word). Returns "?" for blank/whitespace-only names.
  function initials(name) {
    const p = name.trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "?";
    if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
    return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }
  // Shared kernel of colorOf: the plain palette lookup with no user-override. The
  // viewer wraps this to honor settings.colors first; the wizard uses it directly.
  function paletteColor(id) { return PALETTE[hashId(id) % PALETTE.length]; }
  /* ---- Settings validation (VC-5 / VC-6) ---------------------------------- */
  // Pure, DOM-free validators for the settings object. The viewer runs every
  // settings source through validateSettings(): the persisted gca.settings blob
  // at boot and an imported JSON file. Kept here (not in app.js) so node:test
  // can cover them directly — see tests/settings-validate.test.js.

  // P1-3: photo values reach the DOM as raw style="…url('…')" interpolation or a
  // CSSOM background-image. Values the app writes itself are always a base64 image
  // data URL or a wizard-saved slug path; anything else collapses to "" (falsy),
  // which every call site treats as "no photo" (initials fallback).
  const PHOTO_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i;
  const PHOTO_PATH_RE = /^(?:personal_data|sample_media)\/[A-Za-z0-9._/-]+$/;
  function sanitizePhoto(v) {
    if (typeof v !== "string") return "";
    return (PHOTO_RE.test(v) || PHOTO_PATH_RE.test(v)) ? v : "";
  }
  // VC-5: colours are interpolated into style="…" attributes, so only a plain hex
  // colour (#rgb / #rrggbb / #rrggbbaa) is ever accepted; anything else is "".
  function sanitizeColor(v) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : "";
  }
  // True if `tz` is a zone Intl can build a formatter for (P1-4).
  function isValidTimeZone(tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
  }
  /* ---- Zone clock (UX-4 / AN-13) ------------------------------------------
     createZoneClock(tz) -> { zone, mode, offset(t), stats() }
     offset(t) is the zone's UTC offset in ms at epoch-ms t, so the wall clock
     is "UTC fields of t + offset(t)" (what Intl.formatToParts would report).
     A zone's offset is constant except on the ~2 days a year it changes its
     clocks, so it is resolved ONCE per UTC day — at the day's first and last
     millisecond. Equal → the whole day uses it (no zone changes twice within a
     day); different → a transition day, whose change instant is found once by
     bisection. That turns one formatToParts per message (~1.75 µs each, per
     analytics pass) into a few thousand per archive. mode: "utc" (offset 0,
     no Intl at all — "UTC", "Etc/UTC", …), "local" (native Date getters) or
     "intl" (any other IANA zone). An invalid zone throws RangeError, like Intl.
     Pure and DOM-free; unit-tested against Intl in tests/zone-clock.test.js. */
  const DAY_MS = 86400000;
  function createZoneClock(tz) {
    let mode = "local", fmt = null;
    if (tz !== "local") {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      const resolved = fmt.resolvedOptions().timeZone;
      mode = (resolved === "UTC" || resolved === "Etc/UTC" || resolved === "Etc/GMT") ? "utc" : "intl";
    }
    const perDay = new Map();   // UTC day number -> offset ms, or {a, b, at} on a transition day
    let exactCalls = 0;
    // Exact offset at t. Offsets are whole seconds, so the wall clock is
    // compared against t truncated to the second.
    function exact(t) {
      exactCalls++;
      const t0 = t - (((t % 1000) + 1000) % 1000);
      if (mode === "local") {
        const d = new Date(t0);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - t0;
      }
      const p = {};
      for (const part of fmt.formatToParts(t0)) p[part.type] = part.value;
      // Intl returns "24" for midnight under hour12:false in some engines.
      const h = +p.hour === 24 ? 0 : +p.hour;
      return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) - t0;
    }
    function offset(t) {
      if (mode === "utc") return 0;
      const day = Math.floor(t / DAY_MS);
      let off = perDay.get(day);
      if (off === undefined) {
        const start = day * DAY_MS;
        const a = exact(start), b = exact(start + DAY_MS - 1);
        if (a === b) off = a;
        else {
          // Transition day: bisect (to the second, ~17 lookups) for the first
          // second that already has the new offset.
          let lo = 0, hi = 86399;   // seconds into the day; exact(start+hi*1000) === b
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (exact(start + mid * 1000) === b) hi = mid; else lo = mid + 1;
          }
          off = { a, b, at: start + lo * 1000 };
        }
        perDay.set(day, off);
      }
      return typeof off === "number" ? off : (t < off.at ? off.a : off.b);
    }
    return { zone: tz, mode, offset, stats: () => ({ exact: exactCalls, days: perDay.size }) };
  }
  function isPlainObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  // Copy an object map keeping only entries `fn` maps to a truthy value; never
  // copies prototype-polluting keys.
  function cleanMap(v, fn) {
    const out = {};
    if (!isPlainObj(v)) return out;
    for (const k of Object.keys(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const val = fn(v[k]);
      if (val) out[k] = val;
    }
    return out;
  }
  // A list of ids (strings or numbers), normalized to non-empty strings.
  function idList(v) { return Array.isArray(v) ? v.filter((x) => (typeof x === "string" && x) || typeof x === "number").map(String) : []; }
  // One saved search: { name, q, f:{people, from, to, media, links, reacts} } or null.
  function cleanSaved(e) {
    if (!isPlainObj(e) || typeof e.name !== "string" || !e.name.trim()) return null;
    const f = isPlainObj(e.f) ? e.f : {};
    const day = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");
    return {
      name: e.name, q: typeof e.q === "string" ? e.q : "",
      f: { people: idList(f.people), from: day(f.from), to: day(f.to), media: f.media === true, links: f.links === true, reacts: f.reacts === true },
    };
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const isId = (v) => (typeof v === "string" && v !== "") || typeof v === "number";
  const gcEntry = (e) => {
    if (!isPlainObj(e)) return null;
    const out = {};
    if (typeof e.name === "string" && e.name.trim()) out.name = e.name;
    const p = sanitizePhoto(e.photo); if (p) out.photo = p;
    return out;
  };
  // The ONE gate every settings object passes through. Copies over only fields
  // whose type/shape is valid, field by field; a field that is absent or invalid
  // keeps its FALLBACK instead of throwing, so a malformed file can never brick
  // boot or inject markup. The fallback is `rules.base` when given — Import passes
  // the user's current settings, so a file only replaces what it actually carries
  // (a file with no `pfps` keeps the photos; an invalid zone keeps the current
  // zone) — and otherwise `rules.defaults` (boot). Never literals, so changing a
  // default (e.g. the timezone) changes every fallback with it.
  //   rules = { defaults, base?, fontMin, fontMax, densities: [names] }
  function validateSettings(raw, rules) {
    const D = rules.defaults;
    const B = isPlainObj(rules.base) ? rules.base : D;
    const src = isPlainObj(raw) ? raw : {};
    const s = clone(D);
    for (const k of Object.keys(D)) if (B[k] !== undefined) s[k] = clone(B[k]);
    const map = (k, fn) => { if (isPlainObj(src[k])) s[k] = cleanMap(src[k], fn); };
    map("names", (v) => (typeof v === "string" && v.trim() ? v : ""));
    map("colors", sanitizeColor);
    map("pfps", sanitizePhoto);
    map("gc", gcEntry);
    if (typeof src.gcName === "string") s.gcName = src.gcName;
    if (src.gcPhoto === "" || sanitizePhoto(src.gcPhoto)) s.gcPhoto = src.gcPhoto;
    if (sanitizeColor(src.accent)) s.accent = sanitizeColor(src.accent);
    const fs = typeof src.fontSize === "number" ? src.fontSize : (typeof src.fontSize === "string" && src.fontSize.trim() ? Number(src.fontSize) : NaN);
    if (isFinite(fs)) s.fontSize = Math.min(rules.fontMax, Math.max(rules.fontMin, Math.round(fs)));
    if (typeof src.density === "string" && rules.densities.indexOf(src.density) !== -1) s.density = src.density;
    if (typeof src.avatars === "boolean") s.avatars = src.avatars;
    if (typeof src.timestamps === "boolean") s.timestamps = src.timestamps;
    if (src.me === null) s.me = null;                  // an explicit "nobody is me"
    else if (isId(src.me)) s.me = String(src.me);
    if (typeof src.timezone === "string" && (src.timezone === "local" || isValidTimeZone(src.timezone))) s.timezone = src.timezone;
    if (Array.isArray(src.pins)) s.pins = src.pins.filter(isId);
    if (Array.isArray(src.ignoredUsers)) s.ignoredUsers = idList(src.ignoredUsers);
    if (Array.isArray(src.ignoredGroups)) s.ignoredGroups = idList(src.ignoredGroups);
    if (Array.isArray(src.saved)) s.saved = src.saved.map(cleanSaved).filter(Boolean);
    return s;
  }
  return {
    PALETTE, X_LINK, hashId, initials, paletteColor,
    PHOTO_RE, PHOTO_PATH_RE, sanitizePhoto, sanitizeColor, isValidTimeZone, createZoneClock,
    isPlainObj, cleanMap, idList, cleanSaved, validateSettings,
  };
});
