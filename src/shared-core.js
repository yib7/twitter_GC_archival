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
     Outliers (SP4): the looked-up instant is clamped to [TI_T_LO, TI_T_HI]
     (the same 1900..2199 window buildTimeIndex buckets in; NaN goes low), so
     the largest valid Date (8.64e15, whose UTC day ends past the Date range)
     can't throw inside Intl, and pre-year-1 instants can't yield garbage.
     Pure and DOM-free; unit-tested against Intl in tests/zone-clock.test.js. */
  const DAY_MS = 86400000;
  // Bucketing window shared by createZoneClock, buildTimeIndex and the
  // viewer's zonedParts(): 1900-01-01 .. 2199-12-31T23:59:59.999 UTC.
  const TI_T_LO = Date.UTC(1900, 0, 1), TI_T_HI = Date.UTC(2200, 0, 1) - 1;
  function clampInstant(t) {
    t = +t;
    return !(t >= TI_T_LO) ? TI_T_LO : (t > TI_T_HI ? TI_T_HI : t);
  }
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
      t = clampInstant(t);
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

  /* ---- Time index (UX-4 / AN-13) ---------------------------------------------
     buildTimeIndex(msgs, clock) -> TI: zoned calendar fields for every message,
     as typed arrays parallel to msgs (index i = msgs[i]), in clock's zone:
       TI.n                    number of messages
       TI.day      Int32Array  zoned day number: days since 1970-01-01 (so
                               consecutive days differ by exactly 1)
       TI.year     Uint16Array calendar year
       TI.month    Uint8Array  month 0-11
       TI.mday     Uint8Array  day of month 1-31
       TI.hour     Uint8Array  hour 0-23
       TI.minute   Uint8Array  minute 0-59
       TI.dow      Uint8Array  weekday 0=Sun … 6=Sat
       TI.monthKey Int32Array  year*12 + month (sorts chronologically)
     Pure (no globals, no DOM): the viewer's timeIndex() memoizes it per
     (conversation, zone). clock is a createZoneClock() result.
     Outliers: the instant that gets bucketed is clamped to [TI_T_LO, TI_T_HI]
     (1900-01-01 .. 2199-12-31 UTC; NaN / non-numbers go to the low end). A
     corrupt timestamp would otherwise wrap the Uint16 year, throw inside Intl,
     or make a dense per-day array (the viewer's timeAgg) span ~10^8 days. The
     message's own t, and every label formatted from it, are left untouched. */
  function buildTimeIndex(msgs, clock) {
    const n = msgs.length;
    const TI = {
      n,
      day: new Int32Array(n), year: new Uint16Array(n), month: new Uint8Array(n), mday: new Uint8Array(n),
      hour: new Uint8Array(n), minute: new Uint8Array(n), dow: new Uint8Array(n), monthKey: new Int32Array(n),
    };
    let lastDn = NaN, y = 0, mo = 0, md = 0, wd = 0;
    for (let i = 0; i < n; i++) {
      const t = clampInstant(msgs[i].t);
      const w = t + clock.offset(t);
      const dn = Math.floor(w / DAY_MS);
      const msOfDay = w - dn * DAY_MS;
      if (dn !== lastDn) {   // calendar fields change only once per day
        const d = new Date(dn * DAY_MS);
        y = d.getUTCFullYear(); mo = d.getUTCMonth(); md = d.getUTCDate(); wd = d.getUTCDay();
        lastDn = dn;
      }
      TI.day[i] = dn; TI.year[i] = y; TI.month[i] = mo; TI.mday[i] = md; TI.dow[i] = wd;
      TI.monthKey[i] = y * 12 + mo;
      TI.hour[i] = Math.floor(msOfDay / 3600000);
      TI.minute[i] = Math.floor(msOfDay / 60000) % 60;
    }
    return TI;
  }

  /* ---- Fuzzy-search prefilter (VC-18 / SP3) ----------------------------------
     Fuse.js (threshold t, ignoreLocation) matches a text when some substring of
     it is within k = max{e < m : e/m <= t} edits of the length-m pattern (Bitap,
     insert/delete/substitute). By the q-gram lemma such a text contains at
     least (m-1) - 2k of the pattern's bigram POSITIONS, since each edit breaks at
     most two. createBigramIndex builds an inverted index (bigram -> ascending
     message indices, CSR layout) over the texts; fuzzyCandidates returns the
     messages that pass that bound, so Fuse only scores texts that can match.
     Characters are folded to 38 symbols (a-z, 0-9, space, "other"); folding
     can only let MORE texts through, never fewer, so the filter stays exact.
     Patterns over 32 chars follow Fuse's own 32-char chunking (a text matches
     when any chunk does), so the candidate sets are unioned per chunk.
       createBigramIndex(texts) -> { n, start: Int32Array(B+1), post: Int32Array }
       createBigramIndex.steps(texts, shouldYield) — the same build as a generator
         that yields whenever shouldYield() is true (checked every 1024 texts)
       fuzzyCandidates(index, pattern, threshold) -> Int32Array | null (null = no
         pruning possible for this pattern, e.g. 1-2 chars: search everything) */
  const BG_S = 38, BG_B = BG_S * BG_S, FUSE_MAX_BITS = 32;
  function bgSym(c) {
    if (c >= 97 && c <= 122) return c - 97;
    if (c >= 65 && c <= 90) return c - 65;
    if (c >= 48 && c <= 57) return 26 + c - 48;
    return c === 32 ? 36 : 37;
  }
  function* bigramIndexSteps(texts, shouldYield) {
    const n = texts.length;
    const stamp = new Int32Array(BG_B), count = new Int32Array(BG_B);
    for (let i = 0; i < n; i++) {
      if ((i & 1023) === 1023 && shouldYield && shouldYield()) yield;
      const t = texts[i] || "";
      let prev = t.length ? bgSym(t.charCodeAt(0)) : 0;
      for (let j = 1; j < t.length; j++) {
        const cur = bgSym(t.charCodeAt(j)), b = prev * BG_S + cur;
        if (stamp[b] !== i + 1) { stamp[b] = i + 1; count[b]++; }
        prev = cur;
      }
    }
    const start = new Int32Array(BG_B + 1);
    for (let b = 0; b < BG_B; b++) start[b + 1] = start[b] + count[b];
    const post = new Int32Array(start[BG_B]);
    const fill = start.slice(0, BG_B);
    stamp.fill(0);
    for (let i = 0; i < n; i++) {
      if ((i & 1023) === 1023 && shouldYield && shouldYield()) yield;
      const t = texts[i] || "";
      let prev = t.length ? bgSym(t.charCodeAt(0)) : 0;
      for (let j = 1; j < t.length; j++) {
        const cur = bgSym(t.charCodeAt(j)), b = prev * BG_S + cur;
        if (stamp[b] !== i + 1) { stamp[b] = i + 1; post[fill[b]++] = i; }
        prev = cur;
      }
    }
    return { n, start, post };
  }
  function createBigramIndex(texts) {
    const g = bigramIndexSteps(texts, null);
    let r;
    do { r = g.next(); } while (!r.done);
    return r.value;
  }
  createBigramIndex.steps = bigramIndexSteps;
  // One Fuse chunk: a Uint8Array membership mask of the candidates, or null.
  function chunkCandidates(index, p, threshold) {
    const m = p.length;
    let k = 0;
    while (k + 1 < m && (k + 1) / m <= threshold) k++;
    const need = (m - 1) - 2 * k;
    if (need <= 0) return null;
    const w = new Map();
    for (let j = 0; j + 1 < m; j++) {
      const b = bgSym(p.charCodeAt(j)) * BG_S + bgSym(p.charCodeAt(j + 1));
      w.set(b, (w.get(b) || 0) + 1);
    }
    const cnt = new Uint8Array(index.n);
    for (const [b, wt] of w) {
      const { start, post } = index;
      for (let q = start[b], e = start[b + 1]; q < e; q++) cnt[post[q]] += wt;
    }
    for (let i = 0; i < cnt.length; i++) cnt[i] = cnt[i] >= need ? 1 : 0;
    return cnt;
  }
  function fuzzyCandidates(index, pattern, threshold) {
    const pat = String(pattern || "").toLowerCase();
    const m = pat.length;
    if (!m) return null;
    // Fuse's chunking (BitapSearch): 32-char chunks from 0, plus the LAST 32
    // chars when the length isn't a multiple of 32.
    const chunks = [];
    if (m > FUSE_MAX_BITS) {
      const rem = m % FUSE_MAX_BITS, end = m - rem;
      for (let w = 0; w < end; w += FUSE_MAX_BITS) chunks.push(pat.substr(w, FUSE_MAX_BITS));
      if (rem) chunks.push(pat.substr(m - FUSE_MAX_BITS));
    } else chunks.push(pat);
    let mask = null;
    for (const c of chunks) {
      const cm = chunkCandidates(index, c, threshold);
      if (!cm) return null;
      if (!mask) mask = cm; else for (let i = 0; i < mask.length; i++) mask[i] |= cm[i];
    }
    let total = 0;
    for (let i = 0; i < mask.length; i++) total += mask[i];
    const out = new Int32Array(total);
    for (let i = 0, o = 0; i < mask.length; i++) if (mask[i]) out[o++] = i;
    return out;
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
    // UX-20 (SP3): "UTC" was the DEFAULT zone before SP3, so an unmarked "UTC"
    // means "never chose one" and keeps the fallback (the new default "local"
    // at boot, the current zone on Import). A zone the user picked carries
    // tzExplicit: true; any accepted zone takes the source's marker with it.
    const tzOk = typeof src.timezone === "string" && (src.timezone === "local" || isValidTimeZone(src.timezone));
    if (tzOk && !(src.timezone === "UTC" && src.tzExplicit !== true)) {
      s.timezone = src.timezone;
      s.tzExplicit = src.tzExplicit === true;
    }
    if (Array.isArray(src.pins)) s.pins = src.pins.filter(isId);
    if (Array.isArray(src.ignoredUsers)) s.ignoredUsers = idList(src.ignoredUsers);
    if (Array.isArray(src.ignoredGroups)) s.ignoredGroups = idList(src.ignoredGroups);
    if (Array.isArray(src.saved)) s.saved = src.saved.map(cleanSaved).filter(Boolean);
    return s;
  }
  return {
    PALETTE, X_LINK, hashId, initials, paletteColor,
    PHOTO_RE, PHOTO_PATH_RE, sanitizePhoto, sanitizeColor, isValidTimeZone, createZoneClock, buildTimeIndex,
    TI_T_LO, TI_T_HI, clampInstant,
    createBigramIndex, fuzzyCandidates,
    isPlainObj, cleanMap, idList, cleanSaved, validateSettings,
  };
});
