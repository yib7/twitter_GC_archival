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
  // UX-25: the person hue rule — ONE colour per person in the viewer AND the
  // setup wizard. 10 hue pairs defined per theme in styles.css: --p-<hue> (the
  // bright name colour) and --f-<hue> (the deep avatar fill under white
  // initials). A person maps to one hue by id hash.
  const HUES = ["rose", "coral", "amber", "lime", "emerald", "teal", "sky", "indigo", "violet", "magenta"];
  function personHue(id) { return HUES[hashId(id) % HUES.length]; }
  // The CSS values for an element's --p / --f (no user override applied).
  function hueVars(id) { const h = personHue(id); return { p: "var(--p-" + h + ")", f: "var(--f-" + h + ")" }; }
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
  /* ---- Contrast (UX-11 / UX-22) -------------------------------------------
     WCAG 2.x relative luminance + contrast ratio, and two derivations the
     viewer applies at runtime: readableOn() nudges a colour toward white (on
     dark backgrounds) or black (on light ones) until it reaches `min` against
     every background, keeping its hue; accentTokens() derives the text colour
     for a filled accent (--on-accent), the fill itself (only nudged when
     neither white nor near-black text reaches 4.5:1), the .msg.me gradient's
     far end, accent-as-text and a 3:1 UI/focus-ring colour for the theme. */
  function parseRgb(c) {
    const s = String(c).trim();
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    let h = s.replace("#", "");
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toHex(rgb) { return "#" + rgb.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join(""); }
  function mixHex(c, target, t) {
    const a = parseRgb(c), b = parseRgb(target);
    return toHex(a.map((v, i) => v + (b[i] - v) * t));
  }
  function relLuminance(c) {
    const ch = parseRgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrastRatio(a, b) {
    const x = relLuminance(a), y = relLuminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function readableOn(c, bgs, min) {
    if (bgs.every((bg) => contrastRatio(c, bg) >= min)) return c;
    const dark = bgs.reduce((s, bg) => s + relLuminance(bg), 0) / bgs.length < 0.4;
    const target = dark ? "#ffffff" : "#000000";
    for (let i = 1; i <= 100; i++) {
      const out = mixHex(c, target, i / 100);
      if (bgs.every((bg) => contrastRatio(out, bg) >= min)) return out;
    }
    return target;
  }
  const ON_LIGHT = "#0f1419";   // the Light theme's --text: "near-black" text on a light accent
  function accentTokens(accent, bgs) {
    const w = contrastRatio("#ffffff", accent), d = contrastRatio(ON_LIGHT, accent);
    const onAccent = w >= 4.5 ? "#ffffff" : d >= 4.5 ? ON_LIGHT : (w >= d ? "#ffffff" : ON_LIGHT);
    const fill = readableOn(accent, [onAccent], 4.5);
    const far = onAccent === "#ffffff" ? mixHex(fill, "#000000", 0.2) : mixHex(fill, "#ffffff", 0.15);
    return {
      onAccent, fill,
      gradEnd: readableOn(far, [onAccent], 4.5),
      text: readableOn(accent, bgs, 4.5),
      ui: readableOn(accent, bgs.slice(0, 1), 3),
    };
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

  /* ---- Jump dates (UX-9 / VC-28, SP8) -----------------------------------------
     zonedDayStart(y, mo, d, clock) -> epoch ms of wall-clock 00:00 on that day
     in clock's zone (no clock = UTC). Day overflow is fine (d + 1 on the last
     of the month is the 1st of the next). Two-pass solve: from a UTC-equals-
     wall guess, measure the wall clock the zone shows there and shift by the
     difference; the second pass corrects a DST change straddling the guess.
     A midnight that doesn't exist (spring-forward at 00:00) resolves to the
     post-transition instant, like the viewer always has.

     parseJumpDate(input, clock) — the ONE parser behind jump-to-date (command
     palette, calendar input) and the Search before:/after: operators:
       "2024-01-07" "2024/1/7" "1/7/2024" (M/D/YYYY) "Jan 7 2024" "Jan 7, 2024"
       "January 7th 2024" "7 Jan 2024"                         -> unit "day"
       "2021-06" "June 2021" "Jun 2021"                        -> unit "month"
       "2021"                                                  -> unit "year"
     -> { unit, y, mo (0-11), d, key ("YYYY-MM-DD" | "YYYY-MM" | "YYYY"),
          label ("Jan 7, 2024" | "June 2021" | "2021"), start, end }
        start/end: the period as [start, end) epoch ms at midnight in the zone;
     -> { error: "invalid" } when it has a date's shape but the date doesn't
        exist (2023-02-30, month 13, a year before 1000) — never rolled over;
     -> null when it isn't a date at all. Pure; tests/jump-date.test.js. */
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function zonedDayStart(y, mo, d, clock) {
    const target = Date.UTC(y, mo, d);
    if (!clock) return target;
    let guess = target;
    for (let pass = 0; pass < 2; pass++) {
      const delta = target - (guess + clock.offset(guess));
      if (delta === 0) break;
      guess += delta;
    }
    return guess;
  }
  // "jan", "Jan.", "sept", "January" -> 0-11; -1 if not a month name (3+ letters).
  function monthIndex(word) {
    const w = String(word).toLowerCase().replace(/\.$/, "");
    if (w.length < 3) return -1;
    if (w === "sept") return 8;
    for (let k = 0; k < 12; k++) if (MONTH_NAMES[k].toLowerCase().indexOf(w) === 0) return k;
    return -1;
  }
  function parseJumpDate(input, clock) {
    if (typeof input !== "string") return null;
    const s = input.trim().replace(/,/g, " ").replace(/\s+/g, " ");
    if (!s) return null;
    let m, y, mo = 0, d = 1, unit;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; unit = "day"; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { y = +m[3]; mo = +m[1] - 1; d = +m[2]; unit = "day"; }
    else if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2] - 1; unit = "month"; }
    else if ((m = /^(\d{4})$/.exec(s))) { y = +m[1]; unit = "year"; }
    else if ((m = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/i.exec(s))) {
      mo = monthIndex(m[1]); if (mo < 0) return null; d = +m[2]; y = +m[3]; unit = "day";
    } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?) (\d{4})$/i.exec(s))) {
      mo = monthIndex(m[2]); if (mo < 0) return null; d = +m[1]; y = +m[3]; unit = "day";
    } else if ((m = /^([a-z]+\.?) (\d{4})$/i.exec(s))) {
      mo = monthIndex(m[1]); if (mo < 0) return null; y = +m[2]; unit = "month";
    } else return null;
    if (y < 1000 || mo < 0 || mo > 11) return { error: "invalid" };
    const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    if (d < 1 || d > dim) return { error: "invalid" };
    const p2 = (n) => String(n).padStart(2, "0");
    let key, label, endY = y, endMo = mo, endD = d;
    if (unit === "day") { key = y + "-" + p2(mo + 1) + "-" + p2(d); label = MONTH_NAMES[mo].slice(0, 3) + " " + d + ", " + y; endD = d + 1; }
    else if (unit === "month") { key = y + "-" + p2(mo + 1); label = MONTH_NAMES[mo] + " " + y; endMo = mo + 1; }
    else { key = String(y); label = String(y); endY = y + 1; }
    return { unit, y, mo, d, key, label, start: zonedDayStart(y, mo, d, clock), end: zonedDayStart(endY, endMo, endD, clock) };
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
  /* ---- Text analysis (SP4: AN-1 / AN-2 / AN-8 / AN-9 / AN-10 / AN-11) -------
     One definition of "an emoji", "a word", "a laugh", "a swear", "a link to X"
     for every analytics view (Stats, Wrapped, Word Battles, the keyword
     trend), so the same message is always counted the same way. Pure and
     DOM-free; covered by tests/text-analysis.test.js. */

  // --- Emoji (AN-1): whole emoji sequences, so 👍🏽 / 👨‍👩‍👧 / 🇺🇸 / ❤️ each
  // count once and a skin-tone swatch or a regional-indicator letter never
  // counts on its own. RE_EMOJI_SEQ is the UTS #51 "possible emoji" grammar
  // (flag pair | keycap | pictograph + VS16/modifier + tags, ZWJ-joined), and
  // isEmojiSeq keeps only sequences that render as emoji: a flag, a keycap, or
  // a pictograph that is emoji-presentation by default or forced by VS16 / a
  // skin tone / a ZWJ. Text-default pictographs alone (©, ®, ™, ☀ without VS16)
  // are not emoji — the same set /\p{RGI_Emoji}/v matches for real text
  // (tests/text-analysis.test.js checks the two agree), but plain `u`-flag
  // property classes: \p{RGI_Emoji} needs the `v` flag (Chromium 112+,
  // Firefox 116+, Safari 17+) and is ~40x slower in V8 (3 s vs 70 ms for 130k
  // emoji-bearing messages). EMOJI_HINT is a cheap prefilter.
  const EMOJI_HINT = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3]/u;
  const RE_EMOJI_SEQ = /\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?[\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Emoji_Modifier}/gu;
  const RE_EMOJI_FORCED = /\p{Emoji_Presentation}|\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D|^\p{Regional_Indicator}/u;
  function isEmojiSeq(s) { return RE_EMOJI_FORCED.test(s); }
  function extractEmojis(text) {
    if (!text || !EMOJI_HINT.test(text)) return [];
    const m = text.match(RE_EMOJI_SEQ);
    if (!m) return [];
    const out = [];
    for (const s of m) if (isEmojiSeq(s)) out.push(s);
    return out;
  }
  // Reference implementation for tests only: \p{RGI_Emoji} (null where the
  // engine lacks the `v` flag).
  let RE_RGI = null;
  try { RE_RGI = new RegExp("\\p{RGI_Emoji}", "gv"); } catch (e) { RE_RGI = null; }
  function extractEmojisRGI(text) { return RE_RGI ? ((text || "").match(RE_RGI) || []) : null; }

  // --- Words (AN-2 / AN-11) -----------------------------------------------------
  // A word is a run of letters / digits / combining marks (so Cyrillic,
  // Arabic, Hebrew, Devanagari and accented Latin survive), optionally joined
  // by apostrophes — curly ones are folded to ' first, so "don’t" is one token,
  // not "don" + "t". Links, bare domains and @mentions are dropped
  // (plainText). Scripts written without spaces (Han, kana, Thai, …) are split
  // into words by Intl.Segmenter when available, otherwise into grapheme
  // clusters. Tokens are lowercased.
  const RE_URL = /https?:\/\/\S+|www\.\S+/gi;
  const RE_APOS = /[\u2018\u2019\u02BC\uFF07]/g, RE_HAS_APOS = /[\u2018\u2019\u02BC\uFF07]/;
  const RE_URL_HINT = /https?:|www\./i;
  // Bare domains ("youtube.com/watch?v=…", "youtu.be/x", "reddit.com") — a
  // closed list of lowercase TLDs, matched case-sensitively, so a missing
  // space after a full stop stays text: "ok.so", "done.to", "agree.Be". The
  // 2-letter TLDs are everyday words too ("lol.ai is wild"), so they only
  // count with a path ("t.co/…", "youtu.be/…"); "www." links go with RE_URL.
  const DOMAIN_TLDS = "com|net|org|app|dev|info|biz|xyz|edu|gov";
  const DOMAIN_TLDS_SHORT = "io|co|be|tv|gg|ly|ai|uk|ca|de|fr|jp|ru|fm|gl";
  const DOMAIN_END = "(?:(?:" + DOMAIN_TLDS + ")(?![\\p{L}\\p{N}_-])(?:\\/\\S*)?|(?:" + DOMAIN_TLDS_SHORT + ")\\/\\S*)";
  const RE_DOMAIN_HINT = new RegExp("\\.(?:(?:" + DOMAIN_TLDS + ")(?![\\p{L}\\p{N}_-])|(?:" + DOMAIN_TLDS_SHORT + ")\\/)", "u");
  const RE_DOMAIN = new RegExp("(^|[^\\p{L}\\p{N}._-])(?:[\\p{L}\\p{N}-]+\\.)+" + DOMAIN_END, "gu");
  // @mentions (X handles: letters, digits, underscore) not inside a word, so
  // an email's "me@" survives while its domain goes with RE_DOMAIN.
  const RE_MENTION = /(^|[^\p{L}\p{N}_])@[A-Za-z0-9_]+/gu;
  // The message with its links and @mentions removed — what the tokenizer and
  // the keyword, keysmash, caps and question checks read, so a t.co slug
  // ("xkcdbzqwrt") is not a keysmash, a "?" in a query string is not a
  // question and "@thanks_bot" is not gratitude.
  function plainText(text) {
    if (!text) return "";
    let s = String(text);
    if (RE_URL_HINT.test(s)) s = s.replace(RE_URL, " ");
    if (RE_DOMAIN_HINT.test(s)) s = s.replace(RE_DOMAIN, "$1 ");
    if (s.indexOf("@") !== -1) s = s.replace(RE_MENTION, "$1 ");
    return s;
  }
  const RE_TOKEN = /[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*/gu;
  const RE_NOSPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  // No-Segmenter fallback: one no-space-script grapheme cluster at a time — a
  // base character plus its combining marks (Thai vowel signs / tone marks
  // stay on their consonant) — or a run of anything else.
  const RE_NOSPACE_RUNS = /(?:(?!\p{M})[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])\p{M}*|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
  const WORDS_SEG = (typeof Intl !== "undefined" && Intl.Segmenter) ? new Intl.Segmenter("en", { granularity: "word" }) : null;
  function tokenizeWith(text, seg) {
    if (!text) return [];
    let s = plainText(text).toLowerCase();
    if (RE_HAS_APOS.test(s)) s = s.replace(RE_APOS, "'");
    const m = s.match(RE_TOKEN);
    if (!m) return [];
    if (!RE_NOSPACE_SCRIPT.test(s)) return m;
    const out = [];
    for (const t of m) {
      if (!RE_NOSPACE_SCRIPT.test(t)) { out.push(t); continue; }
      if (seg) { for (const w of seg.segment(t)) if (w.isWordLike) out.push(w.segment); }
      else for (const piece of t.match(RE_NOSPACE_RUNS)) out.push(piece);
    }
    return out;
  }
  function tokenize(text) { return tokenizeWith(text, WORDS_SEG); }
  function tokenizeNoSegmenter(text) { return tokenizeWith(text, null); }
  // Apostrophe-free form: the key stopwords, word counts and battles compare.
  function wordKey(t) { return t.indexOf("'") === -1 ? t : t.replace(/'/g, ""); }
  // One shared stopword list (word cloud, Wrapped word of the year). Entries
  // are apostrophe-free; isStopword() folds the token the same way, so "i'm",
  // "don’t" and "dont" all hit "im" / "dont".
  const STOPWORDS = new Set((
    "the a an and or but to of in on at for with is are was were be been being am i you he she it we they them me my your our " +
    "this that these those have has had do does did not no so if as up out get got go gonna just like dont didnt cant wont im " +
    "youre theyre thats whats here there all any some more most then than too very can could would should will shall may might " +
    "must about into over under again only also even still much many lol lmao lmaooo yeah yea nah ok okay haha hahaha bro man " +
    "dude what when who whom how why which whose oh uh um yo idk imo tbh " +
    // apostrophe-stripped contractions (AN-2)
    "its ive ill id lets theres heres youve youll youd weve wed well theyve theyll theyd hes shes isnt arent wasnt werent " +
    "doesnt havent hasnt hadnt wouldnt couldnt shouldnt aint whos wheres hows everyones someones thatll gotta wanna " +
    "his her him us their from by just really one now know think see going"
  ).split(/\s+/));
  // Pronoun contractions whose apostrophe-free form is a different real word
  // (he'll/hell, she'll/shell, she'd/shed): stopwords in their apostrophe
  // spelling only, so they never merge into (or inflate) that word, while
  // "hell" itself and y'all/yall merging are untouched.
  const APOS_STOPWORDS = new Set(["he'll", "she'll", "she'd", "we'll", "we're", "i'll", "we'd"]);
  function isStopword(t) {
    return STOPWORDS.has(wordKey(t)) || (t.indexOf("'") !== -1 && APOS_STOPWORDS.has(t.toLowerCase()));
  }
  const RE_CJK_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  // Word-cloud / word-of-the-year eligibility: not a stopword, not a number,
  // 3-18 characters (2+ for CJK/Hangul, whose words are mostly 1-2 characters).
  function isCloudWord(t) {
    const n = [...t].length;
    if (n > 18 || n < (RE_CJK_WORD.test(t) ? 2 : 3)) return false;
    if (/^[\p{N}']+$/u.test(t)) return false;
    return !isStopword(t);
  }
  // Word cloud / word of the year from a Map of token -> count: spellings that
  // fold to one wordKey (y'all / yall) are ONE word, shown in its commonest
  // spelling (the first seen on a tie). Stopwords, numbers and fragments are
  // skipped (isCloudWord). Sorted by count, then by key; the top `n`.
  function topCloudWords(counts, n) {
    const groups = new Map();   // key -> { total, form, formN }
    for (const [w, c] of counts) {
      if (!isCloudWord(w)) continue;
      const k = wordKey(w);
      const g = groups.get(k);
      if (!g) groups.set(k, { k, total: c, form: w, formN: c });
      else { g.total += c; if (c > g.formN) { g.form = w; g.formN = c; } }
    }
    return [...groups.values()]
      .sort((a, b) => b.total - a.total || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .slice(0, n)
      .map((g) => [g.form, g.total]);
  }
  // Whole-token occurrences of `word` (which may be a phrase) in `text`,
  // apostrophe- and case-insensitive: "man" never matches "many"/"humans",
  // "dont" matches "don’t". Used by Word Battles and the keyword trend (AN-10).
  function wordKeys(word) { return tokenize(word).map(wordKey); }
  // countWord with the word already folded by wordKeys() — for loops over
  // many messages, so the query is tokenized once, not once per message.
  function countKeys(text, keys) {
    if (!keys.length) return 0;
    const t = tokenize(text);
    let n = 0;
    for (let i = 0; i + keys.length <= t.length; i++) {
      let k = 0;
      while (k < keys.length && wordKey(t[i + k]) === keys[k]) k++;
      if (k === keys.length) n++;
    }
    return n;
  }
  function countWord(text, word) { return countKeys(text, wordKeys(word)); }
  // Cheap prefilter before countKeys over many texts: false only when the
  // lower-cased text cannot contain the folded key (apostrophes removed).
  function mayContainKey(lowerText, key) {
    if (!lowerText || !key) return false;
    if (lowerText.indexOf(key) !== -1) return true;
    if (lowerText.indexOf("'") === -1 && !RE_HAS_APOS.test(lowerText)) return false;
    return lowerText.replace(RE_APOS, "").split("'").join("").indexOf(key) !== -1;
  }

  // --- Keyword patterns (AN-8) -------------------------------------------------
  // Global regexes: count with countMatches() (String#match resets lastIndex).
  const LAUGH_SRC = "\\b(?:l+o+l+(?:o+l+)*|lm+f*a+o+|rofl+|a?(?:ha){2,}h?)\\b|💀|😭|😂|🤣";
  const KEYWORDS = {
    laugh: new RegExp(LAUGH_SRC, "giu"),
    narcissist: /\b(?:i|me|my|mine|myself)\b/gi,
    gratitude: /\b(?:thanks|thank you|thank u|ty|tysm|thx)\b/gi,
    optimist: /\b(?:good|great|awesome|amazing|love|best)\b/gi,
    pessimist: /\b(?:bad|terrible|awful|hate|worst)\b/gi,
    // "bet" / "cap" alone are everyday words; only "no cap" is slang.
    zoomer: /\b(?:fr|ngl|no cap|sus|bruh|based|cringe|rizz|gyatt)\b/gi,
    // "bot" / "buff" / "lag" are everyday words too.
    gamer: /\b(?:gg|ggs|wp|nerf|nerfed|noob|fps|respawn)\b/gi,
    // "moon" / "bear" / "bull" alone are not finance talk.
    finance: /\b(?:crypto|btc|eth|bitcoin|ethereum|stocks|stonks|hodl|to the moon|bull market|bear market)\b/gi,
  };
  function countMatches(re, text) { if (!text) return 0; const m = text.match(re); return m ? m.length : 0; }
  function countLaughs(text) { return countMatches(KEYWORDS.laugh, text); }
  // A message that is nothing but laughter (laughs + spaces / punctuation /
  // variation selectors) with at least one laugh — never whitespace alone.
  const RE_LAUGH_STRIP = new RegExp(LAUGH_SRC, "giu");
  function isLaughOnly(text) {
    if (!text || !countLaughs(text)) return false;
    return /^[\s\p{P}\uFE0F]*$/u.test(text.replace(RE_LAUGH_STRIP, ""));
  }
  const RE_PROFANITY = /\b(?:\w*fuck\w*|\w*shit\w*|bitch\w*|damn\w*|goddam\w*|asshole\w*|cunt\w*|dick|dicks|dickhead\w*|pussy|cock|bastard\w*|slut\w*|whore\w*|wtf|stfu)\b/i;
  function isProfane(text) { return !!text && RE_PROFANITY.test(text); }
  // Keysmash (links ignored): a home-row roll ("asdf", "hjkl"), or a 6+ letter
  // run that is mostly home row (70%+ of its letters from asdfghjkl), has at
  // least 4 distinct letters, no letter three times in a row, no e/i/o/u/y
  // and at most one "a" per 6 letters. So "sdkjfhsdkjfhskdjfh" and
  // "jfkdlsajf" count, while words ("salads", "rhythms", "strngths") and
  // stretched interjections ("hmmmmph", "pfffft", "tsktsktsk") do not.
  const RE_KEYSMASH_SEQ = /asdf|fdsa|ghjk|hjkl|jkl;/i;
  const RE_HOME_ROW = /[asdfghjkl]/g;
  function isKeysmashRun(r) {
    if (/[eiouy]/.test(r) || /(.)\1\1/.test(r)) return false;   // a vowel, or a stretched letter ("pfffft")
    const a = r.split("a").length - 1;
    if (a && r.length < 8) return false;   // short runs with an "a" are words ("splash", "slacks")
    if (a * 6 > r.length) return false;
    if (new Set(r).size < 4) return false;
    return (r.match(RE_HOME_ROW) || []).length * 10 >= r.length * 7;
  }
  function isKeysmash(text) { return isKeysmashPlain(plainText(text)); }
  // For text that is already plainText() (statsGen strips each message once).
  function isKeysmashPlain(text) {
    if (!text) return false;
    if (RE_KEYSMASH_SEQ.test(text)) return true;
    const runs = text.toLowerCase().match(/\b[a-z]{6,}\b/g);
    if (!runs) return false;
    for (const r of runs) if (isKeysmashRun(r)) return true;
    return false;
  }

  // --- Links (AN-9): match the hostname, not a substring of the whole URL
  // ("netflix.com" ends in "x.com"; "xbox.com" contains it).
  const PLATFORM_HOSTS = [["twitter", /(^|\.)(?:twitter|x)\.com$/], ["youtube", /(^|\.)(?:youtube\.com|youtu\.be)$/],
    ["tiktok", /(^|\.)tiktok\.com$/], ["instagram", /(^|\.)instagram\.com$/]];
  function urlHost(url) {
    if (typeof url !== "string" || !url.trim()) return "";
    const u = url.trim();
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase(); } catch (e) { return ""; }
  }
  function linkPlatform(url) {
    const h = urlHost(url);
    if (!h || h.indexOf(".") === -1) return null;
    for (const [name, re] of PLATFORM_HOSTS) if (re.test(h)) return name;
    return null;
  }

  // --- Copy (AN-20 / UX-31): "1 thread", "2 threads", "1,234 messages".
  function plural(n, one, many) {
    return Number(n).toLocaleString("en-US") + " " + (n === 1 ? one : (many || one + "s"));
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
  // UX-29: custom Word Battles words — strings only, trimmed, ≤40 chars,
  // de-duplicated case-insensitively (first spelling wins), at most 30.
  const BATTLE_WORD_MAX = 40, BATTLE_WORDS_MAX = 30;   // per word / per list
  function cleanBattleWords(a) {
    const seen = new Set(), out = [];
    for (const w of Array.isArray(a) ? a : []) {
      if (typeof w !== "string") continue;
      const t = w.trim();
      if (!t || t.length > BATTLE_WORD_MAX || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase()); out.push(t);
      if (out.length >= BATTLE_WORDS_MAX) break;
    }
    return out;
  }
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
    if (Array.isArray(src.battleWords)) s.battleWords = cleanBattleWords(src.battleWords);
    return s;
  }
  return {
    PALETTE, X_LINK, hashId, initials, paletteColor, HUES, personHue, hueVars,
    PHOTO_RE, PHOTO_PATH_RE, sanitizePhoto, sanitizeColor, isValidTimeZone,
    relLuminance, contrastRatio, readableOn, accentTokens, createZoneClock, buildTimeIndex,
    TI_T_LO, TI_T_HI, clampInstant, zonedDayStart, parseJumpDate, MONTH_NAMES,
    createBigramIndex, fuzzyCandidates,
    extractEmojis, extractEmojisRGI, tokenize, tokenizeNoSegmenter, wordKey, STOPWORDS, isStopword, isCloudWord, topCloudWords, countWord, wordKeys, countKeys, mayContainKey,
    KEYWORDS, countMatches, countLaughs, isLaughOnly, isProfane, isKeysmash, isKeysmashPlain, plainText, urlHost, linkPlatform, plural,
    isPlainObj, cleanMap, idList, cleanSaved, cleanBattleWords, BATTLE_WORD_MAX, BATTLE_WORDS_MAX, validateSettings,
  };
});
