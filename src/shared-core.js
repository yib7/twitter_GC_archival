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
  // The ONE gate every settings object passes through. Builds a fresh object from
  // a deep clone of `rules.defaults` and copies over only fields whose type/shape
  // is valid, field by field; an invalid field falls back to its default instead
  // of throwing, so a malformed file can never brick boot or inject markup.
  //   rules = { defaults, fontMin, fontMax, densities: [names] }
  function validateSettings(raw, rules) {
    const D = rules.defaults;
    const src = isPlainObj(raw) ? raw : {};
    const s = clone(D);
    s.names = cleanMap(src.names, (v) => (typeof v === "string" && v.trim() ? v : ""));
    s.colors = cleanMap(src.colors, sanitizeColor);
    s.pfps = cleanMap(src.pfps, sanitizePhoto);
    s.gc = cleanMap(src.gc, (e) => {
      if (!isPlainObj(e)) return null;
      const out = {};
      if (typeof e.name === "string" && e.name.trim()) out.name = e.name;
      const p = sanitizePhoto(e.photo); if (p) out.photo = p;
      return out;
    });
    s.gcName = typeof src.gcName === "string" ? src.gcName : "";
    s.gcPhoto = sanitizePhoto(src.gcPhoto);
    s.accent = sanitizeColor(src.accent) || D.accent;
    const fs = typeof src.fontSize === "number" ? src.fontSize : (typeof src.fontSize === "string" && src.fontSize.trim() ? Number(src.fontSize) : NaN);
    s.fontSize = isFinite(fs) ? Math.min(rules.fontMax, Math.max(rules.fontMin, Math.round(fs))) : D.fontSize;
    s.density = (typeof src.density === "string" && rules.densities.indexOf(src.density) !== -1) ? src.density : D.density;
    s.avatars = typeof src.avatars === "boolean" ? src.avatars : D.avatars;
    s.timestamps = typeof src.timestamps === "boolean" ? src.timestamps : D.timestamps;
    s.me = (typeof src.me === "string" && src.me) || typeof src.me === "number" ? String(src.me) : null;
    s.timezone = (typeof src.timezone === "string" && (src.timezone === "local" || isValidTimeZone(src.timezone))) ? src.timezone : D.timezone;
    s.pins = Array.isArray(src.pins) ? src.pins.filter((p) => (typeof p === "string" && p) || typeof p === "number") : [];
    s.ignoredUsers = idList(src.ignoredUsers);
    s.ignoredGroups = idList(src.ignoredGroups);
    s.saved = Array.isArray(src.saved) ? src.saved.map(cleanSaved).filter(Boolean) : [];
    return s;
  }
  return {
    PALETTE, X_LINK, hashId, initials, paletteColor,
    PHOTO_RE, PHOTO_PATH_RE, sanitizePhoto, sanitizeColor, isValidTimeZone,
    isPlainObj, cleanMap, idList, cleanSaved, validateSettings,
  };
});
