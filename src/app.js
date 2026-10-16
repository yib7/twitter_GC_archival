/* =========================================================================
   Group Chat Archive — app logic (vanilla JS, no dependencies)
   ========================================================================= */
(function () {
"use strict";

// Constants/helpers shared with the setup wizard + Node build live in ONE module,
// loaded as a <script> before this one (index.html) — see src/shared-core.js.
/* global GCAShared */
const { PALETTE, X_LINK, initials, hueVars, userLabels } = GCAShared;
// the platform's modifier — ⌘ on Apple devices, Ctrl elsewhere — shared
// by the timeline's palette button and the keyboard help.
const MOD_KEY = /Mac|iP(hone|ad|od)/.test(navigator.platform || "") ? "⌘" : "Ctrl";
// Pure settings validators — also unit-tested under Node.
const { sanitizePhoto, sanitizeColor, isPlainObj, readableOn, accentTokens, cleanBattleWords, BATTLE_WORD_MAX, BATTLE_WORDS_MAX, safeMediaUrl } = GCAShared;
// the one definition of an emoji / word / stopword / keyword / platform
// link that every analytics view counts with.
const { extractEmojis, tokenize, wordKey, wordKeys, countKeys, mayContainKey, topCloudWords, KEYWORDS, countMatches,
  countLaughs, isLaughOnly, isProfane, isKeysmashPlain, plainText, linkPlatform, plural } = GCAShared;

/* ---- Data (multi-conversation) ------------------------------------------- */
const DATA = window.CHAT_DATA || { conversations: [] };
// True only for the shipped synthetic demo (sample/data.sample.js sets __sample). Any
// real build (data.js / personal_data/data.js) overrides CHAT_DATA without it.
const IS_SAMPLE = !!(DATA && DATA.__sample);
const CONVOS = normalizeConvos(DATA);
function normalizeConvos(d) {
  if (Array.isArray(d.conversations) && d.conversations.length) return d.conversations;
  // legacy single-conversation shape ({conversationId, msgs, events})
  return [{
    id: d.conversationId || "conversation",
    type: "group", title: null, participants: [],
    count: (d.msgs || []).length, msgs: d.msgs || [], events: d.events || []
  }];
}

// active-conversation state — all reassigned by activateConversation()
let CONV = null;           // current conversation object
let MSGS = [];             // active messages
let EVENTS = [];           // active system events
let N = 0;
let LOWER = [];            // lowercased text cache for search
let ID2IDX = new Map();
let PARTS = [];            // participants of the active conversation
let GENERIC = {};          // per-conversation generic names: id -> "User N"

// A conversation whose every sender is ignored filters down to N === 0 and
// would blank/crash the app if picked as active — prefer one that
// actually has visible messages; only fall back to saved/first if none do.
function hasVisibleMessages(c) {
  const ignored = ignoredUserIds();
  return (c.msgs || []).some((m) => !ignored.has(String(m.s)));
}

// The empty-chat panel: a chat with no messages at all, or one whose every
// sender is ignored (plain text, no markup).
function emptyConvText() {
  return CONV && (CONV.msgs || []).length ? "No messages in this group — every sender is ignored." : "This group has no messages.";
}

function pickInitialConvId() {
  let saved = null;
  try { saved = localStorage.getItem("gca.conv"); } catch (e) {}
  const vis = visibleConvos();
  const nonEmpty = vis.filter(hasVisibleMessages);
  const pool = nonEmpty.length ? nonEmpty : vis;
  if (saved && pool.some(c => c.id === saved)) return saved;
  return pool[0] ? pool[0].id : null;
}

function rebuildIndexes() {
  N = MSGS.length;
  LOWER = new Array(N);
  ID2IDX = new Map();
  for (let i = 0; i < N; i++) { LOWER[i] = searchText(MSGS[i]); ID2IDX.set(MSGS[i].i, i); }
}
// what Search reads for a message — its text plus the expanded and
// display URLs of its links (renderText shows those, not the raw t.co link,
// so what you see is what you can find). Search only: the word cloud and the
// keyword analytics read m.x through plainText() / tokenize() (a LOWER probe
// there is only a prefilter, re-checked on m.x).
function searchText(m) {
  const x = m.x || "", u = m.u;
  if (!Array.isArray(u) || !u.length) return x.toLowerCase();
  let extra = "";
  for (const e of u) if (e && (e.e || e.d)) extra += " \u0001 " + (e.e || "") + " \u0001 " + (e.d || "");
  return (x + extra).toLowerCase();
}

// "User N" for the active chat: the same rule (shared-core userLabels) as
// another chat's labels (genericFor) and the setup wizard's People step.
function assignGenericNames() {
  GENERIC = CONV ? userLabels(CONV, ignoredUserIds()) : {};
}

// renderGallery() only rebuilds when the view is empty — clear it so the next
// visit rebuilds (unlike timeline/search, gallery has no *Built flag): on a
// conversation switch, and when its cells' names or dates change (a rename, a
// timezone change). Guarded: boot calls this before the DOM is ready.
function resetGallery() {
  galleryState = { items: [], page: 0 }; galEls = {};
  if (galleryObserver) { try { galleryObserver.disconnect(); } catch (e) {} galleryObserver = null; }
  const gv = document.getElementById("view-gallery"); if (gv) gv.innerHTML = "";
}
// drop derived caches / per-view state so the next render uses the active conversation
function resetDerived() {
  STATS = null; MILES = null; HOF = null; fuzzyIdxJob = null; fuzzyForceQ = null;
  threadsCache = null;
  TIDX = null;   // the zoned time index is per conversation
  searchBuilt = false; sEls = {};
  if (resPageObs) { try { resPageObs.disconnect(); } catch (e) {} resPageObs = null; }
  invalidateTimeline(); tlResume = null;   // a new conversation opens at its saved reading position, else the newest message
  resetGallery();
  hofYear = "all"; wrappedYear = null; wrappedSlide = 0;
  battleP1 = null; battleP2 = null;
  // filters are per-conversation state — another
  // chat's dates / people / media toggles / grid mode (or Threads year) must
  // not silently narrow this one. Sort order and match mode are preferences
  // and are kept. ensureSearch() renders its controls FROM F, so the rebuilt
  // toolbar always shows exactly what is applied.
  resetSearchFilters();
  threadFilter = "all";
  for (const k in wrappedCache) delete wrappedCache[k];
  if (trendChart) { try { trendChart.destroy(); } catch (e) {} trendChart = null; }
  // same lifecycle as trendChart for the three per-render stats charts —
  // without this, every conversation switch leaks instances holding the old
  // (now detached) canvases.
  statCharts.forEach((c) => { try { c.destroy(); } catch (e) {} });
  statCharts = [];
  cancelStatsRender();
}
// drop the half-stepped stats/word sweeps, cancel a pending deferred Stats
// stage, and clear the (hidden) Stats DOM so numbers derived from the previous
// conversation or zone never linger or get mixed — setView re-renders Stats on
// entry. Called on a conversation switch (resetDerived) and a timezone change.
function cancelStatsRender() {
  statsJob = null; statsRenderSeq++;
  const sv = document.getElementById("view-stats"); if (sv) { sv.innerHTML = ""; delete sv.dataset.ready; }
}

// An ignored user disappears entirely: their messages AND their
// reactions on everyone else's messages. Messages whose reactions change are
// shallow-copied, so the shared CONVOS data stays intact for when the user is
// un-ignored again.
function withoutIgnored(list, ignored) {
  if (!ignored.size) return list.slice();
  const out = [];
  for (const m of list) {
    if (ignored.has(String(m.s))) continue;
    if (m.r && m.r.some((x) => ignored.has(String(x.s)))) {
      const r = m.r.filter((x) => !ignored.has(String(x.s)));
      const copy = Object.assign({}, m);
      if (r.length) copy.r = r; else delete copy.r;
      out.push(copy);
    } else out.push(m);
  }
  return out;
}

function activateConversation(id, rerender) {
  const c = CONVOS.find(x => x.id === id) || CONVOS[0];
  if (!c) return;
  saveTlPos();   // the conversation being left keeps its reading position
  CONV = c;
  // the active chat searches through MSGS / LOWER — its All chats index
  // (built while it was "another chat") would only hold memory; rebuilt
  // lazily if it is searched from another chat again.
  convSearchIdx.delete(c.id);
  try { localStorage.setItem("gca.conv", c.id); } catch (e) {}
  const ignored = ignoredUserIds();
  MSGS = withoutIgnored(c.msgs || [], ignored);
  EVENTS = c.events || [];
  rebuildIndexes();
  resetDerived();
  PARTS = computeParticipants();
  assignGenericNames();
  if (rerender) {
    updateBrand();
    renderConvPicker();
    buildSidebarSparkline();
    if (curView) setView(curView);
  }
}

/* ---- Constants ----------------------------------------------------------- */
const REACT = { funny: "😂", like: "❤️", agree: "👍", disagree: "👎", excited: "🔥", surprised: "😮", sad: "😢", emoji: "💬" };
// PALETTE moved to src/shared-core.js (destructured at the top of this IIFE).
const ACCENTS = ["#1d9bf0", "#3b82f6", "#2563eb", "#1d4ed8", "#0ea5e9", "#38bdf8", "#06b6d4", "#0891b2", "#6366f1", "#818cf8", "#60a5fa"];
// Dark-intensity presets removed: surfaces are owned by the html[data-theme]
// blocks (Light / Dim / Lights out) in styles.css, selected via the theme module.
const DENSITY = {
  comfortable: { gap: "14px", pad: "10px 14px" },
  compact:     { gap: "7px",  pad: "6px 11px" },
};
const PAGE = 60;
let DT, DAY, dShort;
// ZP_LOCAL: the configured zone is the browser's own ("local"), whose day
// bounds zonedDateBound() takes from native Date parsing.
let ZP_LOCAL = false;
// ZONE_ID is the zone actually in effect (after the fallbacks
// below); the time index is keyed on it.
let ZONE_ID = "UTC";
// isValidTimeZone lives in src/shared-core.js, used by validateSettings.
function initDateFormatters() {
  // 'local' uses native Date accessors (no formatter); every other zone shares
  // this single formatter. hour12:false so hour comes back 0-23.
  const build = (opts, isLocal) => {
    DT = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }));
    DAY = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
    dShort = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { month: "short", day: "numeric", year: "numeric" }));
    ZP_LOCAL = isLocal;
  };
  // A corrupt/ported zone throws a RangeError on construction, and this runs at
  // top-level module init with no other guard — an uncaught throw bricks the app
  // before it leaves the boot skeleton. validateSettings already keeps
  // invalid zones out; as a last line of defence fall back to the DEFAULT zone
  // (not a literal), then to UTC only if even that cannot be built.
  const zones = [(settings && settings.timezone) || DEFAULTS.timezone, DEFAULTS.timezone, "UTC"];
  for (const tz of zones) {
    try {
      build(tz === "local" ? {} : { timeZone: tz }, tz === "local");
      CLOCK = GCAShared.createZoneClock(tz);
      ZONE_ID = tz;
      TIDX = null;   // every zoned index is stale under a new zone
      return;
    } catch (e) { /* next */ }
  }
}

/* ---- Zone clock ---------------------------------------------
   Every zoned calendar value is "UTC fields of (t + the zone's UTC offset at t)".
   GCAShared.createZoneClock (src/shared-core.js, unit-tested against
   Intl.formatToParts) resolves that offset once per UTC day instead of one
   formatToParts per message, with no Intl at all for UTC. */
let CLOCK = null;
const DAY_MS = 86400000;
function zoneOffset(t) { return CLOCK.offset(t); }
// "YYYY-MM-DD" for a zoned day number (days since 1970-01-01 in the zone).
// Cached: an archive has a few thousand distinct days, not 100k.
const dayKeyCache = new Map();
function dayNumKey(dn) {
  let k = dayKeyCache.get(dn);
  if (k === undefined) { k = new Date(dn * DAY_MS).toISOString().slice(0, 10); dayKeyCache.set(dn, k); }
  return k;
}

// Zoned calendar parts for an epoch (ms), in the CONFIGURED timezone. This is the
// single source of truth for every analytics bucket, so a message's bucket always
// agrees with its DT/DAY/dShort label (same zone, same instant).
//   -> { y, mo (0-11), d, h (0-23), mi, se, dow (0=Sun), key "YYYY-MM-DD" }
// For a sweep over the active conversation's messages use timeIndex() instead.
// The instant is clamped to the time index's 1900..2199 window (shared-core
// clampInstant), so an outlier timestamp buckets exactly where timeIndex()
// puts it and can never produce an Invalid Date / RangeError.
function zonedParts(t) {
  t = GCAShared.clampInstant(t);
  const wall = t + zoneOffset(t);
  const w = new Date(wall);
  return { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(),
    se: w.getUTCSeconds(), dow: w.getUTCDay(), key: dayNumKey(Math.floor(wall / DAY_MS)) };
}

/* ---- Per-conversation time index (consumed by the analytics views and
   the calendar heatmap) ----------------------------------------------------------------
   timeIndex() -> TI, built lazily ONCE per (active conversation, timezone) and
   shared by every analytics sweep (Stats, milestones, keyword trend, Wrapped,
   Capsule, "On this day", sidebar sparkline, Hall of Fame, Threads). Arrays are
   parallel to MSGS (index i = MSGS[i]), all values in the configured zone:
     TI.n                 number of messages (=== N)
     TI.day   Int32Array  zoned day number: days since 1970-01-01 (dayNumKey()
                          turns it into "YYYY-MM-DD"; consecutive days differ by 1)
     TI.year  Uint16Array calendar year
     TI.month Uint8Array  month 0-11
     TI.mday  Uint8Array  day of month 1-31
     TI.hour  Uint8Array  hour 0-23
     TI.minute Uint8Array minute 0-59
     TI.dow   Uint8Array  weekday 0=Sun … 6=Sat
     TI.monthKey Int32Array  year*12 + month (monthKeyStr() -> "YYYY-MM"); sorts
                          chronologically as a plain number
   The arrays come from GCAShared.buildTimeIndex (src/shared-core.js, pure and
   unit-tested against Intl in tests/time-index.test.js); this accessor only
   memoizes it. Invalidated by resetDerived() (conversation switch / settings
   replaced) and initDateFormatters() (timezone change); it also re-checks MSGS
   identity and the zone, so a stale index can never be served. Read-only for
   consumers. */
let TIDX = null;
function timeIndex() {
  if (TIDX && TIDX.msgs === MSGS && TIDX.zone === ZONE_ID) return TIDX;
  const TI = GCAShared.buildTimeIndex(MSGS, CLOCK);
  TI.msgs = MSGS; TI.zone = ZONE_ID;
  TIDX = TI;
  return TI;
}
function monthKeyStr(mk) { return Math.floor(mk / 12) + "-" + String((mk % 12) + 1).padStart(2, "0"); }

// Time-only aggregate of the time index (per-day / per-month / hour / weekday
// counts). Cached ON the index object, so it is invalidated exactly when the
// index is (conversation switch, zone change). Cheap (typed-array tallies, no
// text), so the first Stats paint and the milestones can use it without
// waiting for the full computeStats() text sweep.
//   dayMin / dayCounts: dayCounts[dn - dayMin] = messages on zoned day dn
//   days:     { "YYYY-MM-DD": count } in chronological order
//   monthArr: [["YYYY-MM", count], …] ascending
//   busy:     ["YYYY-MM-DD", count] — the earliest busiest day
// dayCounts is dense over the index's day range, which buildTimeIndex bounds
// (instants clamped to 1900..2199), so one corrupt timestamp can size it to at
// most ~110k days (<0.5 MB), never the ~10^8 days a raw outlier would.
function timeAgg() {
  const TI = timeIndex();
  if (TI.agg) return TI.agg;
  const n = TI.n;
  const hourCount = new Array(24).fill(0), weekdayCount = new Array(7).fill(0);
  let dMin = Infinity, dMax = -Infinity, mMin = Infinity, mMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = TI.day[i], mk = TI.monthKey[i];
    if (d < dMin) dMin = d; if (d > dMax) dMax = d;
    if (mk < mMin) mMin = mk; if (mk > mMax) mMax = mk;
  }
  const dayCounts = new Int32Array(n ? dMax - dMin + 1 : 0);
  const monthCounts = new Int32Array(n ? mMax - mMin + 1 : 0);
  for (let i = 0; i < n; i++) {
    dayCounts[TI.day[i] - dMin]++;
    monthCounts[TI.monthKey[i] - mMin]++;
    hourCount[TI.hour[i]]++;
    weekdayCount[TI.dow[i]]++;
  }
  const days = {};
  let daysActive = 0, busy = ["", 0];
  for (let k = 0; k < dayCounts.length; k++) {
    const c = dayCounts[k];
    if (!c) continue;
    const key = dayNumKey(dMin + k);
    days[key] = c; daysActive++;
    if (c > busy[1]) busy = [key, c];
  }
  const monthArr = [];
  // every month from the first to the last, silent months as 0 — the
  // months chart, hero / sidebar sparklines and keyword trend all read this,
  // so a gap never draws as consecutive months.
  for (let k = 0; k < monthCounts.length; k++) monthArr.push([monthKeyStr(mMin + k), monthCounts[k]]);
  TI.agg = { dayMin: n ? dMin : 0, dayCounts, days, daysActive, busy, monthArr, hourCount, weekdayCount };
  return TI.agg;
}

// Interpret a "YYYY-MM-DD" string as the start-of-day (or, when `end`, the last
// millisecond of the day) instant in the CONFIGURED zone, returning epoch ms
// (NaN if it isn't a real day). Used by the From/To search filters. The
// same GCAShared.parseJumpDate as jump-to-date and before:/after:, so every
// date in the app means the same wall-clock day the labels do, and an
// impossible date (2023-02-30) is rejected instead of rolling over.
function zonedDateBound(dateStr, end) {
  const p = GCAShared.parseJumpDate(String(dateStr), CLOCK);
  if (!p || p.error || p.unit !== "day") return NaN;
  return end ? p.end - 1 : p.start;
}

// An epoch that falls on the given "YYYY-MM-DD" day IN the configured zone, so
// DT/DAY/dShort format it back to that exact day. Uses local noon (not midnight)
// so a spring-forward-at-midnight zone can't nudge the label to the prior day.
function dayKeyBoundInstant(k) {
  if (ZP_LOCAL) return new Date(k + "T12:00:00").getTime();
  // Start-of-day in the zone + 12h stays on the same calendar day everywhere.
  return zonedDateBound(k, false) + 12 * 3600000;
}

/* ---- Settings ------------------------------------------------------------ */
// Committed defaults carry NO real names — participants render as generic
// "User N" labels (assigned per-conversation) until the viewer renames them in
// the People tab (saved to localStorage). A private, gitignored names.local.js
// may set window.LOCAL_NAMES / window.LOCAL_PFPS to override locally.
const LOCAL_NAMES = (typeof window !== "undefined" && window.LOCAL_NAMES) || {};
const LOCAL_IGNORED_USERS = (typeof window !== "undefined" && Array.isArray(window.LOCAL_IGNORED_USERS)) ? window.LOCAL_IGNORED_USERS.map(String) : [];
const LOCAL_IGNORED_GROUPS = (typeof window !== "undefined" && Array.isArray(window.LOCAL_IGNORED_GROUPS)) ? window.LOCAL_IGNORED_GROUPS.map(String) : [];
// Optional gitignored overrides written by the setup wizard (personal_data/local.js):
//   window.LOCAL_ME  = "<id>"               — which participant is "you"
//   window.LOCAL_GC  = { name, photo }       — the real group name + photo path
const LOCAL_ME = (typeof window !== "undefined" && window.LOCAL_ME) || null;
const LOCAL_GC = (typeof window !== "undefined" && window.LOCAL_GC) || null;
// Storage keys read by loadSettings() below. They MUST be declared before the
// top-level `let settings = loadSettings()` runs: as `const`s further down they
// sat in the temporal dead zone at boot, loadPfps()/loadGc() threw (and
// swallowed) a ReferenceError, and every saved photo / in-app group rename was
// silently dropped on reload.
const PFPS_KEY = "gca.pfps";
const GC_KEY = "gca.gc";
// Deep-frozen: every consumer gets its own copy via cloneDefaults(), so a
// settings object can never alias (and later mutate) these arrays/maps — the
// old Reset did `Object.assign({}, DEFAULTS, …)` and bookmarking afterwards
// pushed straight into DEFAULTS.pins.
const DEFAULTS = deepFreeze({
  names: {}, pfps: {}, gc: {}, gcName: "", gcPhoto: "",
  colors: {}, me: null, accent: "#1d9bf0", fontSize: 15, density: "comfortable", avatars: true, timestamps: true, saved: [], pins: [], ignoredUsers: [], ignoredGroups: [],
  // dates render in the viewer's own zone by default. tzExplicit
  // marks a zone picked in Settings — see validateSettings (shared-core) for
  // how an unmarked legacy "UTC" is migrated.
  timezone: "local", tzExplicit: false,
  // the words added in Word Battles (newest first), kept across
  // people changes and reloads.
  battleWords: []
});
const FONT_MIN = 13, FONT_MAX = 19;   // the Settings slider's range
function deepFreeze(o) { Object.values(o).forEach((v) => { if (v && typeof v === "object") deepFreeze(v); }); return Object.freeze(o); }
function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }

// every settings object — the persisted gca.settings blob at boot
// (loadSettings) and an imported JSON file (Import) — passes through ONE gate.
// The validators are pure and live in src/shared-core.js (validateSettings,
// sanitizePhoto, sanitizeColor, cleanMap, cleanSaved, …); this wrapper only
// supplies the viewer's rules. Declared up here because it runs at boot.
const SETTINGS_RULES = { defaults: DEFAULTS, fontMin: FONT_MIN, fontMax: FONT_MAX, densities: Object.keys(DENSITY) };
// `base` (Import only): the settings an absent/invalid field keeps — see shared-core.
function validateSettings(raw, base) {
  return GCAShared.validateSettings(raw, base ? Object.assign({ base }, SETTINGS_RULES) : SETTINGS_RULES);
}

// The toast timers (see Toast below) are declared before the first settings
// write: a failed save at boot shows a toast, which must not find them uninitialised.
let toastT = null, srT = 0;
let settings = loadSettings();
// persist the one-time "unmarked UTC -> local" migration, so the stored
// blob matches what is in effect (and the rule never has to run again).
// A failed write leaves it unsaved; it applies again on the next load.
(function persistTzMigration() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem("gca.settings") || "null"); } catch (e) { /* unreadable: nothing to migrate */ }
  try { if (isPlainObj(raw) && raw.timezone === "UTC" && raw.tzExplicit !== true) saveSettings(); } catch (e) { /* not saved this time */ }
})();
migratePfpsKey();
initDateFormatters();
function loadSettings() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem("gca.settings") || "{}"); } catch (e) { saved = {}; }
  if (!isPlainObj(saved)) saved = {};
  // pfps + gc live under their own keys (legacy blobs kept them inline).
  const s = validateSettings(Object.assign({}, saved, { pfps: loadPfps(saved.pfps), gc: loadGc(saved.gc) }));
  if (!s.me && LOCAL_ME) s.me = LOCAL_ME;   // honor the wizard's "this is you"
  return s;
}
// Profile-picture data URLs are bulky; persist them under their OWN localStorage
// key so an over-quota photo can never block names/pins/saved searches from
// saving. (Previously photos lived inside the gca.settings blob, where one large
// upload tripped QuotaExceededError and silently wiped ALL settings.)
function loadPfps(legacy) {
  try {
    const raw = localStorage.getItem(PFPS_KEY);
    if (raw != null) return JSON.parse(raw) || {};
  } catch (e) { /* fall through to legacy/migration */ }
  // migrate-on-read: older builds kept pfps inside gca.settings
  return (legacy && typeof legacy === "object") ? Object.assign({}, legacy) : {};
}
// Persist the pfp map. Returns false (and warns) if storage is full, leaving the
// previously-saved photos and every other setting intact.
function savePfps() {
  try { localStorage.setItem(PFPS_KEY, JSON.stringify(settings.pfps || {})); return true; }
  catch (e) { toast("That photo was too large to save — your names and other settings are safe."); return false; }
}
// Per-group name + photo overrides ({ convId: { name, photo } }) editable in the
// app. Like pfps, the (bulky) photo data URLs live under their OWN localStorage
// key so they can never trip the gca.settings quota.
function loadGc(legacy) {
  try {
    const raw = localStorage.getItem(GC_KEY);
    if (raw != null) return JSON.parse(raw) || {};
  } catch (e) { /* fall through */ }
  return (legacy && typeof legacy === "object") ? Object.assign({}, legacy) : {};
}
function saveGc() {
  try { localStorage.setItem(GC_KEY, JSON.stringify(settings.gc || {})); return true; }
  catch (e) { toast("That group photo was too large to save — your other settings are safe."); return false; }
}
function saveSettings() {
  try {
    const toStore = Object.assign({}, settings); delete toStore.pfps; delete toStore.gc;   // pfps + gc live under their own keys
    localStorage.setItem("gca.settings", JSON.stringify(toStore));
  } catch (e) { toast("Couldn't save settings — browser storage may be full."); }
}
// One-time: lift any pfps still embedded in gca.settings into their own key, so
// existing users' photos survive the move off the settings blob.
function migratePfpsKey() {
  try {
    if (localStorage.getItem(PFPS_KEY) == null && settings.pfps && Object.keys(settings.pfps).length) {
      savePfps(); saveSettings();
    }
  } catch (e) { /* best-effort */ }
}

function ignoredUserIds() {
  const ids = []
    .concat(Array.isArray(DATA.ignoredUsers) ? DATA.ignoredUsers : [])
    .concat(LOCAL_IGNORED_USERS)
    .concat(Array.isArray(settings.ignoredUsers) ? settings.ignoredUsers : []);
  return new Set(ids.map(String));
}
// The ignored set plus a stable key for caches built over it (genericFor,
// scopeData). Rebuilt only when one of the three lists changes, so a caller
// that runs once per message (an All chats export) stays cheap.
let ignoredMemo = { raw: null, set: null, key: "" };
function ignoredKeyed() {
  const raw = [DATA.ignoredUsers, LOCAL_IGNORED_USERS, settings.ignoredUsers].map((a) => (Array.isArray(a) ? a.join(",") : "")).join("|");
  if (raw !== ignoredMemo.raw) {
    const set = ignoredUserIds();
    ignoredMemo = { raw, set, key: [...set].sort().join(",") };
  }
  return ignoredMemo;
}

// Whole group chats the user removed (wizard build, LOCAL override, or in-app).
function ignoredGroupIds() {
  const ids = []
    .concat(Array.isArray(DATA.ignoredGroups) ? DATA.ignoredGroups : [])
    .concat(LOCAL_IGNORED_GROUPS)
    .concat(Array.isArray(settings.ignoredGroups) ? settings.ignoredGroups : []);
  return new Set(ids.map(String));
}
// Conversations the user can see/switch to (removed groups hidden). If every
// group is hidden, fall back to all of them so the app never blanks out.
function visibleConvos() {
  const hidden = ignoredGroupIds();
  const vis = CONVOS.filter((c) => !hidden.has(String(c.id)));
  return vis.length ? vis : CONVOS;
}

/* ---- Helpers ------------------------------------------------------------- */
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function highlightDOM(element, needles) {
  if (!needles || !needles.length) return;
  const pat = needles.map((n) => reEsc(n)).filter(Boolean).join("|");
  if (!pat) return;
  const regex = new RegExp("(" + pat + ")", "gi");

  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while ((node = walk.nextNode())) {
    if (node.parentNode && node.parentNode.tagName === 'MARK') continue;
    if (node.nodeValue.trim()) nodes.push(node);
  }

  nodes.forEach((textNode) => {
    const parent = textNode.parentNode;
    if (!parent) return;
    const text = textNode.nodeValue;
    regex.lastIndex = 0;
    if (regex.test(text)) {
      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      const parts = text.split(regex);
      parts.forEach((part) => {
        regex.lastIndex = 0;
        if (regex.test(part)) {
          const mark = document.createElement("mark");
          mark.textContent = part;
          frag.appendChild(mark);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      });
      parent.replaceChild(frag, textNode);
    }
  });
}
// range-based variant of highlightDOM for fuzzy matches. `ranges` are
// inclusive [start, end] pairs (Fuse match indices) into the message's plain
// text; we walk the rendered text nodes tracking the absolute offset and wrap
// the intersecting slices in <mark>. Same XSS discipline as highlightDOM:
// only text nodes are split/rewrapped via textContent — raw message text
// never goes through innerHTML.
function highlightRangesDOM(element, ranges) {
  if (!ranges || !ranges.length) return;
  // Sort and merge overlapping/adjacent ranges so marks don't nest or abut.
  const sorted = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }

  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while ((node = walk.nextNode())) {
    if (node.parentNode && node.parentNode.tagName === "MARK") continue;
    nodes.push(node);
  }

  let offset = 0;
  nodes.forEach((textNode) => {
    const text = textNode.nodeValue;
    const start = offset, end = offset + text.length;
    offset = end;
    const parent = textNode.parentNode;
    if (!parent) return;
    // Clip the merged ranges (inclusive ends) to this node's local coordinates.
    const local = [];
    for (const [s, e] of merged) {
      const ls = Math.max(s, start) - start, le = Math.min(e + 1, end) - start;
      if (le > ls) local.push([ls, le]);
    }
    if (!local.length) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [ls, le] of local) {
      if (ls > pos) frag.appendChild(document.createTextNode(text.slice(pos, ls)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(ls, le);
      frag.appendChild(mark);
      pos = le;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    parent.replaceChild(frag, textNode);
  });
}
function hexToRgb(h) { h = String(h).replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); if (h.length === 8) h = h.slice(0, 6); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hexA(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; }
function shade(h, p) { let [r, g, b] = hexToRgb(h); const t = p < 0 ? 0 : 255; const f = Math.abs(p) / 100; r = Math.round((t - r) * f + r); g = Math.round((t - g) * f + g); b = Math.round((t - b) * f + b); return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
// hashId moved to src/shared-core.js (used there by hueVars).
// Day bucket for an epoch, in the configured zone ("YYYY-MM-DD"). Callers group
// by equality; the human-readable busiest-day label formats via zone-aware DAY.
function dayKey(t) { return zonedParts(t).key; }
// Number(): a count from a hand-edited data.js can be a string of markup, and
// toLocaleString on a string hands it back unchanged into innerHTML.
function fmtNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }

/* Count-up stat numbers (mock-stats animate()): finds [data-count] (integers,
   fmtNum separators) and [data-decimal] (toFixed(1)) descendants of rootEl and
   eases each 0→target over ~1s (ease-out cubic), starts staggered 80ms + i*45ms
   like the mock. data-suffix is appended verbatim. Markup seeds the FINAL value
   (no-JS / print stays sensible); this zeroes it synchronously before the first
   frame so there's no flash. prefers-reduced-motion → final value instantly,
   no rAF. Safe if a node detaches mid-animation (isConnected guards). Shared:
   Stats uses it now, Wrapped reuses it. */
function animateCounts(rootEl) {
  if (!rootEl) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  rootEl.querySelectorAll("[data-count],[data-decimal]").forEach((node, i) => {
    const decimal = node.dataset.decimal != null;
    const target = decimal ? parseFloat(node.dataset.decimal) : +node.dataset.count;
    if (!isFinite(target)) return;
    const suffix = node.dataset.suffix || "";
    const fmt = (v) => (decimal ? v.toFixed(1) : fmtNum(Math.round(v))) + suffix;
    // Hidden documents never fire rAF (background tab / minimized window), so
    // an animation started there would sit at "0" until the next visibility
    // change. Render the final value straight away instead.
    if (reduce || document.hidden) { node.textContent = fmt(target); return; }
    node.textContent = fmt(0);
    const dur = 1000;
    setTimeout(() => {
      if (!node.isConnected) return;
      const start = performance.now();
      const step = (now) => {
        if (!node.isConnected) return;
        let p = Math.min(1, (now - start) / dur);
        p = 1 - Math.pow(1 - p, 3);
        node.textContent = fmt(target * p);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 80 + i * 45);
  });
}

function nameOf(id) { return settings.names[id] || LOCAL_NAMES[id] || GENERIC[id] || ("User " + String(id).slice(-4)); }
// A person's name as chat conv shows it: an unnamed person is that chat's
// "User N" (genericFor), so a row from another chat (All chats, Pinned, the
// export) reads as it does in its own chat. nameIn(CONV, id) is nameOf(id).
function nameIn(conv, id) { return settings.names[id] || LOCAL_NAMES[id] || (conv ? genericFor(conv)[id] : GENERIC[id]) || ("User " + String(id).slice(-4)); }
// Another chat's "User N" labels ({ id: label }), by the one rule in
// shared-core userLabels (senders by message count, then quiet members:
// roster, reactions, events; ignored people left out), as the active chat's
// GENERIC and the setup wizard number them. Cached per chat, keyed like
// convSearchIdx (the ignored set and the message array).
const genericCache = new Map();
function genericFor(conv) {
  if (CONV && conv.id === CONV.id) return GENERIC;
  const { set: ignored, key } = ignoredKeyed();
  let g = genericCache.get(conv.id);
  if (!g || g.key !== key || g.src !== conv.msgs) {
    g = { key, src: conv.msgs, names: userLabels(conv, ignored) };
    genericCache.set(conv.id, g);
  }
  return g.names;
}
// ONE person colour everywhere: avatars, names, cards, Word
// Battles, foreign pins and the share cards all read personColor().
// X person palette — 10 hue pairs (--p-* bright name / --f-* deep avatar fill).
// A person maps to one hue by id hash; a user-picked settings.colors[id] overrides
// (deep = shaded). Returns the CSS values for the inline --p/--f the avatar + name use.
// The automatic (hashed) hue alone, ignoring any override — what the People
// tab's "A" swatch previews. The rule lives in src/shared-core.js
// (HUES / personHue / hueVars) so the setup wizard paints the same colour.
function autoColor(id) { return hueVars(id); }
function personColor(id) {
  const c = sanitizeColor(settings.colors[id]);
  // the deep fill carries white avatar initials: darken it until it clears 4.5:1
  if (c) return { p: overrideVar(c), f: readableOn(shade(c, -20), ["#ffffff"], 4.5) };
  return autoColor(id);
}
// a user-picked colour is used for name TEXT, so it must stay readable
// in every theme (a bright yellow fails on white, a deep navy on black). Each
// distinct override gets one --pc-<hex> custom property whose value is set per
// theme (nudged toward white/black only as far as 4.5:1 needs), so switching
// theme needs no re-render and canvasColor() (share cards) still resolves it.
const overrideVars = new Set();
function overrideVar(c) {
  const key = c.slice(1).toLowerCase();
  if (!overrideVars.has(key)) {
    overrideVars.add(key);
    let st = document.getElementById("pc-vars");
    if (!st) { st = document.createElement("style"); st.id = "pc-vars"; document.head.appendChild(st); }
    st.textContent = Object.keys(THEME_BGS).map((t) =>
      (t === "lightsout" ? ":root," : "") + 'html[data-theme="' + t + '"]{' +
      [...overrideVars].map((k) => "--pc-" + k + ":" + readableOn("#" + k.slice(0, 6), THEME_BGS[t], 4.5)).join(";") + "}"
    ).join("\n");
  }
  return "var(--pc-" + key + ")";
}

/* ---- Bookmarks / Pinned messages ----------------------------------------- */
function isPinned(msgId) { return settings.pins.indexOf(msgId) >= 0; }
function togglePin(msgId) {
  const at = settings.pins.indexOf(msgId);
  if (at >= 0) { settings.pins.splice(at, 1); toast("Removed bookmark"); }
  else { settings.pins.push(msgId); toast("★ Bookmarked"); }
  saveSettings();
  // keep any open pin buttons in sync
  document.querySelectorAll('.act-pin[data-mid="' + cssEsc(msgId) + '"]').forEach((b) => setPinBtn(b, isPinned(msgId)));
  if (curView === "pins") renderPins();
}
// A bookmark toggle keeps one accessible name ("Bookmark") and reports its
// state through aria-pressed; the star glyph and tooltip mirror it.
function setPinBtn(b, on) {
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.title = on ? "Remove bookmark" : "Bookmark";
  if (b.classList.contains("lb-pin")) b.textContent = on ? "★ Bookmarked" : "☆ Bookmark";
  else { b.textContent = on ? "★" : "☆"; b.setAttribute("aria-label", "Bookmark"); }
}
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

/* ---- Accessibility: modal dialog focus management ------------------------ */
// Overlays (lightbox, command palette, profile/context modals) are plain divs.
// These helpers make them behave like real dialogs: expose role/aria-modal, trap
// Tab focus inside, move focus in on open, and restore focus to the opener on close.
//
// overlays form a STACK. They all share one z-index (styles.css)
// and are appended to <body> as they open, so DOM order is paint order and the
// last one in the DOM is the top layer. Escape pops only that layer; each
// layer remembers its own opener (box._opener) so closing the top one hands
// focus back into the layer below instead of to a single global opener.
//
// the mobile More sheet (persistent markup, a layer only while .on) and
// the onboarding card join the same stack; a layer that isn't simply removed
// supplies its own box._close().
const MODAL_SEL = ".sheet.on, .filters.open, .onboard, .cmdk, .ctx-modal, .kb-modal, .cal-modal, .lightbox, .profile-modal, .share-modal";
function topModal() {
  const all = document.querySelectorAll(MODAL_SEL);
  return all.length ? all[all.length - 1] : null;
}
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])';
function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE_SEL)]
    .filter((n) => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
}
function trapTab(e) {
  if (e.key !== "Tab") return;
  const box = e.currentTarget;
  if (box.getAttribute("aria-modal") !== "true") return;   // a box that is only sometimes a dialog (the filter bar)
  const f = focusablesIn(box);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], act = document.activeElement;
  if (e.shiftKey && (act === first || !box.contains(act))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (act === last || !box.contains(act))) { e.preventDefault(); first.focus(); }
}
function applyDialog(box, label, opts) {
  opts = opts || {};
  box._opener = opts.opener !== undefined ? opts.opener : document.activeElement;   // remember who opened it
  // was the story paused by keyboard focus? A dialog replacing one of its own
  // kind passes the first one's answer along with its opener: the story lost
  // focus to the first dialog, so asking again would always say no.
  box._wrFocusHeld = opts.focusHeld !== undefined ? !!opts.focusHeld : wrHolds.has("focus");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  if (label) box.setAttribute("aria-label", label);
  if (!box._trapped) { box.addEventListener("keydown", trapTab); box._trapped = true; }   // a reused box (the More sheet) traps once
  const initial = (opts.initial && box.querySelector(opts.initial)) || focusablesIn(box)[0];
  if (initial && initial.focus) { try { initial.focus(); } catch (e) {} }
  paintWrappedPlay();   // any dialog pauses the Wrapped story
}
// Call after `box` has been removed. Falls back to the first focusable of the
// layer now on top when the opener is gone, so focus never drops to <body>
// behind a still-open modal.
function restoreFocus(box) {
  paintWrappedPlay();   // the story resumes once the last dialog is gone
  const o = box && box._opener;
  if (o && o.focus && document.contains(o) && o !== document.body) {
    try { o.focus(); } catch (e) {}
    // focus handed back to the story is not the user moving there by keyboard
    // (Escape makes it :focus-visible): keep the pause only if it was there
    if (o.id === "wr-stage" && !box._wrFocusHeld) wrHold("focus", false);
    return;
  }
  const t = topModal();
  const f = t && focusablesIn(t)[0];
  if (f) { try { f.focus(); } catch (e) {} }
}
// Close ONLY the top layer. Returns true if one was dismissed.
function closeTopModal() {
  const top = topModal();
  if (!top) return false;
  if (top === lbState.box) closeLightbox();
  else if (top._close) top._close();
  else { top.remove(); restoreFocus(top); }
  return true;
}

/* ---- Time → index (binary search; MSGS is sorted ascending by t) --------- */
// First message index at/after epoch t (N if every message is earlier).
function indexAtOrAfter(t) {
  let lo = 0, hi = N;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (MSGS[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}
// initials moved to src/shared-core.js (destructured at the top of this IIFE).

// No committed profile pictures (the real ones are private). Sources, lowest to
// highest priority: a gitignored local.js (window.LOCAL_PFPS, file paths) and
// in-app uploads stored as data URLs in settings.pfps (so file:// editing works
// without the server). Mutated in place by the People-tab pfp uploader.
const PFPS = Object.assign({}, (typeof window !== "undefined" && window.LOCAL_PFPS) || {}, settings.pfps);

function applyPfp(av, id, name) {
  av.dataset.id = id;
  av.classList.add("av-clickable");
  const photo = sanitizePhoto(PFPS[id]);
  if (photo) {
    av.style.backgroundImage = `url('${photo}')`;
    av.style.backgroundSize = "cover";
    av.style.backgroundPosition = "center";
    av.style.backgroundRepeat = "no-repeat";
    av.textContent = "";
  } else {
    const { p, f } = personColor(id);
    av.style.backgroundImage = "";     // clear any prior photo; CSS .av gradient uses --p/--f
    av.style.setProperty("--p", p);
    av.style.setProperty("--f", f);
    av.textContent = initials(name || nameOf(id));
  }
}

// name: the label shown beside it, when that isn't nameOf(id) (another chat's)
function pfpHtml(id, styleStr, name) {
  const photo = sanitizePhoto(PFPS[id]);
  if (photo) {
    return `<span class="av av-clickable" data-id="${esc(id)}" style="${styleStr};background-image:url('${esc(photo)}');background-size:cover;background-position:center;background-repeat:no-repeat;"></span>`;
  }
  const hue = personColor(id);
  return `<span class="av av-clickable" data-id="${esc(id)}" style="${styleStr};--p:${esc(hue.p)};--f:${esc(hue.f)}">${esc(initials(name || nameOf(id)))}</span>`;
}

/* ---- Participants & derived stats (computed once) ------------------------ */
// PARTS is computed per-conversation by activateConversation()
let STATS = null;
// Messages containing a Twitter/X link are useless for telling people apart, so
// they're excluded from the naming samples entirely (not only when they *start*
// with a URL). A few shared-media paths are collected as extra memory jogs.
// (X_LINK moved to src/shared-core.js — destructured at the top of this IIFE.)
function computeParticipants() {
  const map = new Map();
  for (let i = 0; i < N; i++) {
    const m = MSGS[i]; let p = map.get(m.s);
    // firstIdx: the index of their first message. Looking it up by
    // time later is wrong when timestamps tie (it lands on whoever is last).
    if (!p) { p = { id: m.s, count: 0, first: m.t, firstIdx: i, last: m.t, samples: [], media: [] }; map.set(m.s, p); }
    p.count++; if (m.t < p.first) { p.first = m.t; p.firstIdx = i; } if (m.t > p.last) p.last = m.t;
    if (p.samples.length < 120) { const t = (m.x || "").trim(); if (t.length > 14 && !/^https?:/.test(t) && !X_LINK.test(t)) p.samples.push(t); }
    if (m.m && p.media.length < 6) p.media.push({ m: m.m, k: m.k });
  }
  const arr = [...map.values()].sort((a, b) => b.count - a.count);
  // members who never posted — on the roster (conversation.participants),
  // reacting only, or only in a join / leave event — are people too. They go
  // after every sender (so senders keep their "User N" numbers), in the order
  // they are first seen: roster, then reactions, then events. Ignored users
  // never come back this way.
  const ignored = ignoredUserIds();
  const quiet = (id) => {
    if (id == null || id === "") return;
    id = String(id);
    if (map.has(id) || ignored.has(id)) return;
    const p = { id, count: 0, first: null, firstIdx: -1, last: null, samples: [], media: [] };
    map.set(id, p); arr.push(p);
  };
  ((CONV && CONV.participants) || []).forEach(quiet);
  for (let i = 0; i < N; i++) { const r = MSGS[i].r; if (r) r.forEach((x) => quiet(x.s)); }
  (EVENTS || []).forEach((e) => { (e.ids || []).forEach(quiet); quiet(e.s); });
  // Prefer longer (more distinctive) lines, dedupe, keep 5–10 per person.
  arr.forEach((p) => {
    const seen = new Set();
    p.samples = p.samples.sort((a, b) => b.length - a.length)
      .filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 10);
  });
  return arr;
}

/* ---- Theme --------------------------------------------------------------- */
function applyTheme() {
  // Surfaces (bg/border/text) come from the html[data-theme] block in styles.css.
  // applyTheme only layers the user's customizable accent + font-size + density.
  const r = document.documentElement.style;
  // Defense in depth: settings are validated on load/import, but never
  // let a non-hex accent reach shade()/hexA() — they would throw and brick boot.
  const accent = sanitizeColor(settings.accent) || DEFAULTS.accent;
  r.setProperty("--accent", accent);
  r.setProperty("--accent-hover", shade(accent, -8));   // slightly darker (hover)
  r.setProperty("--accent-deep", shade(accent, -20));   // gradient deep end
  r.setProperty("--accent-soft", shade(accent, 25));    // lighter tint
  r.setProperty("--accent-glow", hexA(accent, 0.35));
  applyAccentTokens();
  const fs = +settings.fontSize;
  r.setProperty("--font-size", (isFinite(fs) ? Math.min(FONT_MAX, Math.max(FONT_MIN, fs)) : DEFAULTS.fontSize) + "px");
  const dc = DENSITY[settings.density] || DENSITY.comfortable;
  r.setProperty("--gap", dc.gap); r.setProperty("--bubble-pad", dc.pad);
  const app = document.getElementById("app");
  app.classList.toggle("no-avatars", !settings.avatars);
  app.classList.toggle("no-timestamps", !settings.timestamps);
  refreshChartTheme();    // open charts follow the new accent
}

// text on a filled accent, the fill, the .msg.me gradient's far end and
// accent-as-text all derive from the accent's luminance against the ACTIVE
// theme's surfaces (GCAShared.accentTokens), so a light accent gets near-black
// text instead of 2–3:1 white. Re-run on every accent AND theme change; the
// Stats charts read the same tokens through chartTheme().
function applyAccentTokens() {
  const r = document.documentElement.style;
  const accent = sanitizeColor(settings.accent) || DEFAULTS.accent;
  const bgs = THEME_BGS[document.documentElement.getAttribute("data-theme")] || THEME_BGS.lightsout;
  const k = accentTokens(accent, bgs);
  r.setProperty("--on-accent", k.onAccent);
  r.setProperty("--accent-fill", k.fill);
  r.setProperty("--accent-grad-end", k.gradEnd);
  r.setProperty("--accent-text", k.text);
  r.setProperty("--accent-text-soft", readableOn(shade(accent, 25), bgs, 4.5));
  r.setProperty("--accent-ui", k.ui);
  // the lightbox is a near-black scrim in every theme (over white it is
  // #1f1f1f), so its link is derived against that, not the theme
  r.setProperty("--accent-on-scrim", readableOn(accent, SCRIM_BGS, 4.5));
}
const SCRIM_BGS = ["#000000", "#262626"];

/* ---- Theme modes (X: Light / Dim / Lights out) --------------------------- */
// Persisted under its own gca.theme key (separate from gca.settings) and applied
// as data-theme on <html>; the html[data-theme] block in styles.css owns every
// surface. Drives the compact .theme-toggle groups (sidebar footer + More
// sheet) and the Settings control, and keeps <meta name="theme-color">
// on the theme's page background (theme-boot.js does the same pre-paint).
const THEME_KEY = "gca.theme";
const THEMES = ["light", "dim", "lightsout"];
// [--bg-page, --bg-card] per theme — mirrors the html[data-theme] blocks in
// styles.css (tests/a11y-contrast.spec.js checks they agree). Feeds the theme-color
// meta and the contrast derivations (accent tokens, person-colour overrides).
const THEME_BGS = { light: ["#ffffff", "#f7f9f9"], dim: ["#15202b", "#1e2732"], lightsout: ["#000000", "#16181c"] };
function getTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (THEMES.indexOf(t) !== -1) return t; } catch (e) { /* ignore */ }
  return "lightsout";
}
function reflectTheme(t) {
  document.querySelectorAll(".theme-toggle button[data-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.set === t)));
  const seg = document.getElementById("set-theme");
  if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.v === t));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_BGS[t][0]);
}
function setTheme(t) {
  if (THEMES.indexOf(t) === -1) t = "lightsout";
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  reflectTheme(t);
  applyAccentTokens();    // accent-as-text is re-derived for the new surfaces
  refreshChartTheme();    // open charts follow the new surface tokens
}
function initTheme() {
  setTheme(getTheme());
  document.querySelectorAll(".theme-toggle button[data-set]").forEach((b) => {
    b.addEventListener("click", () => setTheme(b.dataset.set));
  });
}

/* ---- Mobile chrome (top bar + bottom tab bar + "More" sheet) -------------- */
// ≤760px replaces the sidebar with the mock's mobile experience: a fixed top
// app bar (brand mark + conv picker + palette button), a 5-tab bottom bar
// (Search / Timeline / Gallery / Stats / More) and a bottom sheet holding the
// remaining views. Everything is element-guarded so non-DOM contexts and the
// desktop layout (where all of it is display:none) are unaffected.
function mobileSheetOpen() {
  const sheet = document.getElementById("more-sheet");
  const scrim = document.getElementById("sheet-scrim");
  if (!sheet || !scrim) return;
  sheet.classList.add("on"); scrim.classList.add("on");
  // a real modal while open — reachable, focus moved in and trapped,
  // Esc (closeTopModal → _close) or the scrim closes it back to its opener.
  sheet.inert = false; sheet.removeAttribute("aria-hidden");
  sheet._close = mobileSheetClose;
  applyDialog(sheet, "More views", { initial: ".sh-item" });
}
// Returns true if the sheet was open (so Escape handling can stop there).
function mobileSheetClose() {
  const sheet = document.getElementById("more-sheet");
  if (!sheet || !sheet.classList.contains("on")) return false;
  sheet.classList.remove("on");
  const scrim = document.getElementById("sheet-scrim");
  if (scrim) scrim.classList.remove("on");
  // closed = out of the Tab order and the accessibility tree
  sheet.inert = true; sheet.setAttribute("aria-hidden", "true");
  restoreFocus(sheet);
  return true;
}
// Mirror .nav-item.active onto the tab bar: the four tab views light their own
// tab; any sheet view lights "More" plus its .sh-item.
function reflectMobileNav(name) {
  const tabs = document.querySelectorAll(".tabbar .tab[data-tab]");
  if (!tabs.length) return;
  let tabbed = false;
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    if (on) tabbed = true;
    t.classList.toggle("active", on);
  });
  let inSheet = false;
  document.querySelectorAll(".sheet .sh-item").forEach((it) => {
    const on = it.dataset.tab === name;
    if (on) inSheet = true;
    it.classList.toggle("active", on);
  });
  const more = document.getElementById("tab-more");
  if (more) more.classList.toggle("active", !tabbed && inSheet);
}
// Keep the top-bar picker in lockstep with the sidebar: name mirrors
// #brand-title (so per-group renames flow through), count mirrors N, and the
// invisible <select> overlay carries the same options as #conv-select. With a
// single conversation the chevron hides and the select goes inert.
function syncMobileConvPicker() {
  const pick = document.getElementById("mpick");
  const sel = document.getElementById("mobile-conv");
  if (!pick || !sel) return;
  const brand = document.getElementById("brand-title");
  const nm = document.getElementById("mpick-nm");
  const ct = document.getElementById("mpick-ct");
  if (nm) nm.textContent = (brand && brand.textContent) || displayConvName(CONV);
  if (ct) ct.textContent = "· " + fmtNum(N);
  const convos = visibleConvos();
  sel.innerHTML = convos.map((c) =>
    `<option value="${esc(c.id)}"${CONV && c.id === CONV.id ? " selected" : ""}>${esc(displayConvName(c))} · ${fmtNum(c.count)}</option>`
  ).join("");
  const single = convos.length <= 1;
  pick.classList.toggle("single", single);
  sel.disabled = single;
}
function initMobileChrome() {
  document.querySelectorAll(".tabbar .tab[data-tab]").forEach((t) => {
    t.addEventListener("click", () => setView(t.dataset.tab));
  });
  const more = document.getElementById("tab-more");
  if (more) more.addEventListener("click", mobileSheetOpen);
  const scrim = document.getElementById("sheet-scrim");
  if (scrim) scrim.addEventListener("click", mobileSheetClose);
  document.querySelectorAll(".sheet .sh-item[data-tab]").forEach((it) => {
    it.addEventListener("click", () => { mobileSheetClose(); setView(it.dataset.tab); });
  });
  const rand = document.getElementById("sh-random");
  if (rand) rand.addEventListener("click", () => { mobileSheetClose(); jumpTo(Math.floor(Math.random() * N)); });
  // the Timeline toolbar (and its "Jump to date") is hidden on
  // phones, so the calendar has its own More-sheet entry. Closing the sheet
  // first hands focus back to More, which the calendar then returns to.
  const cal = document.getElementById("sh-calendar");
  if (cal) cal.addEventListener("click", () => { mobileSheetClose(); if (curView !== "timeline") setView("timeline"); openCalendar(); });
  const mic = document.getElementById("mic-jump");
  if (mic) mic.addEventListener("click", () => openCommandPalette());
  const sel = document.getElementById("mobile-conv");
  if (sel) sel.addEventListener("change", (e) => activateConversation(e.target.value, true));
  syncMobileConvPicker();
}

/* ---- Text rendering (linkify + highlight) -------------------------------- */
function renderText(raw, urls) {
  const shorts = {}; (urls || []).forEach((u) => { if (u.s) shorts[u.s] = { e: u.e, d: u.d }; });
  const re = /https?:\/\/[^\s]+/g;
  let out = "", last = 0, m;
  while ((m = re.exec(raw))) {
    out += esc(raw.slice(last, m.index));
    let u = m[0], trail = "";
    const tm = u.match(/[)\].,!?]+$/); if (tm) { trail = tm[0]; u = u.slice(0, -trail.length); }
    const info = shorts[u];
    const href = info ? info.e : u;
    const label = info ? (info.d || info.e) : u;
    // Only http/https/mailto become live links. An "expanded" URL comes from the
    // export and is attacker-influenceable, so a javascript:/data: scheme is
    // rendered as inert text rather than a clickable anchor.
    const safe = /^(?:https?:|mailto:)/i.test(String(href).trim());
    out += safe
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + "</a>" + esc(trail)
      : esc(label) + esc(trail);
    last = m.index + m[0].length;
  }
  out += esc(raw.slice(last));
  return out;
}

/* ---- Timeline liveliness helpers (mock-timeline.html parity) -------------- */
// Sticky day pill: "Saturday, <b>May 23, 2020</b>" — weekday plain, date bold
// (split on the first comma of the DAY format). Outer class stays `daysep`.
function renderDaySep(t, cont) {
  const label = DAY.format(t);
  const ci = label.indexOf(",");
  const inner = ci > 0
    ? esc(label.slice(0, ci + 1)) + " <b>" + esc(label.slice(ci + 1).trim()) + "</b>"
    : "<b>" + esc(label) + "</b>";
  const d = el("div", "daysep" + (cont ? " cont" : ""), '<span class="daypill">' + inner + "</span>");
  // a continuation pill repeats the day already announced in an earlier
  // chunk purely so the sticky header survives the chunk seam — zero height,
  // and hidden from assistive tech so the day isn't read out twice.
  if (cont) d.setAttribute("aria-hidden", "true");
  return d;
}

// Rich link chip (mock .linkchip structure; class stays `urlchip`): icon box +
// bold domain line + dim ellipsized label. Domain via new URL() in a try/catch;
// non-URL hrefs (local media paths) fall back to the path's basename.
const CHIP_LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 15l6-6M9.5 8.5l1.4-1.4a3.5 3.5 0 015 5l-1.4 1.4M14.5 15.5l-1.4 1.4a3.5 3.5 0 01-5-5l1.4-1.4"/></svg>';
// Media paths come from data.js: only an http(s) URL or a file: URL on this
// machine becomes a link or a photo/video source (GCAShared.safeMediaUrl has
// the rules). The same check gates every photo and video src, which would
// fetch it without a click.
function safeHref(p) { return safeMediaUrl(p, location.href); }
function urlChipEl(href, lbl) {
  let dom;
  try { dom = new URL(href).hostname.replace(/^www\./, ""); }
  catch (err) { dom = String(href).split(/[?#]/)[0].split("/").pop() || String(href); }
  const a = el("a", "urlchip");
  const safe = safeHref(href);
  if (safe) a.href = safe;
  a.target = "_blank";
  a.innerHTML = '<span class="g">' + CHIP_LINK_ICON + '</span>' +
    '<span class="lt"><span class="dom">' + esc(dom) + '</span><span class="lbl">' + esc(lbl) + "</span></span>";
  return a;
}

/* ---- Message card -------------------------------------------------------- */
function renderMsg(i, opts) {
  opts = opts || {};
  const m = MSGS[i], id = m.s;
  const me = opts.context && settings.me === id;
  const isConsecutive = !!opts.consecutive;
  const wrap = el("div", "msg" + (me ? " me" : "") + (isConsecutive ? " consecutive" : "") + (opts.clickable ? " clickable" : ""));
  wrap.dataset.idx = i;

  const av = el("div", "av"); applyPfp(av, id);
  wrap.appendChild(av);

  const body = el("div", "msg-body");
  const head = el("div", "msg-head");
  const nm = el("span", "msg-name"); nm.textContent = nameOf(id); nm.style.color = personColor(id).p;
  const tm = el("span", "msg-time"); tm.textContent = DT.format(m.t);
  head.appendChild(nm); head.appendChild(tm); body.appendChild(head);

  // Copy and Share only make sense with text — on a media-only message
  // Copy used to copy "" and still toast "Copied text".
  const hasText = !!(m.x || "").trim();
  const acts = msgActions(wrap, m, { i }, [hasText && "copy", "context", hasText && "share", "jump", "link"]);
  body.appendChild(acts);

  const txt = (m.x || "").trim();
  if (txt) {
    const bubbleEl = el("div", "bubble");
    bubbleEl.dir = "auto";   // Arabic/Hebrew lines take their own base direction
    bubbleEl.innerHTML = renderText(m.x, m.u);
    if (isConsecutive) bubbleEl.dataset.time = DT.format(m.t);
    // fuzzy match ranges (when present) index into LOWER[i], which maps
    // 1:1 onto the rendered text only when (a) lowercasing preserved length
    // (true for ASCII/most text, NOT e.g. "İ" which lowercases to 2 code
    // units) and (b) renderText didn't swap a t.co short link for its expanded
    // label. Both are cheap to verify here; when either fails, fall back to
    // literal-needle highlighting rather than misplace marks.
    if (opts.ranges && opts.ranges.length && LOWER[i].length === m.x.length && bubbleEl.textContent === m.x) {
      highlightRangesDOM(bubbleEl, opts.ranges);
    } else {
      highlightDOM(bubbleEl, opts.needles);
    }
    body.appendChild(bubbleEl);
  }
  if (m.m) {
    const md = renderMedia(m, i);
    // a consecutive message hides its header and shows its time as a
    // hover tooltip on the bubble; a media-only one has no bubble, so the
    // media block carries the time instead.
    if (isConsecutive && !txt) md.title = DT.format(m.t);
    body.appendChild(md);
  }
  if (m.r) body.appendChild(renderReacts(m.r));
  wrap.appendChild(body);

  if (opts.clickable) cardActivation(wrap, () => jumpTo(i));
  else msgFocusable(wrap, m);
  return wrap;
}
// the per-message action toolbar. A mouse reveals it on hover; a
// keyboard user tabs to the message (a focusable article) and on into the
// toolbar, which shows while focus is inside the card; a touch user — who has
// no hover — opens it with the "⋯" button. Running an action closes it.
// the buttons only carry data-act; ONE delegated listener (below) runs
// them for every message on the page — Search, Timeline, Pinned, Hall of
// Fame, Context peek — instead of 4-6 closures per rendered message. What an
// action needs is kept on the card (wrap._msgAct: the message, its index in
// the active chat, or the conversation of a foreign pin).
const MSG_ACT_LABELS = { copy: "Copy", context: "Context", share: "Share", jump: "Jump", link: "Link" };
// Buttons whose visible text is short get a fuller accessible name (it still
// contains the visible word — WCAG 2.5.3).
const MSG_ACT_NAMES = { link: "Copy link to message" };
function msgActions(wrap, m, ctx, keys) {
  wrap._msgAct = { m, i: ctx.i, conv: ctx.conv };
  const acts = el("div", "msg-acts");
  acts.setAttribute("role", "toolbar");
  acts.setAttribute("aria-label", "Message actions");
  const actPin = el("button", "act-pin");
  actPin.type = "button"; actPin.dataset.act = "pin"; actPin.dataset.mid = m.i; setPinBtn(actPin, isPinned(m.i));
  acts.appendChild(actPin);
  keys.forEach((k) => {
    if (!k) return;
    const b = el("button", "", MSG_ACT_LABELS[k]); b.type = "button"; b.dataset.act = k;
    if (MSG_ACT_NAMES[k]) { b.setAttribute("aria-label", MSG_ACT_NAMES[k]); b.title = MSG_ACT_NAMES[k]; }
    acts.appendChild(b);
  });
  const more = el("button", "msg-more", "⋯");
  more.type = "button"; more.dataset.act = "more";
  more.setAttribute("aria-label", "Message actions");
  more.setAttribute("aria-expanded", "false");
  wrap.appendChild(more);
  return acts;
}
function copyMsgText(m) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(m.x).then(() => toast("Copied text")).catch(() => toast("Copy failed"));
  } else {
    toast("Copy failed");
  }
}
// Switch to a (possibly other) conversation and jump to one of its messages.
function jumpToConvMsg(convId, mid) {
  activateConversation(convId, true);
  const idx = ID2IDX.get(mid);
  jumpTo(idx == null ? 0 : idx);
}
const MSG_ACTS = {
  copy: (a) => copyMsgText(a.m),
  context: (a) => openContextPeek(a.i),
  // the toolbar hides once the dialog takes focus: hand focus back to the
  // message itself (a Tab stop that shows the toolbar again)
  share: (a, wrap) => shareMessage(a.i, a.hof, wrap),
  jump: (a) => (a.conv != null ? jumpToConvMsg(a.conv, a.m.i) : jumpTo(a.i)),
  link: (a) => copyMsgLink(a.conv != null ? a.conv : CONV.id, a.m.i),
};
// Capture phase + stopPropagation: like the old per-button handlers, an action
// click never reaches the card's own click (open / jump) or any list handler.
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".msg-acts [data-act], .msg > .msg-more[data-act]");
  if (!b) return;
  const wrap = b.closest(".msg"), a = wrap && wrap._msgAct;
  if (!a) return;
  e.stopPropagation();
  const k = b.dataset.act;
  if (k === "more") {
    const open = !wrap.classList.contains("acts-open");
    closeMsgActs();
    if (open) { wrap.classList.add("acts-open"); b.setAttribute("aria-expanded", "true"); }
  } else if (k === "pin") {
    togglePin(a.m.i); closeMsgActs();
  } else if (MSG_ACTS[k]) {
    closeMsgActs(); MSG_ACTS[k](a, wrap);
  }
}, true);
function closeMsgActs() {
  let closed = false;
  document.querySelectorAll(".msg.acts-open").forEach((w) => {
    const b = w.querySelector(".msg-more");
    // On touch the closed toolbar is display:none, which would drop a
    // keyboard user's focus to <body> — hand it back to this message's ⋯.
    const acts = w.querySelector(".msg-acts");
    const hadFocus = !!(acts && acts.contains(document.activeElement));
    w.classList.remove("acts-open"); closed = true;
    if (b) { b.setAttribute("aria-expanded", "false"); if (hadFocus) b.focus(); }
  });
  return closed;
}
// A timeline message (not a whole-card link) is a focusable article, so the
// keyboard can reach it and then its actions.
function msgFocusable(wrap, m) {
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "article");
  wrap.setAttribute("aria-label", nameOf(m.s) + ", " + DT.format(m.t));
}
// a whole-card click/Enter target (Search results, bookmark cards) must
// not hijack its interactive children — a link opens only the link, an avatar
// only the profile, a video only plays, and Enter on a focused link follows
// the link. The card acts on clicks that land on its own non-interactive
// parts, and on Enter/Space only while the card itself has focus.
// (Only a video WITH controls is its own target — a gallery cell's bare
// preview <video> is part of the cell.)
const CARD_CHILD_SEL = "a, button, input, select, textarea, label, video[controls], .av-clickable";
function cardActivation(wrap, go) {
  wrap.tabIndex = 0;
  wrap.addEventListener("click", (e) => { if (e.target.closest(CARD_CHILD_SEL)) return; go(); });
  wrap.addEventListener("keydown", (e) => {
    if (e.target !== wrap) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
  });
}
// the one helper for a click target that has to stay a <div> because it
// holds structured content (gallery cells, thread / chain / Hall-of-Fame cards,
// stats bars): role=button, a Tab stop, Enter/Space, children keep their own
// clicks. Plain labelled targets (chips, swatches, dots) are real <button>s.
function asButton(node, go, label) {
  node.setAttribute("role", "button");
  if (label) node.setAttribute("aria-label", label);
  cardActivation(node, go);
  return node;
}
// an empty state says what happened, what to do, and offers the next
// step as a button (cta = [label, fn]).
function emptyState(icon, title, hint, cta) {
  const d = el("div", "empty", '<div class="big">' + cmdIco(icon) + '</div><div class="empty-title">' + esc(title) + "</div>" +
    (hint ? '<div class="hint">' + esc(hint) + "</div>" : ""));
  if (cta) { const b = btnEl("btn primary sm empty-cta", esc(cta[0])); b.onclick = cta[1]; d.appendChild(b); }
  return d;
}
// A real <button> with a type, an accessible name and optional pressed state.
function btnEl(cls, html, label, pressed) {
  const b = el("button", cls, html);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  if (pressed != null) b.setAttribute("aria-pressed", pressed ? "true" : "false");
  return b;
}
function renderMedia(m, i) {
  const d = el("div", "media");
  if (m.k === "img") {
    const img = el("img"); img.loading = "lazy"; img.src = safeHref(m.m);
    img.alt = "Photo from " + nameOf(m.s) + " · " + DT.format(m.t);
    // A search result walks the result media; anywhere else (timeline, a
    // Context peek — even over Search) walks the conversation's media.
    // the image is its own Tab stop (Enter/Space open it too) — the
    // message around it is focusable but can't open the lightbox itself.
    asButton(img, () => openLightbox(i, img.closest("#s-list") ? resState.idx : null), "Open photo from " + nameOf(m.s) + " · " + DT.format(m.t));
    img.addEventListener("click", (e) => e.stopPropagation());   // not the card's own click
    d.appendChild(img);
  } else if (m.k === "vid") {
    const v = document.createElement("video"); v.src = safeHref(m.m); v.controls = true; v.preload = "none";
    v.setAttribute("aria-label", "Video from " + nameOf(m.s) + " · " + DT.format(m.t));
    v.addEventListener("click", (e) => e.stopPropagation());
    d.appendChild(v);
  } else {
    d.appendChild(urlChipEl(m.m, "media file"));
  }
  appendMoreMedia(d, m);
  return d;
}
// a DM can carry several files. The build keeps the first as m/k (what
// the lightbox, gallery and stats read) and the rest in m.mx; show those as a
// row of small thumbnails under the first. Each extra photo is a plain link
// (keyboard-reachable, opens the full file); videos keep their controls.
// name: the sender as the row shows them (another chat's row passes its own).
function appendMoreMedia(d, m, name) {
  if (!Array.isArray(m.mx) || !m.mx.length) return;
  const row = el("div", "media-more");
  const total = m.mx.length + 1;
  const who = (name || nameOf(m.s)) + " · " + DT.format(m.t);
  m.mx.forEach((x, j) => {
    if (!x || !x.m) return;
    let node;
    if (x.k === "img") {
      node = el("a", "media-more-item");
      const safe = safeHref(x.m);
      if (safe) node.href = safe;
      node.target = "_blank"; node.rel = "noopener";
      node.setAttribute("aria-label", "Open photo " + (j + 2) + " of " + total + " from " + who);
      const img = el("img"); img.loading = "lazy"; img.src = safeHref(x.m); img.alt = "";
      node.appendChild(img);
    } else if (x.k === "vid") {
      node = document.createElement("video"); node.className = "media-more-item";
      node.src = safeHref(x.m); node.controls = true; node.preload = "none";
      node.setAttribute("aria-label", "Video " + (j + 2) + " of " + total + " from " + who);
    } else {
      node = urlChipEl(x.m, "media file");
    }
    node.addEventListener("click", (e) => e.stopPropagation());   // not the card's own click
    row.appendChild(node);
  });
  d.appendChild(row);
}
function renderReacts(r, nameFn) {
  const wrap = el("div", "reacts");
  // Group by an effective key that distinguishes custom-emoji glyphs:
  // plain reaction keys ("funny", "like", ...) group as before, but a
  // captured custom glyph (x.e, only ever set when x.k === "emoji") gets its
  // own group per distinct glyph instead of collapsing every custom emoji
  // into one generic REACT.emoji ("💬") bucket.
  const groups = new Map();   // gk -> { k, e, senders: [] }
  r.forEach((x) => {
    const gk = (x.k === "emoji" && x.e) ? "emoji " + x.e : x.k;
    let g = groups.get(gk);
    if (!g) { g = { k: x.k, e: x.e, senders: [] }; groups.set(gk, g); }
    g.senders.push(x.s);
  });
  groups.forEach((g) => {
    // g.e is untrusted export data (X's raw reaction payload) — it MUST be
    // escaped before it enters innerHTML (via el()) or the title, exactly
    // like renderText() escapes message bodies. Never insert it raw.
    const isCustom = g.k === "emoji" && g.e;
    const glyph = isCustom ? esc(g.e) : (REACT[g.k] || "•");
    const label = isCustom ? esc(g.e) : g.k;
    const c = el("span", "react", glyph + ' <span class="who">' + g.senders.length + "</span>");
    c.title = label + " — " + g.senders.map(nameFn || nameOf).join(", ");
    wrap.appendChild(c);
  });
  return wrap;
}

/* ---- Lightbox ------------------------------------------------------------ */
let lbState = { idxList: [], pos: 0, box: null, opener: null };

// only images and videos are lightbox slides — "file" media
// (pdf, …) is a link chip, never a (broken) <img>.
function isViewable(i) { const m = MSGS[i]; return !!(m && m.m && (m.k === "img" || m.k === "vid")); }
function convMediaList() { const out = []; for (let i = 0; i < N; i++) if (isViewable(i)) out.push(i); return out; }

// `list` is the ordered set the arrows walk, supplied by the caller so they
// follow what the user is looking at: newest-first Gallery, the ranked
// Hall of Fame set, the search results. When the list doesn't contain `i`
// (e.g. a neighbour photo in Context peek over Search) or no list is
// given, fall back to the conversation's media in date order.
function openLightbox(i, list) {
  if (!isViewable(i)) return;
  let idx = (list || []).filter(isViewable);
  if (idx.indexOf(i) < 0) idx = convMediaList();
  // Re-opening over an open lightbox keeps the ORIGINAL opener.
  const opener = lbState.box ? lbState.opener : document.activeElement;
  if (lbState.box) { lbState.box.remove(); lbState.box = null; }
  lbState.opener = opener;
  lbState.idxList = idx;
  lbState.pos = idx.indexOf(i);
  renderLightbox();
}
function closeLightbox() {
  const box = lbState.box;
  if (!box) return;
  box.remove(); lbState.box = null;
  document.removeEventListener("keydown", lbKeyHandler);
  restoreFocus(box);
}

function renderLightbox() {
  if (lbState.box) lbState.box.remove();
  const i = lbState.idxList[lbState.pos];
  const m = MSGS[i];
  const box = el("div", "lightbox");
  lbState.box = box;
  
  const close = closeLightbox;
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  
  // one top toolbar inside the safe area — "n / N", then bookmark,
  // download and close — instead of controls pinned at separate corners
  // (Download used to sit over the sidebar brand).
  const bar = el("div", "lb-bar");
  const n = lbState.idxList.length;
  const count = el("span", "lb-count", (lbState.pos + 1) + " / " + n);
  count.setAttribute("aria-label", "Item " + (lbState.pos + 1) + " of " + n);
  bar.appendChild(count);
  bar.appendChild(el("span", "lb-grow"));

  const lbPin = el("button", "lb-pin act-pin");
  lbPin.type = "button"; lbPin.dataset.mid = m.i; setPinBtn(lbPin, isPinned(m.i));
  lbPin.onclick = (e) => { e.stopPropagation(); togglePin(m.i); };
  bar.appendChild(lbPin);

  const dl = el("a", "lb-dl", "↓ Download");
  const safeDl = safeHref(m.m);
  if (safeDl) dl.href = safeDl;
  dl.download = String(m.m || "").split('/').pop() || "media";
  dl.onclick = (e) => e.stopPropagation();
  bar.appendChild(dl);

  const x = btnEl("lb-close", "✕", "Close"); x.onclick = close; bar.appendChild(x);
  bar.addEventListener("click", (e) => e.stopPropagation());
  box.appendChild(bar);

  if (lbState.pos > 0) {
    const prev = btnEl("lb-nav lb-prev", "‹", "Previous");
    prev.onclick = (e) => { e.stopPropagation(); lbState.pos--; renderLightbox(); };
    box.appendChild(prev);
  }
  if (lbState.pos < lbState.idxList.length - 1) {
    const next = btnEl("lb-nav lb-next", "›", "Next");
    next.onclick = (e) => { e.stopPropagation(); lbState.pos++; renderLightbox(); };
    box.appendChild(next);
  }
  
  let mediaEl;
  if (m.k === "vid") {
    mediaEl = document.createElement("video"); mediaEl.src = safeHref(m.m); mediaEl.controls = true; mediaEl.autoplay = true;
    mediaEl.onclick = (e) => e.stopPropagation();
  } else {
    mediaEl = el("img"); mediaEl.src = safeHref(m.m); mediaEl.alt = "Photo from " + nameOf(m.s) + " · " + DT.format(m.t);
    let scale = 1, panning = false, pointX = 0, pointY = 0, start = { x: 0, y: 0 };
    mediaEl.onmousedown = (e) => { e.preventDefault(); start = { x: e.clientX - pointX, y: e.clientY - pointY }; panning = true; };
    mediaEl.onmouseup = () => (panning = false);
    mediaEl.onmouseleave = () => (panning = false);
    mediaEl.onmousemove = (e) => { if (!panning) return; pointX = e.clientX - start.x; pointY = e.clientY - start.y; mediaEl.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`; };
    mediaEl.onwheel = (e) => {
      e.preventDefault();
      let xs = (e.clientX - pointX) / scale, ys = (e.clientY - pointY) / scale;
      let delta = (e.wheelDelta ? e.wheelDelta : -e.deltaY);
      (delta > 0) ? (scale *= 1.2) : (scale /= 1.2);
      pointX = e.clientX - xs * scale; pointY = e.clientY - ys * scale;
      mediaEl.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    };
  }
  box.appendChild(mediaEl);
  
  const cap = el("div", "lb-cap");
  cap.innerHTML = esc(nameOf(m.s) + " · " + DT.format(m.t)) + '  —  <a href="#">jump to message ↗</a>';
  cap.querySelector("a").onclick = (e) => { e.preventDefault(); close(); jumpTo(i); };
  box.appendChild(cap);
  
  document.body.appendChild(box);
  applyDialog(box, "Media viewer", { initial: ".lb-close", opener: lbState.opener });

  document.removeEventListener("keydown", lbKeyHandler);
  document.addEventListener("keydown", lbKeyHandler);
}

function lbKeyHandler(e) {
  // Escape is the global handler's job (closeTopModal) — handling it here too
  // closed two layers per keypress. Arrows only drive the lightbox
  // while it is the top layer (not under the keyboard help, say).
  if (!lbState.box || topModal() !== lbState.box) return;
  if (e.key === "ArrowLeft" && lbState.pos > 0) { lbState.pos--; renderLightbox(); }
  if (e.key === "ArrowRight" && lbState.pos < lbState.idxList.length - 1) { lbState.pos++; renderLightbox(); }
}

/* ---- Toast --------------------------------------------------------------- */
// (toastT and srT are declared near the top, before boot can call toast.)
// the visible toast is decoration for sighted users; the message is
// announced through the persistent #sr-status live region (index.html). It is
// cleared first so the same text twice in a row is announced again.
function announce(msg) {
  const live = document.getElementById("sr-status");
  if (!live) return;
  live.textContent = "";
  clearTimeout(srT);
  srT = setTimeout(() => { live.textContent = msg; }, 50);
}
// ms: how long it stays up (default 2.2 s; longer for an instruction to read).
function toast(msg, ms) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", "toast", esc(msg)); t.setAttribute("aria-hidden", "true"); document.body.appendChild(t);
  announce(msg);
  clearTimeout(toastT); toastT = setTimeout(() => { t.classList.add("fade-out"); setTimeout(() => t.remove(), 300); }, ms || 2200);
}

/* ===========================================================================
   SEARCH VIEW
   ======================================================================== */
// fromStr/toStr keep the raw "YYYY-MM-DD" the user picked: the inputs are
// re-filled from them when the toolbar is rebuilt, and from/to (epoch bounds
// in the configured zone) are recomputed from them when the timezone changes.
const F = { needles: [], people: new Set(), from: null, to: null, fromStr: "", toStr: "", media: false, links: false, reacts: false, grid: false, sort: "relevance", fuzzy: true };
function resetSearchFilters() {
  F.needles = []; F.people = new Set();
  F.from = null; F.to = null; F.fromStr = ""; F.toStr = "";
  F.media = false; F.links = false; F.reacts = false; F.grid = false;
}
// Epoch bounds for the stored date strings, in the CURRENT zone.
function syncDateBounds() {
  F.from = F.fromStr ? zonedDateBound(F.fromStr, false) : null;
  F.to = F.toStr ? zonedDateBound(F.toStr, true) : null;
  if (isNaN(F.from)) F.from = null;
  if (isNaN(F.to)) F.to = null;
}
let searchBuilt = false;
let sEls = {};
let sDeb = 0;   // the box's 150 ms search debounce
// resState.groups is set for an All chats run (see runSearchAll): the list is
// then a flat run of rows — each group's header followed by its messages.
let resState = { idx: [], page: 0, groups: null, rows: 0 };
let resObserver = null;

/* ---- "All chats" scope -------------------------------------------------
   One query across every visible conversation (removed groups never), results
   grouped per chat. A flag, not a filter: resetSearchFilters() leaves it alone
   and it survives a conversation switch; the address carries it as &s=all
   (navHash), the query text never. Indexes for the other chats are built on
   first use and cached per conversation (keyed on the ignored-people set and
   the message array, so un/ignoring someone rebuilds just that); the active
   chat reuses MSGS / LOWER. Exact tier only — no typo-tolerant pass across
   chats — so Fuzzy/Exact and Grid are hidden while it is on. */
let searchScope = "this";
const convSearchIdx = new Map();
function allScope() { return searchScope === "all" && visibleConvos().length > 1; }
function gridOn() { return F.grid && !allScope(); }
function setSearchScope(sc) {
  searchScope = sc === "all" ? "all" : "this";
  syncScopeUi();
  if (searchBuilt && sEls.input) { clearTimeout(sDeb); runSearch(); }
}
function syncScopeUi() {
  if (!sEls.scope) return;
  const all = allScope();
  sEls.scope.hidden = visibleConvos().length < 2;
  sEls.scope.querySelectorAll("button").forEach((b) => {
    const on = (b.dataset.scope === "all") === all;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  sEls.matchtoggle.hidden = all; sEls.viewtoggle.hidden = all; sEls.matchhint.hidden = all;
  sEls.input.placeholder = searchPlaceholder(all);
}
// The longest placeholder that fits the box: on a phone or a narrow window
// the hint after the count is dropped rather than cut off mid-word.
let phCtx = null;
function searchPlaceholder(all) {
  const el = sEls.input;
  const tiers = all ? ["Search all chats…  (exact words; use \"quotes\" for phrases)", "Search all chats…"]
    : [el.dataset.ph, el.dataset.phShort, "Search messages…"];
  const room = el.clientWidth;
  if (!room) return tiers[0];   // hidden: re-measured when it gets a size
  if (!phCtx) phCtx = document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(el);
  phCtx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  return tiers.find((t) => phCtx.measureText(t).width <= room) || tiers[tiers.length - 1];
}
// The chats an All chats run covers — the active one first, then picker order —
// each with its (lazily built) search data.
function scopeData() {
  const { set: ignored, key } = ignoredKeyed();
  const vis = visibleConvos();
  const isCur = (c) => !!CONV && c.id === CONV.id;
  return vis.filter(isCur).concat(vis.filter((c) => !isCur(c))).map((c) => {
    if (isCur(c)) return { conv: c, msgs: MSGS, lower: LOWER, active: true, senders: null };
    let d = convSearchIdx.get(c.id);
    if (!d || d.key !== key || d.src !== c.msgs) {
      const ms = withoutIgnored(c.msgs || [], ignored), lower = new Array(ms.length), senders = new Map();
      for (let i = 0; i < ms.length; i++) { lower[i] = searchText(ms[i]); senders.set(ms[i].s, (senders.get(ms[i].s) || 0) + 1); }
      d = { key, src: c.msgs, conv: c, msgs: ms, lower, active: false, senders };
      convSearchIdx.set(c.id, d);
    }
    return d;
  });
}
// The people a from: can name in the current scope: this chat's participants,
// or everyone who posts in a searched chat (ignored people are gone from both),
// once per chat, since an unnamed person is a different "User N" in each.
// [{ conv, id, count, names }]
function scopeEntries() {
  if (!allScope()) return PARTS.map((p) => ({ conv: CONV, id: p.id, count: p.count, names: personNames(p.id) }));
  const out = [];
  scopeData().forEach((d) => {
    if (d.active) PARTS.forEach((p) => out.push({ conv: d.conv, id: p.id, count: p.count, names: personNames(p.id) }));
    else d.senders.forEach((n, id) => out.push({ conv: d.conv, id, count: n, names: personNamesIn(d.conv, id) }));
  });
  return out;
}
// "Search only <chat>": the same query in one chat (This chat scope).
function searchOnlyIn(convId) {
  const q = sEls.input.value;
  searchScope = "this";
  if (!CONV || CONV.id !== convId) activateConversation(convId, true);   // Search is rebuilt for that chat
  else syncScopeUi();
  sEls.input.value = q; sEls.clear.hidden = !q;
  clearTimeout(sDeb); runSearch();
  sEls.input.focus();
}

function ensureSearch() {
  if (searchBuilt) return;
  searchBuilt = true;
  const v = document.getElementById("view-search");
  v.innerHTML = `
    <div class="toolbar">
      <div class="search-row">
        <div class="search-box">
          <span class="ico">${cmdIco("search")}</span>
          <input id="s-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="s-ac" aria-label="Search messages" placeholder="Search ${fmtNum(N)} messages…  (use &quot;quotes&quot; for exact phrases)" autocomplete="off" spellcheck="false" />
          <button class="search-clear" id="s-clear" type="button" title="Clear" aria-label="Clear search" hidden>✕</button>
          <div class="s-ac" id="s-ac" role="listbox" aria-label="People" hidden></div>
        </div>
        <div class="seg s-scope" id="s-scope" role="group" aria-label="Search in" hidden>
          <button type="button" data-scope="this" aria-pressed="true">This chat</button>
          <button type="button" data-scope="all" aria-pressed="false">All chats</button>
        </div>
        <button class="pill f-toggle" id="f-toggle" type="button" aria-expanded="false" aria-controls="s-filters">${cmdIco("settings")} Filters <span class="badge" id="f-toggle-n" hidden>0</span></button>
      </div>
      <div class="s-chips" id="s-chips" role="group" aria-label="Search operators" hidden></div>
      <div class="scrim" id="filter-scrim" aria-hidden="true"></div>
      <div class="filters" id="s-filters">
        <div class="f-sheet-head"><span class="f-sheet-title">Filters</span><button class="btn sm" id="f-done" type="button">Done</button></div>
        <div class="popwrap">
          <button class="pill" id="f-people">${cmdIco("people")} People <span class="badge" id="f-people-n" hidden>0</span></button>
        </div>
        <label class="pill" id="f-date"><span>From</span><input type="date" id="f-from" aria-label="From date" /><span>to</span><input type="date" id="f-to" aria-label="To date" /></label>
        <button class="pill" id="f-media">${cmdIco("camera")} Media</button>
        <button class="pill" id="f-links">${cmdIco("link")} Links</button>
        <button class="pill" id="f-reacts">${cmdIco("heart")} Reactions</button>
        <button class="pill danger" id="f-clear-all" hidden>✕ Clear all</button>
        <span class="spacer"></span>
        <label class="pill sortpill" id="f-sortwrap" title="Sort results">↕
          <select id="f-sort">
            <option value="relevance">Relevance</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="reactions">Most reactions</option>
            <option value="longest">Longest</option>
          </select>
        </label>
        <div class="seg" id="f-matchtoggle" title="How search words are matched">
          <button data-mode="fuzzy" class="sel" title="Fuzzy: also finds close and misspelled matches (typo-tolerant)">Fuzzy</button>
          <button data-mode="exact" title="Exact: only messages that literally contain your words">Exact</button>
        </div>
        <div class="seg" id="f-viewtoggle">
          <button data-mode="list" class="sel">List</button>
          <button data-mode="grid">Grid</button>
        </div>
        <button class="pill" id="f-export" title="Export current results">↓ Export</button>
        <div class="popwrap">
          <button class="pill" id="f-saved">★ Saved ▾</button>
        </div>
        <button class="pill" id="f-save">＋ Save search</button>
        <div class="match-hint" id="s-matchhint"></div>
      </div>
      <div class="result-meta" id="s-meta"></div>
    </div>
    <div class="scroll" id="s-scroll"><div class="list" id="s-list"></div></div>
    <button class="back-to-top" id="s-btt" type="button" hidden title="Back to top" aria-label="Back to top">↑</button>`;

  sEls = {
    input: v.querySelector("#s-input"), clear: v.querySelector("#s-clear"), meta: v.querySelector("#s-meta"),
    scroll: v.querySelector("#s-scroll"), list: v.querySelector("#s-list"),
    people: v.querySelector("#f-people"), peopleN: v.querySelector("#f-people-n"),
    from: v.querySelector("#f-from"), to: v.querySelector("#f-to"),
    media: v.querySelector("#f-media"), links: v.querySelector("#f-links"), reacts: v.querySelector("#f-reacts"),
    saved: v.querySelector("#f-saved"), save: v.querySelector("#f-save"), viewtoggle: v.querySelector("#f-viewtoggle"),
    clearAll: v.querySelector("#f-clear-all"), exportBtn: v.querySelector("#f-export"), btt: v.querySelector("#s-btt"),
    sort: v.querySelector("#f-sort"),
    matchtoggle: v.querySelector("#f-matchtoggle"), matchhint: v.querySelector("#s-matchhint"),
    filters: v.querySelector("#s-filters"), ftoggle: v.querySelector("#f-toggle"), ftoggleN: v.querySelector("#f-toggle-n"),
    chips: v.querySelector("#s-chips"), ac: v.querySelector("#s-ac"), scope: v.querySelector("#s-scope"),
  };
  sEls.input.dataset.ph = sEls.input.placeholder;
  sEls.input.dataset.phShort = "Search " + fmtNum(N) + " messages…";
  if (window.ResizeObserver) {
    const input = sEls.input;
    new ResizeObserver(() => { if (sEls.input === input) input.placeholder = searchPlaceholder(allScope()); }).observe(input);
  }
  sEls.scope.querySelectorAll("button").forEach((b) => { b.onclick = () => setSearchScope(b.dataset.scope); });
  // on a phone the filter bar is a bottom sheet behind "Filters (n)".
  sEls.ftoggle.onclick = (e) => { e.stopPropagation(); if (sEls.filters.classList.contains("open")) closeFilterSheet(); else openFilterSheet(); };
  v.querySelector("#f-done").onclick = () => closeFilterSheet();
  // A real backdrop element takes the tap outside the sheet, so it closes
  // the sheet instead of falling through to the result underneath.
  v.querySelector("#filter-scrim").onclick = (e) => { e.stopPropagation(); closeFilterSheet(); };

  // Every control is rendered FROM F so the UI can never disagree with
  // the filters actually applied.
  sEls.from.value = F.fromStr; sEls.to.value = F.toStr;
  sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to));
  sEls.viewtoggle.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", (b.dataset.mode === "grid") === F.grid));
  sEls.media.classList.toggle("active", F.media);
  sEls.links.classList.toggle("active", F.links);
  sEls.reacts.classList.toggle("active", F.reacts);

  // sort control
  sEls.sort.value = F.sort;
  sEls.sort.onchange = () => { F.sort = sEls.sort.value; runSearch(); };

  // match-mode toggle (fuzzy ⇄ exact)
  sEls.matchtoggle.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("sel", (b.dataset.mode === "fuzzy") === F.fuzzy);
    b.onclick = () => {
      F.fuzzy = b.dataset.mode === "fuzzy";
      sEls.matchtoggle.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
      updateMatchHint();
      runSearch();
    };
  });
  updateMatchHint();
  warmFuzzyIndex();

  // input
  sEls.input.addEventListener("input", () => {
    sEls.clear.hidden = !sEls.input.value;
    clearTimeout(sDeb); sDeb = setTimeout(runSearch, 150);
    updateAutocomplete();
  });
  sEls.clear.addEventListener("click", () => { sEls.input.value = ""; sEls.clear.hidden = true; closeAutocomplete(); runSearch(); sEls.input.focus(); });
  // from: autocomplete (keys while its list is open) and the chips.
  sEls.input.addEventListener("keydown", acKeydown);
  sEls.input.addEventListener("click", updateAutocomplete);
  sEls.input.addEventListener("keyup", (e) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) updateAutocomplete(); });
  sEls.input.addEventListener("blur", () => setTimeout(() => { if (sEls.input && document.activeElement !== sEls.input) closeAutocomplete(); }, 0));
  sEls.ac.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus in the box
  sEls.ac.addEventListener("click", (e) => { const o = e.target.closest("[role=option]"); if (o) acPick(+o.dataset.k); });
  sEls.chips.addEventListener("click", (e) => { const c = e.target.closest(".s-chip"); if (c) removeChip(c); });
  sEls.chips.addEventListener("keydown", (e) => {
    const c = e.target.closest(".s-chip");
    if (c && (e.key === "Backspace" || e.key === "Delete")) { e.preventDefault(); removeChip(c); }
  });
  // j / k / arrows, c, b on a focused result (resultKeydown)
  sEls.list.addEventListener("keydown", resultKeydown);

  // toggles
  sEls.media.onclick = () => { F.media = !F.media; sEls.media.classList.toggle("active", F.media); runSearch(); };
  sEls.links.onclick = () => { F.links = !F.links; sEls.links.classList.toggle("active", F.links); runSearch(); };
  sEls.reacts.onclick = () => { F.reacts = !F.reacts; sEls.reacts.classList.toggle("active", F.reacts); runSearch(); };
  sEls.from.onchange = () => { F.fromStr = sEls.from.value || ""; syncDateBounds(); sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to)); runSearch(); };
  sEls.to.onchange = () => { F.toStr = sEls.to.value || ""; syncDateBounds(); sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to)); runSearch(); };

  // people popover
  sEls.people.onclick = (e) => { e.stopPropagation(); togglePeoplePopover(); };
  // saved popover
  sEls.saved.onclick = (e) => { e.stopPropagation(); toggleSavedPopover(); };
  sEls.save.onclick = saveCurrentSearch;
  sEls.clearAll.onclick = clearAllFilters;
  sEls.exportBtn.onclick = exportResults;

  // back to top
  sEls.scroll.addEventListener("scroll", () => {
    sEls.btt.hidden = sEls.scroll.scrollTop < 400;
  });
  sEls.btt.onclick = () => sEls.scroll.scrollTo({ top: 0, behavior: "smooth" });

  // view toggle
  sEls.viewtoggle.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      F.grid = b.dataset.mode === "grid";
      sEls.viewtoggle.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
      runSearch();
    };
  });

  // infinite scroll
  resObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) appendResultsPage();
  }, { root: sEls.scroll, rootMargin: "600px" });
  // Windowing: (un)render result pages as they leave / re-enter range.
  resPageObs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      // a hidden Search view has an unlaid-out root (0 height) and reports
      // every page as not intersecting — ignore it, or leaving the view would
      // empty the list and lose the reading position.
      if (!e.rootBounds || !e.rootBounds.height) return;
      const pg = e.target;
      if (e.isIntersecting) { if (pg.dataset.empty) renderResPage(pg); }
      else if (!pg.dataset.empty) {
        const h = pg.offsetHeight;
        if (!h) return;   // never freeze a 0 (not laid out) height
        pg.style.height = h + "px";
        pg.replaceChildren();
        pg.dataset.empty = "1";
      }
    });
  }, { root: sEls.scroll, rootMargin: "1500px 0px" });

  runSearch();
}

/* ---- Query context -------------------------------------
   The box is parsed by GCAShared.parseSearchQuery (shared with the command
   palette's message hits and the operator chips) and resolved here into the
   run's context: its needles plus a TRANSIENT operator overlay —
   from:/sender: people, before:/after: bounds, has:/is: flags, -exclusions.
   The overlay is rebuilt from the text on every run and never written into the
   persistent F.people/F.from/F.to/F.media/F.links/F.reacts filter-panel state:
   it narrows further than the manual filters and vanishes with its token. */
// Who a from: value can name: participants (ignored people are already gone
// from PARTS) by display name plus aliases — the wizard name, a name set in
// People and the generic "User N" label.
function personNames(id) {
  const out = [];
  [nameOf(id), settings.names[id], LOCAL_NAMES[id], GENERIC[id]].forEach((n) => { if (n && out.indexOf(n) < 0) out.push(n); });
  return out;
}
// The same for a person in another chat, with that chat's "User N".
function personNamesIn(conv, id) {
  const out = [];
  [nameIn(conv, id), settings.names[id], LOCAL_NAMES[id], genericFor(conv)[id]].forEach((n) => { if (n && out.indexOf(n) < 0) out.push(n); });
  return out;
}
function searchPeople(list) { return (list || PARTS).map((p) => ({ id: p.id, names: personNames(p.id) })); }
// from: value -> { ids, pending, names, byConv }. With no people list given,
// the scope's people. In All chats it is one ranking over every chat's
// people, so "User 2" is whoever is User 2 in each chat: byConv holds the
// ids per chat (convId -> Set) and names the labels that matched.
function resolveFrom(op, people) {
  if (people || !allScope()) {
    const r = GCAShared.resolvePeople(op.value, people || searchPeople(), { open: op.open });
    return { ids: r.ids, pending: r.pending, names: r.ids.map(nameOf), byConv: null };
  }
  const entries = scopeEntries();
  const r = GCAShared.resolvePeople(op.value, entries.map((e, k) => ({ id: k, names: e.names })), { open: op.open });
  const byConv = new Map(), ids = [], names = [];
  r.ids.forEach((k) => {
    const e = entries[k];
    if (!byConv.has(e.conv.id)) byConv.set(e.conv.id, new Set());
    byConv.get(e.conv.id).add(e.id);
    if (ids.indexOf(e.id) < 0) ids.push(e.id);
    if (names.indexOf(e.names[0]) < 0) names.push(e.names[0]);
  });
  // still choosing only while the value names several people (not one person in several chats)
  const pending = r.how === "none" ? r.pending : op.open && r.how !== "exact" && ids.length > 1;
  return { ids, pending, names, byConv };
}
function buildSearchCtx(raw, people) {
  const pq = GCAShared.parseSearchQuery(raw, { clock: CLOCK });
  const ctx = { raw: String(raw || ""), pq, needles: pq.needles, phrases: pq.phrases, excludes: pq.excludes,
    people: null, peopleIn: null, from: null, to: null, has: {}, pins: null, notes: [], chips: [] };
  for (const op of pq.ops) {
    if (op.pending) continue;
    if (op.key === "from") {
      const r = resolveFrom(op, people);
      if (r.pending) { op.pending = true; continue; }
      if (!ctx.people) ctx.people = new Set();
      r.ids.forEach((id) => ctx.people.add(id));
      if (r.byConv) {
        if (!ctx.peopleIn) ctx.peopleIn = new Map();
        r.byConv.forEach((s, cid) => { if (!ctx.peopleIn.has(cid)) ctx.peopleIn.set(cid, new Set()); s.forEach((id) => ctx.peopleIn.get(cid).add(id)); });
      }
      op.ids = r.ids; op.names = r.names;
      if (!r.ids.length) ctx.notes.push("No one named “" + op.value + "”");
    } else if (op.key === "before" || op.key === "after") {
      // a date that doesn't exist is dropped with a note, not rolled over
      if (op.error) { ctx.notes.push("Ignored " + op.raw + (op.error === "order" ? " — use YYYY-MM-DD or Jan 7 2024" : " — no such date")); continue; }
      // both inclusive of the named period: after:P = from P's first
      // day, before:P = through P's last day
      if (op.key === "before") ctx.to = ctx.to == null ? op.date.end - 1 : Math.min(ctx.to, op.date.end - 1);
      else ctx.from = ctx.from == null ? op.date.start : Math.max(ctx.from, op.date.start);
    } else if (op.key === "has") ctx.has[op.value] = true;
    else if (op.key === "is") ctx.pins = new Set(settings.pins);
    ctx.chips.push(op);
  }
  return ctx;
}
// The search context of the last Search run (renderResPage, the fuzzy filter).
let SQ = buildSearchCtx("", []);
const MEDIA_KIND = { photo: "img", video: "vid" };
function hasMediaKind(m, want) {
  if (!m.m) return false;
  const is = (k) => (want === "file" ? k !== "img" && k !== "vid" : k === MEDIA_KIND[want]);
  if (is(m.k)) return true;
  return Array.isArray(m.mx) && m.mx.some((x) => x && x.m && is(x.k));   // a message's other files
}
// Does message m (lowercased search text L) pass the manual filters and the
// query's operator overlay? Needles are the caller's job.
function msgPasses(ctx, m, L) {
  if (F.people.size && !F.people.has(m.s)) return false;
  if (F.from != null && m.t < F.from) return false;
  if (F.to != null && m.t > F.to) return false;
  if (ctx.people && !ctx.people.has(m.s)) return false;
  if (ctx.from != null && m.t < ctx.from) return false;
  if (ctx.to != null && m.t > ctx.to) return false;
  const h = ctx.has;
  if ((F.media || h.media) && !m.m) return false;
  if ((F.links || h.link) && !m.u) return false;
  if ((F.reacts || h.reacts) && !m.r) return false;
  if (h.photo && !hasMediaKind(m, "photo")) return false;
  if (h.video && !hasMediaKind(m, "video")) return false;
  if (h.file && !hasMediaKind(m, "file")) return false;
  if (ctx.pins && !ctx.pins.has(m.i)) return false;
  for (const term of ctx.excludes) if (L.indexOf(term) >= 0) return false;
  return true;
}
function testMsgNoNeedle(i) { return msgPasses(SQ, MSGS[i], LOWER[i]); }
function hasPhrases(ctx, L) {
  for (const ph of ctx.phrases) if (L.indexOf(ph) < 0) return false;
  return true;
}
// Any filter or operator in effect (the "Showing all …" line otherwise).
function ctxFiltered(ctx) {
  return !!(ctx.needles.length || ctx.excludes.length || ctx.people || ctx.from != null || ctx.to != null ||
    Object.keys(ctx.has).length || ctx.pins || F.people.size || F.from || F.to || F.media || F.links || F.reacts);
}
// The literal tier: every message holding all the needles (and passing the
// filters), newest first. Shared by Search and the palette's message hits.
function literalHits(ctx, msgs, lower) {
  const out = [], nd = ctx.needles;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const L = lower[i];
    let match = true;
    for (const n of nd) if (L.indexOf(n) < 0) { match = false; break; }
    if (match && msgPasses(ctx, msgs[i], L)) out.push(i);
  }
  return out;
}
/* ---- Fuzzy search: exact-first ---------------------------------
   In Fuzzy mode a query first runs the literal AND-match (a few ms at 100k):
     - literal hits -> only those, newest first, plus a "close matches" button
       (#s-fuzzy-toggle) that opts THIS query into the typo-tolerant ranking;
     - no literal hit (after filters) -> falls back to fuzzy on its own, and the
       meta line says "No exact matches — N close matches".
   Exact mode is literal-only and never offers fuzzy. A fuzzy run scores only the
   prefiltered candidates (GCAShared.fuzzyCandidates, a bigram-index q-gram
   filter that provably keeps everything Fuse would match — see
   tests/fuzzy-prefilter.test.js), and highlight ranges are computed per
   rendered page instead of for every hit. */
const FUSE_OPTS = { threshold: 0.3, ignoreLocation: true };
// Bigram index over LOWER for the prefilter. Built in background slices once
// Search opens (warmFuzzyIndex) and drained on demand if a fuzzy run needs it
// sooner. Keyed on LOWER, which rebuildIndexes() replaces per conversation.
let fuzzyIdxJob = null;
function fuzzyIndexJob() {
  if (!fuzzyIdxJob || fuzzyIdxJob.key !== LOWER) {
    const texts = LOWER;
    fuzzyIdxJob = makeJob(texts, () => GCAShared.createBigramIndex.steps(texts, () => performance.now() > sliceEnd));
  }
  return fuzzyIdxJob;
}
function warmFuzzyIndex() {
  const step = () => {
    if (!searchBuilt || !window.Fuse) return;
    if (!runJob(fuzzyIndexJob(), SLICE_MS)) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
// Message indices Fuse matches for `pattern`, best first (Fuse's own order).
function fuzzyMatch(pattern) {
  const job = fuzzyIndexJob();
  runJob(job, Infinity);
  const cand = GCAShared.fuzzyCandidates(job.value, pattern, FUSE_OPTS.threshold);
  const texts = cand ? Array.from(cand, (i) => LOWER[i]) : LOWER;
  return new Fuse(texts, FUSE_OPTS).search(pattern).map((r) => (cand ? cand[r.refIndex] : r.refIndex));
}
// The query (needles key) the user opted into close matches for, or null.
let fuzzyForceQ = null;
// What the current result set is: "exact" (Exact mode), "exact-first" (Fuzzy
// mode, literal hits shown), "fallback" (Fuzzy mode, no literal hit), "forced"
// (Fuzzy mode, user asked for close matches) or "" (no query).
let searchKind = "";
// The pattern of a fuzzy run ("fallback"/"forced"), for per-page highlight ranges.
let fuzzyPattern = null;
// fuzzy match ranges, keyed by message INDEX (not list order) so they
// survive sorting and paging. Filled per rendered page (appendResultsPage);
// null whenever the run wasn't fuzzy, which routes rendering to the literal-
// needle highlighter.
let fuzzyRanges = null;
function runSearch() {
  fuzzyRanges = null; fuzzyPattern = null; searchKind = "";
  // The operator overlay and exclusions are re-parsed from the box each run
  // (GCAShared.parseSearchQuery — see buildSearchCtx).
  SQ = buildSearchCtx(sEls.input.value || "");

  // Toggle active class on pills (manual/persistent state only — the overlay
  // never touches these, so typing operators can't alter the filter panel).
  sEls.media.classList.toggle("active", F.media);
  sEls.links.classList.toggle("active", F.links);
  sEls.reacts.classList.toggle("active", F.reacts);
  updatePeopleBadge();

  F.needles = SQ.needles;
  updateClearAllBtn();
  syncScopeUi();
  if (allScope()) { runSearchAll(); return; }
  resState.groups = null;

  let out;
  // What List mode would show for this query — the "N messages match" in Grid
  // mode's no-media empty state. -1 = the (pre-media-filter) result list itself.
  let listCount = -1;
  if (F.needles.length > 0) {
    const canFuzzy = F.fuzzy && window.Fuse;
    const qKey = F.needles.join("\u0001");
    if (fuzzyForceQ !== qKey) fuzzyForceQ = null;   // the opt-in is per query
    // Literal substring AND-match, newest first — always the first tier.
    out = literalHits(SQ, MSGS, LOWER);
    searchKind = canFuzzy ? "exact-first" : "exact";
    // The fallback is decided on what the view can show: in Grid mode literal
    // hits without media don't count (they would only produce "No media").
    const shown = gridOn() ? out.filter((i) => MSGS[i].m) : out;
    if (canFuzzy && (fuzzyForceQ || !shown.length)) {
      const lit = out;
      fuzzyPattern = F.needles.join(" ");
      fuzzyRanges = new Map();
      // "quoted phrases" stay exact in Fuzzy mode — a close match must
      // still hold each one contiguously (same lowercasing as the literal
      // tier); only the unquoted words are typo-tolerant.
      const fz = fuzzyMatch(fuzzyPattern).filter((i) => testMsgNoNeedle(i) && hasPhrases(SQ, LOWER[i]));
      if (fuzzyForceQ) {
        // Opted in: literal hits first, then Fuse's close matches. A literal
        // AND-hit Fuse can't score (reordered words, patterns over 32 chars)
        // must never vanish because the user asked for MORE results.
        const seen = new Set(lit);
        out = lit.concat(fz.filter((i) => !seen.has(i)));
        searchKind = "forced";
      } else {
        out = fz;
        listCount = lit.length || fz.length;
        searchKind = "fallback";
      }
    }
  } else {
    out = literalHits(SQ, MSGS, LOWER);
  }

  sortHits(out, MSGS);

  // grid mode renders only messages with media, so the result set it
  // counts, pages and empty-states over must be that subset too.
  const matched = listCount >= 0 ? listCount : out.length;
  if (gridOn()) out = out.filter((i) => MSGS[i].m);

  resState.idx = out; resState.page = 0;
  resetResultList(gridOn() ? "gallery-pages" : "list");

  const hasFilter = ctxFiltered(SQ);
  const sortLbl = sortLabel(searchKind === "fallback" || searchKind === "forced");
  const noun = (gridOn() ? " media message" : " message") + (out.length === 1 ? "" : "s");
  sEls.meta.textContent = !hasFilter
    ? "Showing all " + fmtNum(out.length) + noun + ", " + sortLabel(false) + " first — " + SEARCH_HINT
    : searchKind === "fallback" && out.length
      ? "No exact " + (gridOn() ? "media " : "") + "matches — " + fmtNum(out.length) + " close " + (gridOn() ? "media " : "") + (out.length === 1 ? "match" : "matches") + " · sorted by " + sortLbl
      : fmtNum(out.length) + noun + " found" + (searchKind === "forced" ? " incl. close matches" : "") + " · sorted by " + sortLbl;
  // The per-query opt-in / opt-out for close matches (Fuzzy mode only).
  if (searchKind === "exact-first" || searchKind === "forced") {
    const forced = searchKind === "forced";
    const b = el("button", "meta-act", forced ? "Exact matches only" : "+ Show close matches");
    b.id = "s-fuzzy-toggle"; b.type = "button";
    b.title = forced ? "Show only messages that literally contain your words" : "Also show typo-tolerant close matches, ranked by relevance";
    const key = F.needles.join("\u0001");
    b.onclick = () => { fuzzyForceQ = forced ? null : key; runSearch(); };
    sEls.meta.append(" · ", b);
  }
  finishSearchMeta();

  if (!out.length) {
    sEls.list.className = "list";
    sEls.list.appendChild(matched && gridOn()
      ? emptyState("camera", "No media in these results.", fmtNum(matched) + (matched === 1 ? " message matches" : " messages match") + " — switch to List to see " + (matched === 1 ? "it" : "them") + ".",
        ["Switch to List", () => sEls.viewtoggle.querySelector('button[data-mode="list"]').click()])
      : emptyState("search", "No messages match your search.", "Try fewer words, switch to Fuzzy, or clear the filters.",
        ["Clear search & filters", () => { clearAllFilters(); if (matchMedia("(pointer: fine)").matches) sEls.input.focus(); }]));
    return;
  }
  appendResultsPage();
}
const SEARCH_HINT = "start typing or add a filter. Try from:name, has:photo, has:link, is:pinned, after:2021-06, before:2024, -word";
// A new result set: observers off, the list emptied and back at the top.
function resetResultList(cls) {
  sEls.list.className = cls;
  if (resPageObs) resPageObs.disconnect();
  sEls.list.innerHTML = "";
  // a new result set starts at the top — keeping the old offset hid the
  // best results above the fold and let the sentinel pull in page 2 at once.
  sEls.scroll.scrollTop = 0;
  if (resObserver) resObserver.disconnect();
}
// The "sorted by …" words (relevance means newest-first unless fuzzy-ranked).
function sortLabel(fuzzyRun) {
  return { relevance: fuzzyRun ? "relevance" : "newest", newest: "newest", oldest: "oldest", reactions: "most reactions", longest: "longest" }[F.sort];
}
// After a run's meta text: its notes, the chips, the run counter, history.
function finishSearchMeta() {
  // say which operator was dropped or matched no one (text
  // nodes — never markup).
  SQ.notes.forEach((n) => sEls.meta.append(" · " + n));
  renderChips();
  // bumped on every completed run (debounced or not), so tests can wait
  // for "the search actually re-ran" instead of a fixed sleep timed to the
  // 150ms debounce — a sleep-then-negative-assertion pattern can pass even if
  // the search never reran at all. See search-operators.spec.js.
  sEls.meta.dataset.gen = String((Number(sEls.meta.dataset.gen) || 0) + 1);
  if (curView === "search") navCommit("replace");   // the entry's query (history.state) follows the box
}
// Apply the sort order (relevance = leave as-built: Fuse order, or newest-first).
function sortHits(out, ms) {
  if (F.sort === "newest") out.sort((a, b) => ms[b].t - ms[a].t);
  else if (F.sort === "oldest") out.sort((a, b) => ms[a].t - ms[b].t);
  else if (F.sort === "reactions") out.sort((a, b) => ((ms[b].r ? ms[b].r.length : 0) - (ms[a].r ? ms[a].r.length : 0)) || (ms[b].t - ms[a].t));
  else if (F.sort === "longest") out.sort((a, b) => ((ms[b].x || "").length - (ms[a].x || "").length) || (ms[b].t - ms[a].t));
}
// An All chats run: the literal tier per chat, grouped (active chat first).
function runSearchAll() {
  searchKind = "exact";
  const groups = [];
  let total = 0, pos = 0;
  for (const d of scopeData()) {
    // a from: names people per chat in All chats (each chat's "User N")
    const ctx = SQ.peopleIn ? Object.assign({}, SQ, { people: SQ.peopleIn.get(d.conv.id) || new Set() }) : SQ;
    const idx = literalHits(ctx, d.msgs, d.lower);
    if (!idx.length) continue;
    sortHits(idx, d.msgs);
    groups.push({ d, idx, start: pos });
    pos += 1 + idx.length; total += idx.length;
  }
  const act = groups.find((g) => g.d.active);
  // idx stays the active chat's hits: the lightbox steps through those
  resState = { idx: act ? act.idx : [], page: 0, groups, rows: pos, total };
  resetResultList("list");
  const nChats = groups.length;
  const inChats = " in " + fmtNum(nChats) + (nChats === 1 ? " chat" : " chats");
  sEls.meta.textContent = !ctxFiltered(SQ)
    ? "Showing all " + fmtNum(total) + (total === 1 ? " message" : " messages") + inChats + ", " + sortLabel(false) + " first — " + SEARCH_HINT
    : fmtNum(total) + (total === 1 ? " message" : " messages") + inChats + " · exact matches · sorted by " + sortLabel(false);
  finishSearchMeta();
  if (!total) {
    sEls.list.appendChild(emptyState("search", "No messages match in any chat.",
      "All chats finds exact matches only — try fewer words, or search This chat, where Fuzzy also finds close matches.",
      ["Search this chat", () => setSearchScope("this")]));
    return;
  }
  appendResultsPage();
}
// Row `pos` of an All chats run: { g, i } (i < 0 = the group's header).
function groupRow(pos) {
  const gs = resState.groups;
  let lo = 0, hi = gs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (gs[mid].start <= pos) lo = mid; else hi = mid - 1; }
  const g = gs[lo], k = pos - g.start;
  return { g, i: k === 0 ? -1 : g.idx[k - 1] };
}
function convHeadEl(g) {
  const c = g.d.conv, n = g.idx.length;
  const h = el("div", "s-conv-head");
  const nm = el("span", "s-conv-name"); nm.setAttribute("role", "heading"); nm.setAttribute("aria-level", "2");
  nm.textContent = displayConvName(c);
  h.appendChild(nm);
  h.appendChild(el("span", "s-conv-n", fmtNum(n) + (n === 1 ? " message" : " messages")));
  if (g.d.active) h.appendChild(el("span", "pins-conv-cur", "this chat"));
  h.appendChild(el("span", "s-conv-rule"));
  const b = btnEl("meta-act s-conv-go", "");
  b.textContent = "Search only " + displayConvName(c);
  b.onclick = () => (g.d.active ? setSearchScope("this") : searchOnlyIn(c.id));
  h.appendChild(b);
  return h;
}
function resRows() { return resState.groups ? resState.rows : resState.idx.length; }

/* ---- Results windowing -----------------------------------------
   Results arrive as 60-row .res-page blocks appended by the bottom sentinel
   (infinite scroll). resPageObs then keeps only the pages within ~1500px of the
   viewport rendered: a page that scrolls far away is frozen at its measured
   height and emptied, and re-rendered from resState.idx when it comes back —
   the same scheme as the Timeline's chunks, so a 100k-hit list never holds
   more than a few pages of rows. Grid mode makes each page its own .gallery
   grid (60 cells fill whole rows for every column count the 980px-max grid can
   have, 1-6), inside a column of pages. */
let resPageObs = null;
function renderResPage(pg) {
  const idx = resState.idx, k = +pg.dataset.p;
  if (resState.groups) {
    const fr = document.createDocumentFragment();
    for (let pos = k * PAGE, end = Math.min(resState.rows, (k + 1) * PAGE); pos < end; pos++) {
      const { g, i } = groupRow(pos);
      let card;
      if (i < 0) { card = convHeadEl(g); card.dataset.hpos = pos; }
      else {
        card = g.d.active ? renderMsg(i, { clickable: true, needles: F.needles }) : renderForeignPin(g.d.conv, g.d.msgs[i], F.needles);
        card.dataset.pos = pos;
      }
      fr.appendChild(card);
    }
    pg.replaceChildren(fr);
    pg.style.height = "";
    delete pg.dataset.empty;
    return;
  }
  const slice = idx.slice(k * PAGE, (k + 1) * PAGE);
  // Fuzzy highlight ranges for just this page: Fuse's includeMatches is
  // per text, so scoring the page's texts gives the same ranges the full run
  // would have, without paying for them on every hit.
  if (fuzzyPattern && fuzzyRanges && !gridOn() && !pg.dataset.hl) {
    pg.dataset.hl = "1";
    const hl = new Fuse(slice.map((i) => LOWER[i]), Object.assign({ includeMatches: true }, FUSE_OPTS));
    for (const r of hl.search(fuzzyPattern)) {
      const ranges = [];
      (r.matches || []).forEach((mt) => (mt.indices || []).forEach(([s, e]) => {
        // Fuse indices include every scored fragment, down to single chars —
        // highlighting those degrades into confetti. Keep fragments >= 2 chars.
        if (e - s + 1 >= 2) ranges.push([s, e]);
      }));
      if (ranges.length) fuzzyRanges.set(slice[r.refIndex], ranges);
    }
  }
  const frag = document.createDocumentFragment();
  slice.forEach((i, n) => {
    const card = gridOn() ? galleryCell(i, idx)   // idx is already the media subset
      : renderMsg(i, { clickable: true, needles: F.needles, ranges: fuzzyRanges ? fuzzyRanges.get(i) : null });
    card.dataset.pos = k * PAGE + n;
    frag.appendChild(card);
  });
  pg.replaceChildren(frag);
  pg.style.height = "";
  delete pg.dataset.empty;
}
function appendResultsPage() {
  const { page } = resState, rows = resRows();
  if (page * PAGE >= rows) return;
  const pg = el("div", gridOn() ? "res-page gallery" : "res-page");
  pg.dataset.p = page;
  renderResPage(pg);
  const old = sEls.list.querySelector(".sentinel"); if (old) old.remove();
  sEls.list.appendChild(pg);
  if (resPageObs) resPageObs.observe(pg);
  resState.page++;
  // re-arm sentinel
  if (resState.page * PAGE < rows) {
    const sentinel = el("div", "sentinel"); sEls.list.appendChild(sentinel);
    resObserver.observe(sentinel);
  }
}
/* ---- Keyboard result navigation ---------------------------------------
   With focus in the result list (a result card, a control inside one, or a
   chat's header in All chats) — never in the box, a chip or the autocomplete,
   which sit outside #s-list — j / ↓ and k / ↑ move focus to the next /
   previous result (rendering a windowed-out page, or appending the next one,
   on the way; All chats headers are stepped over). Enter opens the result
   (cardActivation), c opens its context, b bookmarks it. The position is
   announced through the live region once the keys come to rest. */
const RESULT_STEP = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
let resAnnT = 0;
// What row `pos` of the result list is: { i, m, conv (another chat, or null),
// n (its 1-based number among the results), total }, or null for a header.
function resultAt(pos) {
  if (resState.groups) {
    if (pos < 0 || pos >= resState.rows) return null;
    const { g, i } = groupRow(pos);
    if (i < 0) return null;
    return { i, m: g.d.msgs[i], conv: g.d.active ? null : g.d.conv, n: pos - resState.groups.indexOf(g), total: resState.total };
  }
  const i = resState.idx[pos];
  return i == null ? null : { i, m: MSGS[i], conv: null, n: pos + 1, total: resState.idx.length };
}
// The rendered card of row `pos`, rendering its page first when needed.
function resultCard(pos) {
  const k = Math.floor(pos / PAGE);
  while (resState.page <= k && resState.page * PAGE < resRows()) appendResultsPage();
  const pg = sEls.list.querySelector('.res-page[data-p="' + k + '"]');
  if (!pg) return null;
  if (pg.dataset.empty) renderResPage(pg);
  return pg.querySelector('[data-pos="' + pos + '"]');
}
function resultKeydown(e) {
  if (curView !== "search" || topModal() || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(t.tagName) || t.isContentEditable) return;
  const card = t.closest("[data-pos]"), head = card ? null : t.closest("[data-hpos]");
  const step = RESULT_STEP[e.key];
  if (step) {
    if (!card && !head) return;
    e.preventDefault();
    const rows = resRows();
    let pos = (card ? +card.dataset.pos : +head.dataset.hpos) + step;
    while (pos >= 0 && pos < rows && !resultAt(pos)) pos += step;   // over a chat's header
    if (pos < 0 || pos >= rows) return;                              // the ends stay put
    const next = resultCard(pos);
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
    const r = resultAt(pos);
    clearTimeout(resAnnT);
    resAnnT = setTimeout(() => announce("Result " + fmtNum(r.n) + " of " + fmtNum(r.total)), 250);
    return;
  }
  if (!card || e.shiftKey || (e.key !== "c" && e.key !== "b")) return;
  const r = resultAt(+card.dataset.pos);
  if (!r) return;
  e.preventDefault();
  clearTimeout(resAnnT);   // this key's own message, not a "Result n of m" still queued
  if (e.key === "b") {
    togglePin(r.m.i);
    announce(isPinned(r.m.i) ? "Bookmarked" : "Removed bookmark");
  } else if (r.conv) {
    const msg = "Its context is in " + displayConvName(r.conv) + " — press Enter to open it there";
    toast(msg); announce(msg);
  } else openContextPeek(r.i);
}
function galleryCell(i, list) {
  const m = MSGS[i], c = el("div", "gcell");
  // kindOf() can return "file" for unknown extensions (e.g. .pdf) — that
  // is neither "img" nor "vid", so it must not fall into the video branch
  // (which renders an empty, broken <video>). Reuse renderMedia's file-chip
  // markup instead of forking a third pattern.
  if (m.k === "img") { const img = el("img"); img.loading = "lazy"; img.src = safeHref(m.m); img.alt = "Photo from " + nameOf(m.s) + " · " + DT.format(m.t); c.appendChild(img); }
  else if (m.k === "vid") { const v = document.createElement("video"); v.src = safeHref(m.m); v.preload = "metadata"; c.appendChild(v); c.appendChild(el("div", "play", "▶")); }
  else { const chip = renderMedia(m, i); chip.classList.add("gallery-cell"); c.appendChild(chip); }
  c.title = nameOf(m.s) + " · " + DT.format(m.t);
  // a file cell is just its link chip — it must not also open a lightbox.
  if (isViewable(i)) asButton(c, () => openLightbox(i, list), (m.k === "vid" ? "Video" : "Photo") + " from " + nameOf(m.s) + " · " + DT.format(m.t));
  return c;
}

/* ---- People filter popover ----------------------------------------------- */
function togglePeoplePopover() {
  closePopovers();
  const wrap = sEls.people.parentElement;
  const pop = el("div", "popover");
  PARTS.forEach((p) => {
    // a <label> around the checkbox — the whole row toggles it, by
    // click or by Space on the (focusable) checkbox.
    const item = el("label", "pop-item");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = F.people.has(p.id);
    const av = el("span", "av"); applyPfp(av, p.id); av.classList.remove("av-clickable");
    const lbl = el("span", "", esc(nameOf(p.id)) + ' <span style="color:var(--text-faint)">· ' + fmtNum(p.count) + "</span>");
    item.appendChild(cb); item.appendChild(av); item.appendChild(lbl);
    cb.addEventListener("change", () => {
      if (cb.checked) F.people.add(p.id); else F.people.delete(p.id);
      updatePeopleBadge(); runSearch();
    });
    pop.appendChild(item);
  });
  wrap.appendChild(pop);
}
function updatePeopleBadge() {
  sEls.peopleN.hidden = F.people.size === 0;
  sEls.peopleN.textContent = F.people.size;
  sEls.people.classList.toggle("active", F.people.size > 0);
}
function updateMatchHint() {
  if (!sEls.matchhint) return;
  const fuzzy = '<b>Fuzzy</b>: exact matches first; when there are none (or you ask for them), close &amp; misspelled matches too (typo-tolerant, ranked by relevance).';
  const exact = '<b>Exact</b>: shows only messages that literally contain every word/phrase you type.';
  // Lead with the active mode's description so the user knows what's in effect.
  sEls.matchhint.innerHTML = F.fuzzy ? fuzzy + " &nbsp;·&nbsp; " + exact : exact + " &nbsp;·&nbsp; " + fuzzy;
}
/* ---- Operator chips + from: autocomplete -----------------------
   Every applied operator of the last run is a chip under the box: a real
   <button> named "Remove filter: …" that click / Enter / Space / Backspace /
   Delete remove. Removing edits the query TEXT (GCAShared.removeSearchToken),
   so the box, the chips and the results never disagree. */
const HAS_LABEL = { media: "media", link: "link", reacts: "reactions", photo: "photo", video: "video", file: "file" };
function chipLabel(op) {
  if (op.key === "from") return op.ids.length ? "From " + (op.names || op.ids.map(nameOf)).join(", ") : "From no one named “" + op.value + "”";
  if (op.key === "after") return "Since " + op.date.label;
  if (op.key === "before") return "Until " + op.date.label;
  if (op.key === "has") return "Has " + (HAS_LABEL[op.value] || op.value);
  if (op.key === "is") return "Pinned";
  return "Not “" + op.value + "”";
}
const CHIP_ICO = { from: "people", after: "calendar", before: "calendar", has: "camera", is: "pins", not: "trash" };
function renderChips() {
  const host = sEls.chips;
  if (!host) return;
  // a run can land while a chip has focus (a debounced keystroke, a scope
  // change): rebuilding must not drop that focus to <body>
  const had = host.contains(document.activeElement) ? document.activeElement : null;
  host.replaceChildren();
  SQ.chips.forEach((op, k) => {
    const lbl = chipLabel(op);
    const b = btnEl("s-chip" + (op.key === "from" && !op.ids.length ? " none" : ""),
      '<span class="s-chip-ic">' + cmdIco(op.key === "has" && op.value === "link" ? "link" : CHIP_ICO[op.key]) + "</span>" +
      '<span class="s-chip-tx">' + esc(lbl) + '</span><span class="s-chip-x" aria-hidden="true">✕</span>', "Remove filter: " + lbl);
    b.dataset.k = k;
    b.dataset.raw = op.raw;
    b.title = "Remove " + op.raw;
    host.appendChild(b);
  });
  host.hidden = !SQ.chips.length;
  if (had) {
    const now = [...host.children];
    const same = now.find((c) => c.dataset.raw === had.dataset.raw) || now[+had.dataset.k] || now[now.length - 1];
    if (same) same.focus(); else sEls.input.focus({ preventScroll: true });
  }
}
// Replace the box's whole text as ONE undoable edit, so Ctrl/Cmd+Z in the box
// brings back what a chip removal took out: select all + execCommand
// ("insertText" / "delete"), which joins the input's native undo stack.
// Deprecated but still the only way to do that; when it is missing or
// refuses — and on a touch screen, where focusing the box would pop the
// keyboard — the value is set directly (no undo entry).
function setBoxUndoable(text) {
  const inp = sEls.input;
  let done = false;
  if (typeof document.execCommand === "function" && matchMedia("(pointer: fine)").matches) {
    try {
      inp.focus({ preventScroll: true });
      inp.select();
      done = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    } catch (e) { done = false; }
    if (inp.value !== text) done = false;
  }
  if (!done) inp.value = text;
}
function removeChip(c) {
  const k = +c.dataset.k;
  const op = SQ.chips[k];
  if (!op) return;
  // the box may have changed since this run (debounce): edit what was parsed
  // only while it is still the box's text
  if (sEls.input.value !== SQ.raw) { runSearch(); return; }
  setBoxUndoable(GCAShared.removeSearchToken(sEls.input.value, op));
  clearTimeout(sDeb);   // after the edit's own input event: run now, not debounced
  sEls.clear.hidden = !sEls.input.value;
  closeAutocomplete();
  runSearch();
  announce("Removed " + chipLabel(op));
  // focus: the chip now in its place, else the one before, else the box
  const left = sEls.chips.querySelectorAll(".s-chip");
  const next = left[k] || left[k - 1];
  if (next) next.focus(); else sEls.input.focus();
}
// The from: autocomplete — an ARIA combobox (the box) driving a listbox (#s-ac),
// the same pattern as the command palette.
let acState = { open: false, items: [], sel: 0, tok: null };
function acToken() {
  const inp = sEls.input;
  if (!inp || document.activeElement !== inp || inp.selectionStart !== inp.selectionEnd) return null;
  const caret = inp.selectionStart;
  const pq = GCAShared.parseSearchQuery(inp.value, { clock: CLOCK });
  return pq.ops.find((op) => {
    if (op.key !== "from") return false;
    const vs = op.start + op.raw.indexOf(":") + 1;
    if (caret < vs || caret > op.end) return false;
    return op.open || caret < op.end;
  }) || null;
}
function acCandidates(value) {
  // the same matcher as from: itself (GCAShared.rankPeople), best rank first,
  // then whoever posts most. In All chats one row per name: an unnamed
  // "User 2" of two chats is one choice, as from: treats it.
  const rows = new Map(), all = allScope();
  scopeEntries().forEach((e) => {
    const key = all ? e.names[0] : e.id;
    let r = rows.get(key);
    if (!r) { r = { id: key, names: [], p: { id: e.id, count: 0 }, top: -1 }; rows.set(key, r); }
    e.names.forEach((n) => { if (r.names.indexOf(n) < 0) r.names.push(n); });
    r.p.count += e.count;
    if (e.count > r.top) { r.top = e.count; r.p.id = e.id; }
  });
  const people = [...rows.values()];
  return GCAShared.rankPeople(value, people)
    .map((x) => ({ p: x.person.p, names: x.person.names, r: x.rank }))
    .sort((a, b) => a.r - b.r || b.p.count - a.p.count).slice(0, 8);
}
function updateAutocomplete() {
  const tok = acToken();
  if (!tok) { closeAutocomplete(); return; }
  const items = acCandidates(tok.value);
  if (!items.length) { closeAutocomplete(); return; }
  acState = { open: true, items, sel: 0, tok };
  const box = sEls.ac;
  box.replaceChildren();
  items.forEach((x, k) => {
    const row = el("div", "s-ac-row");
    row.id = "s-ac-opt-" + k; row.dataset.k = k;
    row.setAttribute("role", "option");
    const aka = x.names.slice(1).join(" · ");
    row.innerHTML = pfpHtml(x.p.id, "", x.names[0]) + '<span class="s-ac-tx"><span class="s-ac-name">' + esc(x.names[0]) + "</span>" +
      (aka ? '<span class="s-ac-aka">' + esc(aka) + "</span>" : "") + '</span><span class="s-ac-n">' + fmtNum(x.p.count) + " msg" + (x.p.count === 1 ? "" : "s") + "</span>";
    const av = row.querySelector(".av-clickable"); if (av) av.classList.remove("av-clickable");
    box.appendChild(row);
  });
  box.hidden = false;
  sEls.input.setAttribute("aria-expanded", "true");
  acHighlight();
}
function acHighlight() {
  sEls.ac.querySelectorAll("[role=option]").forEach((r, k) => { r.classList.toggle("sel", k === acState.sel); r.setAttribute("aria-selected", k === acState.sel ? "true" : "false"); });
  sEls.input.setAttribute("aria-activedescendant", "s-ac-opt-" + acState.sel);
  const r = sEls.ac.querySelector("#s-ac-opt-" + acState.sel); if (r) r.scrollIntoView({ block: "nearest" });
}
function closeAutocomplete() {
  if (!sEls.ac) return;
  acState = { open: false, items: [], sel: 0, tok: null };
  sEls.ac.hidden = true; sEls.ac.replaceChildren();
  sEls.input.setAttribute("aria-expanded", "false");
  sEls.input.removeAttribute("aria-activedescendant");
}
function acPick(k) {
  const x = acState.items[k], tok = acState.tok;
  if (!x || !tok) return;
  const head = tok.raw.slice(0, tok.raw.indexOf(":") + 1);   // keeps "from:" or "sender:"
  const text = head + GCAShared.quoteOpValue(x.names[0]);
  const before = sEls.input.value.slice(0, tok.start);
  sEls.input.value = GCAShared.replaceSearchToken(sEls.input.value, tok, text);
  const caret = before.length + text.length + 1;
  sEls.input.setSelectionRange(caret, caret);
  sEls.clear.hidden = false;
  closeAutocomplete();
  clearTimeout(sDeb);
  runSearch();
  sEls.input.focus();
}
function acKeydown(e) {
  if (!acState.open) return;
  const n = acState.items.length;
  if (e.key === "ArrowDown") { e.preventDefault(); acState.sel = (acState.sel + 1) % n; acHighlight(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); acState.sel = (acState.sel - 1 + n) % n; acHighlight(); }
  else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) { e.preventDefault(); acPick(acState.sel); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAutocomplete(); }
}
function updateClearAllBtn() {
  const hasFilter = (F.needles && F.needles.length) || F.people.size || F.from || F.to || F.media || F.links || F.reacts || (sEls.input && sEls.input.value.trim());
  if (sEls.clearAll) sEls.clearAll.hidden = !hasFilter;
  // the mobile "Filters (n)" toggle counts the filters in effect
  const n = (F.people.size ? 1 : 0) + (F.from || F.to ? 1 : 0) + (F.media ? 1 : 0) + (F.links ? 1 : 0) + (F.reacts ? 1 : 0);
  if (sEls.ftoggleN) {
    sEls.ftoggleN.hidden = !n; sEls.ftoggleN.textContent = n;
    sEls.ftoggle.classList.toggle("active", n > 0);
    sEls.ftoggle.setAttribute("aria-label", "Filters" + (n ? ", " + n + " active" : ""));
  }
}
// the mobile filter sheet — a layer of the shared modal stack while
// open (Esc / Done / a tap outside close it, focus returns to the toggle); on
// desktop the same .filters bar is inline and none of this applies.
function openFilterSheet() {
  const f = sEls.filters;
  if (!f) return;
  f.classList.add("open");
  document.getElementById("filter-scrim").classList.add("on");
  sEls.ftoggle.setAttribute("aria-expanded", "true");
  f._close = closeFilterSheet;
  applyDialog(f, "Search filters", { initial: "#f-people" });
}
function closeFilterSheet(opts) {
  const f = sEls.filters;
  if (!f || !f.classList.contains("open")) return false;
  closePopovers();
  f.classList.remove("open");
  document.getElementById("filter-scrim").classList.remove("on");
  ["role", "aria-modal", "aria-label"].forEach((a) => f.removeAttribute(a));
  sEls.ftoggle.setAttribute("aria-expanded", "false");
  // after a widen the sheet IS the inline bar: focus inside it stays put
  if (!(opts && opts.keepFocus && f.contains(document.activeElement))) restoreFocus(f);
  return true;
}
document.addEventListener("click", (e) => {
  if (sEls.filters && sEls.filters.classList.contains("open") && !e.target.closest("#s-filters, #f-toggle")) closeFilterSheet();
});
// the sheet only exists at the mobile breakpoint — widening the window
// past it closes the sheet, so the inline desktop bar isn't left behind as an
// aria-modal dialog with a focus trap.
if (window.matchMedia) {
  const mobileMq = window.matchMedia("(max-width: 760px)");
  const onMq = (e) => { if (!e.matches) closeFilterSheet({ keepFocus: true }); };
  if (mobileMq.addEventListener) mobileMq.addEventListener("change", onMq); else if (mobileMq.addListener) mobileMq.addListener(onMq);
}
function clearAllFilters() {
  sEls.input.value = ""; sEls.clear.hidden = true;
  F.media = false; F.links = false; F.reacts = false;
  F.people.clear(); F.from = null; F.to = null; F.fromStr = ""; F.toStr = "";
  sEls.from.value = ""; sEls.to.value = "";
  sEls.from.closest(".pill").classList.remove("active");
  sEls.media.classList.remove("active");
  sEls.links.classList.remove("active");
  sEls.reacts.classList.remove("active");
  updatePeopleBadge();
  runSearch();
  sEls.input.focus();
}
// One exported record per line — multi-line bodies flattened so the .txt
// stays parseable. conv: the chat the message is from (whose "User N" it uses).
function exportLine(m, conv) { return DT.format(m.t) + " | " + nameIn(conv, m.s) + ": " + (m.x || "[media]").replace(/\r?\n/g, " "); }
// Save `lines` as a plain-text download called `name`.
function downloadText(name, lines) {
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  // Not revoked right away: a browser may read the blob after the click task
  // (Firefox), and an early revoke cancels the download. Share waits the same way.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Today's date as "YYYY-MM-DD" in the zone the app displays, for file names.
function todayKey() { return dayKey(Date.now()); }
function exportResults() {
  const day = todayKey();
  if (resState.groups) {
    if (!resState.total) { toast("No results to export"); return; }
    const out = [];
    resState.groups.forEach((g) => {
      out.push("== " + displayConvName(g.d.conv) + " ==");
      g.idx.forEach((i) => out.push(exportLine(g.d.msgs[i], g.d.conv)));
      out.push("");
    });
    downloadText("search-results-all-chats-" + day + ".txt", out);
    toast("Exported " + fmtNum(resState.total) + " results from " + resState.groups.length + (resState.groups.length === 1 ? " chat" : " chats"));
    return;
  }
  if (!resState.idx.length) { toast("No results to export"); return; }
  downloadText("search-results-" + day + ".txt", resState.idx.map((i) => exportLine(MSGS[i])));
  toast("Exported " + fmtNum(resState.idx.length) + " results");
}

/* ---- Saved searches ------------------------------------------------------ */
function saveCurrentSearch() {
  const def = sEls.input.value.trim() || "Saved filter";
  const name = prompt("Name this search:", def);
  if (!name) return;
  settings.saved.push({
    name, q: sEls.input.value,
    f: { people: [...F.people], from: sEls.from.value, to: sEls.to.value, media: F.media, links: F.links, reacts: F.reacts },
  });
  saveSettings(); toast("Saved “" + name + "”");
}
function toggleSavedPopover() {
  closePopovers();
  const wrap = sEls.saved.parentElement;
  const pop = el("div", "popover right");
  if (!settings.saved.length) { pop.appendChild(el("div", "pop-empty", "No saved searches yet.")); wrap.appendChild(pop); return; }
  settings.saved.forEach((s, idx) => {
    const item = el("div", "pop-item pop-row");
    const left = btnEl("pop-run", "★ " + esc(s.name));
    left.onclick = () => { applySaved(s); closePopovers(); };
    const del = btnEl("icon-btn", cmdIco("trash"), "Delete saved search " + s.name); del.title = "Delete";
    del.onclick = (e) => { e.stopPropagation(); settings.saved.splice(idx, 1); saveSettings(); toggleSavedPopover(); };
    item.appendChild(left); item.appendChild(del);
    pop.appendChild(item);
  });
  wrap.appendChild(pop);
}
function applySaved(s) {
  sEls.input.value = s.q || ""; sEls.clear.hidden = !sEls.input.value;
  const f = s.f || {};
  F.people = new Set(f.people || []); updatePeopleBadge();
  F.fromStr = f.from || ""; F.toStr = f.to || "";
  sEls.from.value = F.fromStr; sEls.to.value = F.toStr;
  syncDateBounds();
  sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to));
  F.media = !!f.media; F.links = !!f.links; F.reacts = !!f.reacts;
  sEls.media.classList.toggle("active", F.media);
  sEls.links.classList.toggle("active", F.links);
  sEls.reacts.classList.toggle("active", F.reacts);
  runSearch();
}
function closePopovers() { document.querySelectorAll(".popover").forEach((p) => p.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".popwrap")) closePopovers(); });
// a tap anywhere outside an open ⋯ toolbar's message closes it.
document.addEventListener("click", (e) => { if (!e.target.closest(".msg.acts-open")) closeMsgActs(); }, true);

/* ===========================================================================
   TIMELINE VIEW & VIRTUAL SCROLLER
   ======================================================================== */
let tlBuilt = false, tlEls = {}, virtObs = null;
// { idx, off }: the message to reopen a rebuilt timeline on and its offset
// from the scroller top (set when leaving the view).
let tlResume = null;
// Drop the built timeline so the next visit rebuilds it (new zone labels,
// new conversation). Shared by resetDerived() and the timezone handler.
function invalidateTimeline() {
  tlBuilt = false;
  if (virtObs) { try { virtObs.disconnect(); } catch (e) {} virtObs = null; }
}
// The first message whose top is inside the timeline scroller, and how far
// below the scroller's top edge it sits. end: the scroller is at the very
// bottom (reading the newest message) — reopened as "at the newest", so a
// later rebuild with more messages still lands on the newest one.
function timelineFirstVisible() {
  if (!tlBuilt || !tlEls.scroll || !tlEls.scroll.clientHeight) return null;
  const s = tlEls.scroll;
  const end = s.scrollHeight - s.scrollTop - s.clientHeight < 8;
  const top = s.getBoundingClientRect().top;
  for (const n of tlEls.list.querySelectorAll(".msg")) {
    const t = n.getBoundingClientRect().top;
    if (t >= top) return { idx: +n.dataset.idx, off: t - top, end };
  }
  return null;
}
/* ---- Reading position per conversation ---------------------------------
   The Timeline opens at the NEWEST message the first time, and afterwards where
   that conversation was last being read — across conversation switches and
   reloads. Stored as { convId: { m: message id, o: px offset } | { e: 1 } (at
   the newest), t: last write } under gca.tlpos, capped to TLPOS_MAX
   conversations (oldest write dropped). Ids and offsets only, never text.
   Every storage access is guarded; tlPosMem mirrors the map so positions still
   follow conversation switches within a session when storage is blocked.
   Reset customization keeps them (navigation state, like bookmarks). */
const TLPOS_KEY = "gca.tlpos", TLPOS_MAX = 50;
let tlPosMem = null;
function tlPosMap() {
  if (!tlPosMem) {
    tlPosMem = {};
    try {
      const o = JSON.parse(localStorage.getItem(TLPOS_KEY) || "{}");
      if (isPlainObj(o)) for (const k in o) if (isPlainObj(o[k])) tlPosMem[k] = o[k];
    } catch (e) { /* storage blocked / corrupt: start empty */ }
  }
  return tlPosMem;
}
// The saved position of the ACTIVE conversation as { idx, off } / { end: true },
// or null (never read, or its message is gone / hidden now).
function storedTlPos() {
  const e = CONV && Object.prototype.hasOwnProperty.call(tlPosMap(), CONV.id) ? tlPosMap()[CONV.id] : null;
  if (!e) return null;
  if (e.e === 1) return { end: true };
  const idx = ID2IDX.get(e.m);
  return idx == null ? null : { idx, off: Math.max(0, Math.min(+e.o || 0, 4000)) };
}
// Record where the (visible) Timeline is being read for the active conversation.
function saveTlPos() {
  if (!CONV || !N || curView !== "timeline") return;
  const p = timelineFirstVisible();
  if (!p || !MSGS[p.idx]) return;
  const map = tlPosMap();
  delete map[CONV.id];   // re-insert last: key order = write order
  map[CONV.id] = p.end ? { e: 1, t: Date.now() } : { m: MSGS[p.idx].i, o: Math.round(p.off), t: Date.now() };
  const keys = Object.keys(map);
  for (let k = 0; k < keys.length - TLPOS_MAX; k++) delete map[keys[k]];
  try { localStorage.setItem(TLPOS_KEY, JSON.stringify(map)); } catch (e) { /* storage blocked: memory only */ }
  // The entry's #m= names the message a jump landed on. Once the reader has
  // scrolled it out of view, stop naming it (replace, not push), so a reload
  // reopens this reading position instead of snapping back to the jump.
  if (navMsg != null && !jumpTargetInView()) { navMsg = null; navCommit("replace"); }
}
function jumpTargetInView() {
  const i = ID2IDX.get(navMsg);
  const n = i == null ? null : tlEls.list.querySelector('.msg[data-idx="' + i + '"]');
  if (!n) return false;
  const r = n.getBoundingClientRect(), sr = tlEls.scroll.getBoundingClientRect();
  return r.bottom > sr.top && r.top < sr.bottom;
}
// Open the active conversation's Timeline where it was last read (this session's
// tlResume first — e.g. after a timezone rebuild — then the saved position),
// else at the newest message.
function openTimelineAtReadingPosition() {
  const pos = tlResume || storedTlPos();
  if (pos && !pos.end && pos.idx != null) openTimeline(Math.min(pos.idx, Math.max(0, N - 1)), { quiet: true, off: pos.off });
  else openTimeline(N - 1, { bottom: true });
}
// "Jump to latest" button / End key, and Home.
function jumpToLatest() { tlEdge(N - 1, { bottom: true }); }
function jumpToOldest() { tlEdge(0, { top: true }); }
function tlEdge(idx, opts) {
  if (!N) return;
  // A keyboard user on a message (or on the button, which hides at the
  // newest) moves with the jump instead of dropping to <body> when the old
  // chunk is virtualized away.
  const a = document.activeElement;
  const carry = !!(a && tlEls.scroll && (tlEls.scroll.contains(a) || a.id === "tl-latest"));
  openTimeline(idx, opts);
  updateLatestBtn();
  if (carry) {
    const m = tlEls.list.querySelector('.msg[data-idx="' + idx + '"]');
    if (m) { try { m.focus({ preventScroll: true }); } catch (e) {} }
  }
}
// The floating "Jump to latest" button shows once the reader is more than
// half a screen above the newest message.
function updateLatestBtn() {
  const b = document.getElementById("tl-latest"), s = tlEls.scroll;
  if (!b || !s) return;
  b.hidden = !N || s.scrollHeight - s.scrollTop - s.clientHeight <= Math.max(200, s.clientHeight / 2);
}
// Day pills are sticky siblings inside one chunk, so every day already
// scrolled past stays pinned at the same spot under the current one and showed
// through its translucent background as ghost labels. Fade out all but the
// newest pill at the sticky line (opacity, so they stay in the a11y tree).
function buryStuckPills() {
  const s = tlEls.scroll, list = tlEls.list;
  if (!s || !list) return;
  const top = s.getBoundingClientRect().top;
  const pills = [...list.querySelectorAll(".daysep")].map((d) => ({ d, r: d.firstElementChild.getBoundingClientRect() })).filter((p) => p.r.height);
  let line = Infinity;
  for (const p of pills) if (p.r.top >= top - 0.5 && p.r.top < line) line = p.r.top;
  const stuck = pills.filter((p) => Math.abs(p.r.top - line) < 1);
  const keep = stuck.length ? stuck[stuck.length - 1].d : null;
  for (const p of pills) p.d.classList.toggle("buried", p.d !== keep && Math.abs(p.r.top - line) < 1);
}
const CHUNK_SIZE = 50;
let numChunks = 0, chunkHeights = [], chunkRendered = [], eventBuckets = [];

function ensureTimelineShell() {
  if (tlBuilt) return;
  tlBuilt = true;
  const v = document.getElementById("view-timeline");
  // Toolbar (mock .toolbar): rebuilt with the shell on every conversation
  // switch (tlBuilt is reset by resetDerived()), so the count stays fresh.
  v.innerHTML = `
    <div class="tl-toolbar">
      <span class="tt">Timeline</span>
      <span class="tc">${fmtNum(N)} message${N === 1 ? "" : "s"}</span>
      <span class="spacer"></span>
      <button class="tbtn" id="tl-jumpdate" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>Jump to date</button>
      <button class="tbtn" id="tl-search" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>Search<span class="kbd" aria-hidden="true">/</span></button>
    </div>
    <div class="scroll" id="tl-scroll" style="position:relative;">
      <div class="list" id="tl-list"></div>
    </div>
    <button class="tl-latest" id="tl-latest" type="button" aria-label="Jump to latest message" title="Jump to latest (End)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v13M6 12l6 6 6-6"/></svg><span>Latest</span></button>
  `;
  // "Jump to date" opens the calendar (which has its own typed-date
  // box). "Search" opens the Search view with the box focused
  // (as "/" does; Ctrl/Cmd+K is the palette, which searches messages too).
  v.querySelector("#tl-jumpdate").onclick = () => openCalendar();
  v.querySelector("#tl-search").onclick = () => openSearchWith(null);
  tlEls = { scroll: v.querySelector("#tl-scroll"), list: v.querySelector("#tl-list") };
  v.querySelector("#tl-latest").onclick = jumpToLatest;
  // keep the "Jump to latest" button and the saved reading position
  // current (one rAF per scroll burst; the save waits for the scroll to rest).
  let latestRaf = 0, posT = 0;
  tlEls.scroll.addEventListener("scroll", () => {
    if (!latestRaf) latestRaf = requestAnimationFrame(() => { latestRaf = 0; updateLatestBtn(); buryStuckPills(); });
    clearTimeout(posT); posT = setTimeout(saveTlPos, 250);
  }, { passive: true });
  // The shell was just rebuilt with an EMPTY #tl-list, so the chunk bookkeeping
  // must restart too. numChunks survives resetDerived(); if the next active
  // conversation has the SAME chunk count as the last one, openTimeline() would
  // otherwise skip rebuilding the chunk divs and leave the timeline blank
  // (Cross-conversation pin jumps land on this path too.)
  numChunks = 0; chunkHeights = []; chunkRendered = []; eventBuckets = [];

  virtObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      // when the Timeline view is hidden (another view is showing) the
      // root isn't laid out and every chunk reports "not intersecting" with a
      // 0 height. Acting on that unrendered the whole list and cached a bogus
      // height, so the preserved scrollTop pointed somewhere else on return.
      if (!e.rootBounds || !e.rootBounds.height) return;
      const idx = +e.target.dataset.c;
      if (e.isIntersecting) {
        renderChunk(idx, e.target);
      } else if (chunkRendered[idx]) {
        const h = e.target.offsetHeight;
        if (!h) return;   // never cache a 0 (not laid out) height
        chunkHeights[idx] = h;
        e.target.style.height = chunkHeights[idx] + "px";
        e.target.innerHTML = "";
        chunkRendered[idx] = false;
      }
    });
  }, { root: tlEls.scroll, rootMargin: "1500px" });
}

// opts.quiet: restore a reading position — no flash; the anchor goes back to
// opts.off px below the scroller top. opts.top: open at the very top, quietly.
// opts.bottom: open at the very bottom (the newest message), quietly.
function openTimeline(anchor, opts) {
  opts = opts || {};
  ensureTimelineShell();
  // No messages (none at all, or every sender ignored): no chunks to build, and renderChunk() would
  // dereference MSGS[start]/MSGS[N-1] on an empty array. Show a panel instead.
  if (!N) {
    tlEls.list.innerHTML = '<div class="empty"><div class="big">≡</div><div>' + emptyConvText() + '</div></div>';
    return;
  }
  if (numChunks === 0 || numChunks !== Math.ceil(N / CHUNK_SIZE)) {
    numChunks = Math.ceil(N / CHUNK_SIZE);
    chunkHeights = new Array(numChunks).fill(2500);
    chunkRendered = new Array(numChunks).fill(false);
    tlEls.list.innerHTML = "";
    for(let i=0; i<numChunks; i++) {
       const c = el("div", "tl-chunk"); c.dataset.c = i;
       c.style.height = chunkHeights[i] + "px";
       tlEls.list.appendChild(c);
       virtObs.observe(c);
    }
    // bucket every system event to exactly one chunk here, once,
    // instead of re-scanning all of EVENTS against each chunk's message-time
    // envelope on every renderChunk() call. Owning chunk = chunk of the first
    // message at-or-after the event's time (binary search over MSGS, which
    // is sorted ascending by t) — this also naturally places pre-first-message
    // events (create/name, fired before MSGS[0].t) into chunk 0, and gap
    // events into the chunk of the next message, with no boundary duplicate.
    eventBuckets = Array.from({ length: numChunks }, () => []);
    const ignored = ignoredUserIds();
    EVENTS.forEach((e) => {
      if (!eventShown(e, ignored)) return;
      let lo = 0, hi = N;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (MSGS[mid].t < e.t) lo = mid + 1; else hi = mid;
      }
      const chunkIdx = lo < N ? Math.floor(lo / CHUNK_SIZE) : numChunks - 1;
      eventBuckets[chunkIdx].push(e);
    });
  }
  if (anchor == null) anchor = 0;
  const chunkIdx = Math.floor(anchor / CHUNK_SIZE);

  // Force synchronous render of the target chunk so it exists in DOM right now
  const chunkContainer = tlEls.list.childNodes[chunkIdx];
  if (chunkContainer && !chunkRendered[chunkIdx]) {
      renderChunk(chunkIdx, chunkContainer);
  }

  let offset = 0;
  for(let i=0; i<chunkIdx; i++) offset += chunkHeights[i];
  
  tlEls.scroll.style.scrollBehavior = "auto";
  tlEls.scroll.scrollTop = offset;
  
  const target = tlEls.list.querySelector('[data-idx="' + anchor + '"]');
  if (opts.top) tlEls.scroll.scrollTop = 0;   // the very start, day pill and all, no highlight
  else if (opts.bottom) tlEls.scroll.scrollTop = tlEls.scroll.scrollHeight;   // the newest message, no highlight
  else if (target) {
    if (opts.quiet) {
      tlEls.scroll.scrollTop += target.getBoundingClientRect().top - tlEls.scroll.getBoundingClientRect().top - (opts.off || 0);
    } else {
      target.scrollIntoView({ block: "center", behavior: "auto" });
      target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1700);
    }
  }
  
  renderChunksInView(opts.top || opts.bottom ? null : target, opts);

  // Re-enable smooth scrolling after jumping
  setTimeout(() => tlEls.scroll.style.scrollBehavior = "", 10);
  updateLatestBtn();
}

// Render every placeholder chunk now on screen, in the same task as the jump,
// and keep the target where it was put. Left to the IntersectionObserver, such
// a chunk fills in a frame later at its real height; above the target that
// pushes the reader's message out of place, and scroll anchoring can't be
// counted on to undo it (the placeholder itself can be the anchor).
function renderChunksInView(target, opts) {
  // Pass 2 normally finds nothing: 50 messages are taller than a screen. More
  // passes happen only when rendered chunks come out shorter than their
  // placeholder and reveal more; the bound just stops a runaway loop.
  for (let pass = 0; pass < 8; pass++) {
    const sr = tlEls.scroll.getBoundingClientRect();
    const todo = [];
    tlEls.list.childNodes.forEach((c, i) => {
      if (chunkRendered[i]) return;
      const r = c.getBoundingClientRect();
      if (r.bottom > sr.top && r.top < sr.bottom) todo.push(i);
    });
    if (!todo.length) return;
    const before = target ? target.getBoundingClientRect().top : 0;
    todo.forEach((i) => renderChunk(i, tlEls.list.childNodes[i]));
    if (target) tlEls.scroll.scrollTop += target.getBoundingClientRect().top - before;
    else if (opts.bottom) tlEls.scroll.scrollTop = tlEls.scroll.scrollHeight;
    else if (opts.top) tlEls.scroll.scrollTop = 0;
  }
}

function renderChunk(idx, container) {
  if (chunkRendered[idx]) return;
  container.innerHTML = "";
  const start = idx * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, N);

  const items = [];
  for (let i = start; i < end; i++) items.push({ t: MSGS[i].t, kind: "m", i });
  (eventBuckets[idx] || []).forEach((e) => items.push({ t: e.t, kind: "e", e }));
  items.sort((a, b) => a.t - b.t);

  // continue the day / sender-run state from the previous chunk instead
  // of restarting it at every 50-message seam. Events are bucketed to the
  // chunk of the first message at-or-after them, so the previous chunk ends
  // with an event (which breaks a run) only if one is at/after MSGS[start-1].
  let prevDay = null;
  let prevSenderId = null;
  let prevTimestamp = 0;
  const frag = document.createDocumentFragment();
  if (start > 0) {
    const pm = MSGS[start - 1];
    prevDay = dayKey(pm.t);
    if (!(eventBuckets[idx - 1] || []).some((e) => e.t >= pm.t)) { prevSenderId = pm.s; prevTimestamp = pm.t; }
    // Same day continues: in-flow pill suppressed, sticky-only continuation pill
    // (chunks are contain:paint, so the earlier chunk's sticky pill can't follow).
    if (items.length && dayKey(items[0].t) === prevDay) frag.appendChild(renderDaySep(items[0].t, true));
  }
  items.forEach((it) => {
    const dk = dayKey(it.t);
    if (dk !== prevDay) {
      frag.appendChild(renderDaySep(it.t));
      prevDay = dk;
      prevSenderId = null;
      prevTimestamp = 0;
    }
    if (it.kind === "m") {
      const msg = MSGS[it.i];
      const isConsecutive = (prevSenderId === msg.s) && (it.t - prevTimestamp < 300000);
      frag.appendChild(renderMsg(it.i, { context: true, consecutive: isConsecutive }));
      prevSenderId = msg.s;
      prevTimestamp = it.t;
    } else {
      frag.appendChild(renderEvent(it.e));
      prevSenderId = null;
      prevTimestamp = 0;
    }
  });
  container.appendChild(frag);
  container.style.height = "auto";
  chunkRendered[idx] = true;
}

// System event chip (mock .sysevent .chip): dashed inset pill with a sparkle
// icon and bold actor names. Outer class stays `sysline`; each fragment is
// escaped individually so the <b> wrappers survive.
const SYS_EVENT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/></svg>';
// An ignored person reads "Someone" here, and a join or leave that is only
// about ignored people isn't shown at all (eventShown).
function eventShown(e, ignored) {
  const ids = e.ids || [];
  return !((e.type === "join" || e.type === "leave") && ids.length && ids.every((id) => ignored.has(String(id))));
}
function renderEvent(e) {
  const ignored = ignoredUserIds();
  const bn = (id) => (ignored.has(String(id)) ? "Someone" : "<b>" + esc(nameOf(id)) + "</b>");
  const ids = (e.ids || []).filter((id) => !ignored.has(String(id)));
  let txt = "";
  if (e.type === "name") txt = bn(e.s) + " named the group “" + esc(e.name) + "”";
  else if (e.type === "join") txt = (e.s ? bn(e.s) + " added " : "Added ") + ids.map(bn).join(", ");
  else if (e.type === "leave") txt = ids.map(bn).join(", ") + " left";
  else if (e.type === "create") txt = (e.s ? bn(e.s) : "Someone") + " created the conversation";
  return el("div", "sysline", '<span class="chip">' + SYS_EVENT_ICON + "<span>" + txt + "</span></span>");
}
// tlJumping: setView("timeline") must not first restore the reading position
// (an extra render + scroll) when a jump is about to land somewhere anyway.
let tlJumping = false;
function jumpTo(i) {
  tlJumping = true;
  try { setView("timeline"); } finally { tlJumping = false; }
  openTimeline(i);
  navMsg = MSGS[i] ? MSGS[i].i : null;   // the jump is a history entry (#m=)
  navCommit("push");
}

/* ===========================================================================
   STATS VIEW
   ======================================================================== */
/* ---- Superlatives: ONE definition list ---------------------
   Every award is one row here. The deferred Stats grid AND the profile badges
   both read the resulting STATS.awards — same winners, same filter — so a badge
   can never exist for a card that isn't shown.

   Scoring (statsGen scores each row per person from one sweep):
     - `need` — who is eligible: "all" (every member, including people who never
       posted), "msgs" (at least minMsgs messages), "words" (minMsgs messages
       with words), "replies" (MIN_REPLIES replies), "scholar" (minMsgs messages
       and at least the smallest vocabulary checkpoint of words);
     - `value(P, ctx)` — the score from that person's record;
     - `min: true` — lowest wins (otherwise highest).
   Frequency awards are rates (per 100 messages / % of messages), not raw
   counts, so the top poster doesn't win them all by volume.
   Visibility: a card is hidden when fewer than two people are eligible, when a
   highest-wins best is 0, or when every eligible person ties; when 2+ share
   the best they are all winners (the card shows "tied with …", each gets the
   badge).
   `def` is shown on the card: what exactly is measured. */
const MIN_MSGS_FLOOR = 20;          // rate / average awards: at least this many messages…
const MIN_MSGS_SHARE = 0.01;        // …or 1% of the chat, whichever is larger
const MIN_REPLIES = 5;              // reply-time awards: at least this many replies
const REPLY_WINDOW_MS = 12 * 3600000;   // a reply answers someone else within 12 h
const PAIR_WINDOW_MS = 30 * 60000;      // "interaction pairs": answers within 30 min
const DOUBLE_TEXT_MS = 3600000;         // a follow-up to your own message within 1 h
const MONOLOGUE_RUN = 5;                // 5+ messages in a row
// Scholar compares the same number of words for everyone: distinct words in
// each eligible person's first W words, W = the largest checkpoint EVERY
// eligible person has reached.
const SCHOLAR_CHECKPOINTS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const LAUGH_REACTS = new Set(["😂", "🤣", "😭", "💀"]);
const HATE_REACTS = new Set(["👎", "😡", "🤬", "😠"]);

const pct = (v) => (v >= 10 ? Math.round(v) : +v.toFixed(1)) + "%";
const per100 = (v) => v.toFixed(1);
const share = (n, P) => (P.msgs ? (n / P.msgs) * 100 : 0);
function fmtDur(ms) {
  if (ms >= 86400000) return plural(+(ms / 86400000).toFixed(1), "day");
  if (ms >= 3600000) return (ms / 3600000).toFixed(1) + "h";
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms > 0 && ms < 1000) return "<1s";      // not "0s" for a quick reply
  return Math.round(ms / 1000) + "s";
}
// a chat's age in the unit that reads naturally — "3 days", "5 months",
// "2.4 years" — never "0.0 yrs" for a young chat. `days` is whole calendar
// days in the configured zone (first message day → last message day).
function fmtAge(days) {
  if (days < 1) return "Under a day";
  if (days < 61) return plural(days, "day");
  const months = Math.floor(days / 30.4375);
  if (months < 24) return plural(months, "month");
  return (days / 365.25).toFixed(1) + " years";
}
const SUPERLATIVES = [
  { key: "owl", icon: "🦉", title: "Late Night Owl", need: "msgs", value: (P) => share(P.night, P),
    fmt: (v) => pct(v) + " of msgs 12–5 AM", def: "Highest share of their messages sent between midnight and 5 AM." },
  { key: "reacts", icon: "⭐", title: "Reaction Magnet", need: "all", value: (P) => P.reactsRecv,
    fmt: (v) => plural(v, "reaction") + " received", def: "Most reactions received on their messages." },
  { key: "emoji", icon: "😂", title: "Emoji Enthusiast", need: "msgs", value: (P) => share(P.emoji, P),
    fmt: (v) => per100(v) + " emoji / 100 msgs", def: "Most emoji per 100 messages (a skin-toned or combined emoji counts once)." },
  { key: "media", icon: "📷", title: "Media Hog", need: "all", value: (P) => P.media,
    fmt: (v) => plural(v, "file") + " shared", def: "Most photos, videos and files sent." },
  { key: "yapper", icon: "🗣️", title: "The Yapper", need: "words", value: (P) => P.words / P.msgWithWords,
    fmt: (v) => v.toFixed(1) + " words / msg", def: "Longest messages on average: words per message." },
  { key: "caveman", icon: "🪨", title: "The Caveman", need: "words", min: true, value: (P) => P.words / P.msgWithWords,
    fmt: (v) => v.toFixed(1) + " words / msg", def: "Shortest messages on average: words per message." },
  { key: "swear", icon: "🤬", title: "The Sailor", need: "msgs", value: (P) => share(P.swear, P),
    fmt: (v) => pct(v) + " of msgs swear", def: "Highest share of messages with a swear word." },
  { key: "caps", icon: "📢", title: "The Shouter", need: "msgs", value: (P) => share(P.caps, P),
    fmt: (v) => pct(v) + " of msgs ALL CAPS", def: "Highest share of messages written in ALL CAPS (6+ characters)." },
  { key: "question", icon: "❓", title: "The Inquisitor", need: "msgs", value: (P) => share(P.question, P),
    fmt: (v) => pct(v) + " of msgs ask", def: "Highest share of messages that ask something (contain a “?”)." },
  { key: "narcissist", icon: "🪞", title: "The Narcissist", need: "msgs", value: (P) => share(P.narc, P),
    fmt: (v) => per100(v) + ' "I/me/my" / 100 msgs', def: "Most “I / me / my / mine / myself” per 100 messages." },
  { key: "comedian", icon: "🤣", title: "The LMAO User", need: "msgs", value: (P) => share(P.laughs, P),
    fmt: (v) => per100(v) + " laughs / 100 msgs", def: "Most laughs (lol, lmao, haha, 😂, 💀 …) per 100 messages." },
  { key: "reactor", icon: "🎁", title: "The Giver", need: "all", value: (P) => P.given,
    fmt: (v) => plural(v, "reaction") + " given", def: "Most reactions given." },
  { key: "link", icon: "🔗", title: "The Link Spammer", need: "all", value: (P) => P.links,
    fmt: (v) => plural(v, "link") + " shared", def: "Most links shared." },
  { key: "starter", icon: "🚀", title: "Thread Starter", need: "all", value: (P) => P.starter,
    fmt: (v) => plural(v, "day") + " started", def: "Sent the first message of the day most often." },
  { key: "killer", icon: "🔚", title: "Thread Killer", need: "all", value: (P) => P.killer,
    fmt: (v) => plural(v, "day") + " ended", def: "Sent the last message of the day most often." },
  { key: "doubleText", icon: "✌️", title: "The Double Texter", need: "msgs", value: (P) => share(P.doubleText, P),
    fmt: (v) => per100(v) + " double texts / 100 msgs", def: "Most follow-ups to their own message within an hour, per 100 messages." },
  { key: "weekend", icon: "🎉", title: "Weekend Warrior", need: "msgs", value: (P) => share(P.weekend, P),
    fmt: (v) => pct(v) + " of msgs on weekends", def: "Highest share of messages sent on Saturday or Sunday." },
  { key: "slacker", icon: "💼", title: "The Work Slacker", need: "msgs", value: (P) => share(P.slacker, P),
    fmt: (v) => pct(v) + " of msgs 9–5 weekdays", def: "Highest share of messages sent 9 AM–5 PM on weekdays." },
  { key: "lurker", icon: "👻", title: "The Ghost", need: "all", min: true, value: (P) => P.msgs,
    fmt: (v) => (v ? "Only " + plural(v, "message") + " total" : "Never posted"), def: "Fewest messages sent — members who never posted count too." },
  { key: "ghoster", icon: "🐌", title: "The Ghoster", need: "replies", value: (P) => P.replyMedian,
    fmt: (v) => fmtDur(v) + " median reply", def: "Slowest typical reply: median time to answer someone else (answers within 12 h, 5+ replies)." },
  { key: "flash", icon: "⚡", title: "The Flash", need: "replies", min: true, value: (P) => P.replyMedian,
    fmt: (v) => fmtDur(v) + " median reply", def: "Fastest typical reply: median time to answer someone else (answers within 12 h, 5+ replies)." },
  { key: "scholar", icon: "📚", title: "The Scholar", need: "scholar", value: (P, ctx) => P.scholarAt[ctx.scholarW],
    fmt: (v, ctx) => plural(v, "different word") + " in first " + fmtNum(ctx.scholarW),
    def: "Biggest vocabulary: distinct words among each person’s first N words (the same N for everyone)." },
  { key: "novelist", icon: "📜", title: "The Novelist", need: "all", value: (P) => P.maxLen,
    fmt: (v) => plural(v, "character") + " (longest msg)", def: "Longest single message, in characters." },
  { key: "keysmash", icon: "⌨️", title: "The Keysmasher", need: "msgs", value: (P) => share(P.keysmash, P),
    fmt: (v) => pct(v) + " of msgs keysmash", def: "Highest share of keyboard-mash messages (asdf, sdfghjkl …)." },
  { key: "earlyBird", icon: "🐦", title: "The Early Bird", need: "msgs", value: (P) => share(P.early, P),
    fmt: (v) => pct(v) + " of msgs 5–8 AM", def: "Highest share of messages sent between 5 and 8 AM." },
  { key: "vampiricOwl", icon: "🧛", title: "Vampiric Owl", need: "msgs", value: (P) => share(P.vampire, P),
    fmt: (v) => pct(v) + " of msgs 3–5 AM", def: "Highest share of messages sent between 3 and 5 AM." },
  { key: "deserter", icon: "🏃", title: "The Deserter", need: "msgs", value: (P) => P.desertMsgs,
    // On a tie the duration is quoted only when every winner's silence lasted
    // the same time (review fix 8) — never the first winner's for all of them.
    fmt: (v, ctx, P, W) => {
      const ms = (W || [P]).map((x) => (x ? x.desertMs : 0));
      const same = ms.every((m) => m === ms[0]);
      return plural(v, "message") + " from others" + (same && ms[0] ? " over " + fmtDur(ms[0]) : "") + " without a word";
    },
    def: "Longest silence while the chat kept going: messages from others between two of theirs (or since their last)." },
  { key: "monologuer", icon: "🎤", title: "The Monologuer", need: "msgs", value: (P) => share(P.monologues, P),
    fmt: (v) => per100(v) + " runs of 5+ / 100 msgs", def: "Most runs of 5+ messages in a row, per 100 messages." },
  { key: "crowdPleaser", icon: "👏", title: "Crowd Pleaser", need: "msgs", value: (P) => P.reactsRecv / P.msgs,
    fmt: (v) => v.toFixed(2) + " reactions / msg", def: "Most reactions received per message sent." },
  { key: "ignored", icon: "🦗", title: "The Ignored", need: "msgs", value: (P) => share(P.zeroReact, P),
    fmt: (v) => pct(v) + " of msgs got no reaction", def: "Highest share of messages that got no reaction." },
  { key: "laughTrack", icon: "😆", title: "The Laugh Track", need: "all", value: (P) => P.laughGiven,
    fmt: (v) => plural(v, "laughing reaction") + " given", def: "Most laughing reactions given (funny, 😂 🤣 😭 💀)." },
  { key: "hater", icon: "👎", title: "The Hater", need: "all", value: (P) => P.hateGiven,
    fmt: (v) => plural(v, "👎/😡 reaction") + " given", def: "Most thumbs-down or angry reactions given (👎 😡 🤬 😠)." },
  { key: "tiktok", icon: "🎵", title: "The TikToker", need: "all", value: (P) => P.tt,
    fmt: (v) => plural(v, "TikTok link") + " shared", def: "Most tiktok.com links shared." },
  { key: "youtube", icon: "▶️", title: "The YouTuber", need: "all", value: (P) => P.yt,
    fmt: (v) => plural(v, "YouTube link") + " shared", def: "Most youtube.com / youtu.be links shared." },
  { key: "twitter", icon: "🐤", title: "X/Twitter Addict", need: "all", value: (P) => P.tw,
    fmt: (v) => plural(v, "X / Twitter link") + " shared", def: "Most x.com / twitter.com links shared." },
  { key: "gratitude", icon: "🙏", title: "Gratitude King", need: "msgs", value: (P) => share(P.gratitude, P),
    fmt: (v) => per100(v) + " thank-yous / 100 msgs", def: "Most thank-yous (thanks, thank you, ty, thx …) per 100 messages." },
  { key: "laughVoid", icon: "🕳️", title: "The Laughing Void", need: "msgs", value: (P) => share(P.laughVoid, P),
    fmt: (v) => pct(v) + " of msgs only laughter", def: "Highest share of messages that are nothing but laughter (lol, lmao, 😂 …)." },
  { key: "exclaimer", icon: "❗", title: "The Exclaimer", need: "msgs", value: (P) => share(P.exclaims, P),
    fmt: (v) => per100(v) + " “!” / 100 msgs", def: "Most exclamation marks per 100 messages." },
  { key: "midnightSniper", icon: "🎯", title: "Midnight Sniper", need: "msgs", value: (P) => share(P.midnight, P),
    fmt: (v) => pct(v) + " of msgs at 12:00 AM", def: "Highest share of messages sent in the 12:00 AM minute." },
  { key: "optimist", icon: "☀️", title: "The Optimist", need: "msgs", value: (P) => share(P.optimist, P),
    fmt: (v) => per100(v) + " positive words / 100 msgs", def: "Most positive words (good, great, awesome, love, best …) per 100 messages." },
  { key: "pessimist", icon: "🌧️", title: "The Pessimist", need: "msgs", value: (P) => share(P.pessimist, P),
    fmt: (v) => per100(v) + " negative words / 100 msgs", def: "Most negative words (bad, terrible, awful, hate, worst) per 100 messages." },
  { key: "zoomer", icon: "🧢", title: "The Zoomer", need: "msgs", value: (P) => share(P.zoomer, P),
    fmt: (v) => per100(v) + " slang words / 100 msgs", def: "Most Gen-Z slang (fr, ngl, no cap, sus, bruh …) per 100 messages." },
  { key: "gamer", icon: "🎮", title: "The Gamer", need: "msgs", value: (P) => share(P.gamer, P),
    fmt: (v) => per100(v) + " gamer terms / 100 msgs", def: "Most gamer terms (gg, wp, nerf, noob …) per 100 messages." },
  { key: "financeBro", icon: "📈", title: "Finance Bro", need: "msgs", value: (P) => share(P.finance, P),
    fmt: (v) => per100(v) + " crypto/stock terms / 100 msgs", def: "Most crypto / stock talk (btc, stocks, hodl, to the moon …) per 100 messages." },
];
const RE_UPPER = /\p{Lu}/u;         // an ALL CAPS message has at least one capital
const RE_BANG = /[!！]/g;              // counted via countMatches (match resets lastIndex)

/* ---- Time-sliced sweeps ------------------------------------------------
   Text-heavy sweeps (computeStats' superlatives + word cloud, the fuzzy
   bigram index) are generator functions that `yield` once the current slice's
   deadline (sliceEnd) has passed, checked every 1024 messages. A job wraps one
   such generator for one input (`key`):
     - synchronous callers (profile modal, Wrapped, …) drain it: runJob(job, Infinity)
       — sliceEnd stays Infinity, so the generator never yields;
     - the deferred Stats stage steps it in short tasks: runJob(job, SLICE_MS),
       so the first Stats paint isn't blocked by a ~0.5 s sweep at 100k.
   A job half-stepped by the deferred stage and then drained by a sync caller
   simply finishes from where it was — the result is identical either way. */
let sliceEnd = Infinity;
const SLICE_MS = 24;
function makeJob(key, genFn) { return { key, gen: genFn(), done: false, value: undefined }; }
// Advance `job` for up to `budget` ms (Infinity = to completion). True when done.
function runJob(job, budget) {
  if (job.done) return true;
  const prev = sliceEnd;
  sliceEnd = budget === Infinity ? Infinity : performance.now() + budget;
  try {
    const r = job.gen.next();
    if (r.done) { job.done = true; job.value = r.value; }
  } finally { sliceEnd = prev; }
  return job.done;
}
let statsJob = null;
// Keyed on the time index: a new conversation OR a new zone starts a new sweep.
function statsJobFor() {
  const TI = timeIndex();
  if (!statsJob || statsJob.key !== TI) statsJob = makeJob(TI, statsGen);
  return statsJob;
}

function computeStats() {
  if (STATS) return STATS;
  // Every sender in this conversation is ignored — MSGS[0]/MSGS[N-1]
  // below would throw. Nothing to compute; renderStats() shows an empty panel.
  if (!N) return (STATS = { empty: true });
  const job = statsJobFor();
  runJob(job, Infinity);
  STATS = job.value;
  return STATS;
}
function* statsGen() {
  const emojis = {};
  // Every token of the chat, counted once — the word cloud filters the DISTINCT
  // tokens afterwards (isCloudWord per token would be per-occurrence work).
  const tokenCounts = new Map();
  let totalWords = 0;

  // One record per person (every member, so zero-message people score 0).
  const rec = new Map();
  const blank = (id) => ({
    id, msgs: 0, night: 0, early: 0, vampire: 0, weekend: 0, slacker: 0, midnight: 0,
    media: 0, links: 0, tt: 0, yt: 0, tw: 0, ig: 0,
    reactsRecv: 0, zeroReact: 0, given: 0, laughGiven: 0, hateGiven: 0,
    starter: 0, killer: 0, words: 0, msgWithWords: 0, vocab: new Set(), tokN: 0, cpNext: 0, scholarAt: {},
    maxLen: 0, keysmash: 0, swear: 0, caps: 0, question: 0, exclaims: 0, narc: 0, laughs: 0,
    gratitude: 0, laughVoid: 0, optimist: 0, pessimist: 0, zoomer: 0, gamer: 0, finance: 0, emoji: 0,
    doubleText: 0, monologues: 0, replies: [], lastIdx: -1, desertMsgs: 0, desertMs: 0,
  });
  const R = (id) => { let r = rec.get(id); if (!r) { r = blank(id); rec.set(id, r); } return r; };
  PARTS.forEach((p) => R(p.id));
  const replyPairStats = {};  // "userA→userB" -> count (userB answered userA within PAIR_WINDOW_MS)

  let prevDay = null, prevMsgUser = null, run = 0;
  // Every date/hour bucket below reads the configured-zone time index,
  // so they agree with the DT/DAY labels the same message renders with.
  const TI = timeIndex();

  for (let i = 0; i < N; i++) {
    if ((i & 1023) === 1023 && performance.now() > sliceEnd) yield;
    const m = MSGS[i];
    const P = R(m.s);
    P.msgs++;

    // Day starter / killer: the first / last message of each zoned day.
    const dk = TI.day[i];
    if (dk !== prevDay) {
      P.starter++;
      if (prevMsgUser !== null) R(prevMsgUser).killer++;
      prevDay = dk;
    }
    prevMsgUser = m.s;

    // Deserter: messages from others between two of theirs.
    if (P.lastIdx >= 0) {
      const gap = i - P.lastIdx - 1;
      if (gap > P.desertMsgs) { P.desertMsgs = gap; P.desertMs = m.t - MSGS[P.lastIdx].t; }
    }
    P.lastIdx = i;

    const hr = TI.hour[i], dow = TI.dow[i];
    if (dow === 0 || dow === 6) P.weekend++;
    else if (hr >= 9 && hr < 17) P.slacker++;
    if (hr < 5) P.night++;
    if (hr >= 5 && hr < 8) P.early++;
    if (hr >= 3 && hr < 5) P.vampire++;
    if (hr === 0 && TI.minute[i] === 0) P.midnight++;

    if (m.m) P.media++;

    if (m.r && m.r.length) {
      P.reactsRecv += m.r.length;
      for (const r of m.r) {
        const G = R(r.s);
        G.given++;
        if (r.k === "funny" || (r.k === "emoji" && LAUGH_REACTS.has(r.e))) G.laughGiven++;
        if (r.k === "disagree" || (r.k === "emoji" && HATE_REACTS.has(r.e))) G.hateGiven++;
      }
    } else P.zeroReact++;

    if (m.u && m.u.length) {
      P.links += m.u.length;
      for (const u of m.u) {
        const pl = linkPlatform(u.e || u.s || "");
        if (pl === "tiktok") P.tt++;
        else if (pl === "youtube") P.yt++;
        else if (pl === "twitter") P.tw++;
        else if (pl === "instagram") P.ig++;
      }
    }

    const txt = m.x;
    if (txt) {
      // Words — the one shared tokenizer: the per-person word
      // stats, the whole-chat total and the word cloud all count these tokens.
      const toks = tokenize(txt);
      if (toks.length) {
        totalWords += toks.length;
        P.words += toks.length;
        P.msgWithWords++;
        for (const w of toks) {
          P.vocab.add(wordKey(w));
          if (++P.tokN === SCHOLAR_CHECKPOINTS[P.cpNext]) P.scholarAt[SCHOLAR_CHECKPOINTS[P.cpNext++]] = P.vocab.size;
          tokenCounts.set(w, (tokenCounts.get(w) || 0) + 1);
        }
      }
      // Longest message in characters (code points); UTF-16 length is an upper
      // bound, so only a possibly-longer message pays for the exact count.
      if (txt.length > P.maxLen) { const cp = [...txt].length; if (cp > P.maxLen) P.maxLen = cp; }

      // Keyword / keysmash / caps / question checks read the text without its
      // links (review fix 1): a t.co slug is not a keysmash, "?s=20" not a question.
      const plain = plainText(txt);
      if (isKeysmashPlain(plain)) P.keysmash++;
      if (isProfane(plain)) P.swear++;
      if (plain.length > 5 && RE_UPPER.test(plain) && plain === plain.toUpperCase()) P.caps++;
      if (plain.indexOf("?") !== -1 || plain.indexOf("？") !== -1) P.question++;
      P.exclaims += countMatches(RE_BANG, plain);
      P.narc += countMatches(KEYWORDS.narcissist, plain);
      P.laughs += countLaughs(plain);
      P.gratitude += countMatches(KEYWORDS.gratitude, plain);
      if (isLaughOnly(txt)) P.laughVoid++;   // a link is content, not "only laughter"
      P.optimist += countMatches(KEYWORDS.optimist, plain);
      P.pessimist += countMatches(KEYWORDS.pessimist, plain);
      P.zoomer += countMatches(KEYWORDS.zoomer, plain);
      P.gamer += countMatches(KEYWORDS.gamer, plain);
      P.finance += countMatches(KEYWORDS.finance, plain);

      // Emoji — whole sequences (skin tone, ZWJ family, flag, keycap) count
      // once each, the same helper Wrapped uses.
      for (const e of extractEmojis(txt)) {
        emojis[e] = (emojis[e] || 0) + 1;
        P.emoji++;
      }
    }

    // Runs, double texts, replies and interaction pairs.
    if (i > 0) {
      const prev = MSGS[i - 1];
      const diff = m.t - prev.t;
      if (m.s === prev.s) {
        if (++run === MONOLOGUE_RUN) P.monologues++;
        if (diff < DOUBLE_TEXT_MS) P.doubleText++;
      } else {
        run = 1;
        if (diff >= 0 && diff <= REPLY_WINDOW_MS) P.replies.push(diff);
        if (diff > 0 && diff < PAIR_WINDOW_MS) {
          const pairKey = prev.s + "→" + m.s;
          replyPairStats[pairKey] = (replyPairStats[pairKey] || 0) + 1;
        }
      }
    } else run = 1;
  }

  // The archive's last message ends its day too (review fix 5): the loop only
  // credits a day's closer when the next day starts.
  if (prevMsgUser !== null) R(prevMsgUser).killer++;

  // ---- Per-person derived values -------------------------------------------
  const lastT = N ? MSGS[N - 1].t : 0;
  rec.forEach((P) => {
    // Trailing silence: from their last message to the end of the chat.
    if (P.lastIdx >= 0) {
      const gap = N - 1 - P.lastIdx;
      if (gap > P.desertMsgs) { P.desertMsgs = gap; P.desertMs = lastT - MSGS[P.lastIdx].t; }
    }
    const r = P.replies;
    if (r.length) {
      r.sort((a, b) => a - b);
      const h = r.length >> 1;
      P.replyMedian = r.length % 2 ? r[h] : (r[h - 1] + r[h]) / 2;
    } else P.replyMedian = 0;
  });

  // ---- Awards (see SUPERLATIVES) --------------------------------------------
  const minMsgs = Math.max(MIN_MSGS_FLOOR, Math.ceil(MIN_MSGS_SHARE * N));
  const people = PARTS.map((p) => rec.get(p.id));
  const byMsgs = people.filter((P) => P.msgs >= minMsgs);
  let scholarW = 0;
  const scholarPool = byMsgs.filter((P) => P.tokN >= SCHOLAR_CHECKPOINTS[0]);
  if (scholarPool.length) {
    scholarW = Math.min(...scholarPool.map((P) => SCHOLAR_CHECKPOINTS[P.cpNext - 1]));
  }
  const pools = {
    all: people,
    msgs: byMsgs,
    words: people.filter((P) => P.msgWithWords >= minMsgs),
    replies: people.filter((P) => P.replies.length >= MIN_REPLIES),
    scholar: scholarPool,
  };
  const ctx = { minMsgs, scholarW };
  const awards = [];
  for (const d of SUPERLATIVES) {
    const pool = pools[d.need];
    if (pool.length < 2) continue;
    const vals = pool.map((P) => d.value(P, ctx));
    let best = vals[0];
    for (const v of vals) if (d.min ? v < best : v > best) best = v;
    if (!d.min && !(best > 0)) continue;
    const eps = 1e-9 * Math.max(1, Math.abs(best));
    const ids = pool.filter((P, k) => Math.abs(vals[k] - best) <= eps).map((P) => P.id);
    if (ids.length === pool.length) continue;              // everyone ties: nothing to award
    awards.push({ key: d.key, ids, val: best, stat: d.fmt(best, ctx, rec.get(ids[0]), ids.map((id) => rec.get(id))) });
  }

  // ---- Panels ------------------------------------------------------------------
  const yapperStats = {}, doubleTextStats = {}, reactionGenerosity = {}, vocabStats = {}, platformStats = {}, replyStats = {};
  people.forEach((P) => {
    yapperStats[P.id] = P.msgWithWords ? P.words / P.msgWithWords : 0;
    doubleTextStats[P.id] = P.doubleText;
    reactionGenerosity[P.id] = { given: P.given, received: P.reactsRecv };
    vocabStats[P.id] = P.vocab.size;
    platformStats[P.id] = { tt: P.tt, yt: P.yt, tw: P.tw, ig: P.ig };
    if (P.replies.length) replyStats[P.id] = { median: P.replyMedian, count: P.replies.length };
  });

  // Sort interaction pairings
  const topPairs = Object.entries(replyPairStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [fromId, toId] = key.split("→");
      return { fromId, toId, count };
    });

  return {
    // One entry per word across spellings (y'all / yall), in its commonest one.
    words: topCloudWords(tokenCounts, 42),
    totalWords,
    emojis: Object.entries(emojis).sort((a, b) => b[1] - a[1]).slice(0, 15),
    awards, minMsgs, scholarW,
    yapperStats, doubleTextStats, reactionGenerosity, vocabStats, platformStats, replyStats,
    topPairs,
  };
}
// The word cloud (top 42 cloud words) is gathered by the same stats sweep that
// tokenizes every message for the per-person word stats — one tokenizer pass.
function computeWords() { return computeStats().words || []; }
let trendChart = null;
// the months/hours/weekdays Chart.js instances of the current Stats
// render. Tracked (like trendChart) so renderStats()/resetDerived() can
// destroy them before their canvases are detached.
let statCharts = [];
// every Stats chart wears the LIVE theme — tick labels and
// grid lines from --text-dim / --border, datasets from the accent (never a
// fixed colour). Applied to a config before a chart is built, and re-applied to
// the open charts by refreshChartTheme() on every theme / accent change.
function chartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const accent = sanitizeColor(settings.accent) || DEFAULTS.accent;
  return {
    text: cs.getPropertyValue("--text-dim").trim() || "rgba(255,255,255,0.6)",
    grid: cs.getPropertyValue("--border").trim() || "rgba(255,255,255,0.1)",
    accent, soft: hexA(accent, 0.2),
    // tooltips sit on the accent fill with the luminance-derived text
    fill: cs.getPropertyValue("--accent-fill").trim() || accent,
    onAccent: cs.getPropertyValue("--on-accent").trim() || "#ffffff",
  };
}
// Explicit x / y axes so a later re-theme has objects to recolour.
function chartAxes() {
  return { x: { ticks: {}, grid: {}, border: {} }, y: { beginAtZero: true, ticks: {}, grid: {}, border: {} } };
}
// Colour one chart (a live Chart or its config — both carry data + options):
// bars are solid accent, lines an accent stroke over a soft accent fill.
function paintChart(type, data, options, th) {
  const sc = options.scales || {};
  Object.keys(sc).forEach((k) => {
    if (sc[k].ticks) sc[k].ticks.color = th.text;
    if (sc[k].grid) sc[k].grid.color = th.grid;
    if (sc[k].border) sc[k].border.color = th.grid;
  });
  const lg = options.plugins && options.plugins.legend;
  if (lg && lg.labels) lg.labels.color = th.text;
  if (!options.plugins) options.plugins = {};
  if (!options.plugins.tooltip) options.plugins.tooltip = {};
  const tt = options.plugins.tooltip;
  tt.backgroundColor = th.fill; tt.titleColor = th.onAccent; tt.bodyColor = th.onAccent;
  data.datasets.forEach((ds) => {
    if (type === "bar") ds.backgroundColor = th.accent;
    else { ds.borderColor = th.accent; ds.backgroundColor = th.soft; }
  });
}
function makeChart(canvas, cfg) {
  paintChart(cfg.type, cfg.data, cfg.options, chartTheme());
  return new Chart(canvas.getContext("2d"), cfg);
}
function refreshChartTheme() {
  if (!window.Chart) return;
  const th = chartTheme();
  Chart.defaults.color = th.text;
  Chart.defaults.borderColor = th.grid;
  statCharts.concat(trendChart ? [trendChart] : []).forEach((c) => {
    try { paintChart(c.config.type, c.data, c.options, th); c.update("none"); } catch (e) { /* detached canvas */ }
  });
}
// Whole-word uses of `word` (or phrase) per zoned month — the same token
// definition as the word cloud and Word Battles, never a substring.
function computeKeywordTrend(word) {
  const keys = wordKeys(word);
  const monthCounts = {};
  timeAgg().monthArr.forEach(m => monthCounts[m[0]] = 0);
  if (!keys.length) return Object.entries(monthCounts);
  // Prefilter on the longest key: most messages can't contain it at all.
  const probe = keys.reduce((a, b) => (b.length > a.length ? b : a));
  // Same zoned "YYYY-MM" keys as timeAgg().monthArr so the trend chart aligns.
  const TI = timeIndex(), hits = new Map();
  for (let i = 0; i < N; i++) {
    if (!mayContainKey(LOWER[i], probe)) continue;
    const c = countKeys(MSGS[i].x, keys);
    if (c) hits.set(TI.monthKey[i], (hits.get(TI.monthKey[i]) || 0) + c);
  }
  for (const [mk, c] of hits) {
    const ym = monthKeyStr(mk);
    monthCounts[ym] = (monthCounts[ym] || 0) + c;
  }
  return Object.entries(monthCounts).sort((a,b) => a[0] < b[0] ? -1 : 1);
}

function updateTrendChart(word) {
  if (!word.trim()) return;
  trendWord = word.trim();
  const trendData = computeKeywordTrend(word);
  const labels = trendData.map(m => m[0]);
  const data = trendData.map(m => m[1]);
  
  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = data;
    trendChart.data.datasets[0].label = '"' + word + '" frequency';
    trendChart.update();
  } else if (window.Chart) {
    const ctx = document.getElementById("chart-trends");
    if (!ctx) return;
    trendChart = makeChart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{ label: '"' + word + '" frequency', data: data, fill: true, tension: 0.4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, labels: {} } }, scales: chartAxes() }
    });
  }
  const cv = document.getElementById("chart-trends");
  if (cv) cv.setAttribute("aria-label", "Line chart: monthly uses of “" + trendWord + "”");
}

let MILES = null;
function computeMilestones() {
  if (MILES) return MILES;
  // Same empty-conversation guard as computeStats() — MSGS[N-1]/MSGS[0] would throw.
  if (!N) return (MILES = { empty: true });
  // "Total words sent" is NOT computed here: it is the shared tokenizer's
  // count, gathered by the deferred stats sweep with every other word
  // stat, and filled into its milestone card in stage 2.
  let totalReacts = 0;
  for (let i = 0; i < N; i++) { const r = MSGS[i].r; if (r) totalReacts += r.length; }
  // Day / hour tallies come from the zoned time index aggregate: dayCounts is
  // indexed by zoned day number, so "consecutive days" is just adjacent slots
  // (exact and DST-proof), and the busiest day is the earliest maximum.
  const agg = timeAgg();
  const hourCount = agg.hourCount;
  const keyLabel = (fmt, k) => fmt.format(dayKeyBoundInstant(k));
  const busiestDay = agg.busy[0], busiestCount = agg.busy[1];
  // Longest streak of consecutive active days (first longest wins).
  let streak = 0, best = 0, bestEnd = -1;
  for (let k = 0; k < agg.dayCounts.length; k++) {
    if (agg.dayCounts[k]) { streak++; if (streak > best) { best = streak; bestEnd = k; } }
    else streak = 0;
  }
  const bestEndKey = bestEnd >= 0 ? dayNumKey(agg.dayMin + bestEnd) : "";
  const bestStartKey = bestEnd >= 0 ? dayNumKey(agg.dayMin + bestEnd - best + 1) : "";
  const streakRange = best > 1 ? keyLabel(dShort, bestStartKey) + " → " + keyLabel(dShort, bestEndKey) : "—";
  // Peak hour
  let peakHour = 0; for (let h = 1; h < 24; h++) if (hourCount[h] > hourCount[peakHour]) peakHour = h;
  const fmtH = (h) => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "am" : "pm");
  MILES = {
    streak: fmtNum(best) + (best === 1 ? " day" : " days"), streakDays: best, streakRange,
    busiestDay: busiestDay ? keyLabel(DAY, busiestDay) : "—", busiestCount,
    totalReacts,
    age: fmtAge(agg.dayCounts.length - 1),
    firstDay: dShort.format(MSGS[0].t),
    peakHourLabel: fmtH(peakHour), peakHourCount: hourCount[peakHour],
  };
  return MILES;
}

// Stats renders in two stages so the first paint never waits on the text
// sweep (~0.5 s of regexes at 100k messages):
//   1. synchronously — hero, milestones, per-person bars, the month / keyword-
//      trend / hour / weekday charts — all from the zoned time-index aggregate
//      (timeAgg) plus computeMilestones();
//   2. deferred — superlatives, latency & pairings, yapping, double-texting,
//      generosity, vocabulary, platforms, top emojis and the word cloud. Their
//      slots render as pulsing placeholders; the computeStats() job (which
//      also gathers the word cloud) is stepped in SLICE_MS tasks and the slots are swapped for the real
//      sections in one go, after which #view-stats gets data-ready="1".
// statsRenderSeq cancels a pending stage 2 when Stats re-renders, the
// conversation changes (resetDerived) or the view is left and re-entered.
let statsRenderSeq = 0;
// The keyword-trend word survives re-renders (tz change, revisits, other
// conversations) — it used to reset to "lol" with an empty input every time.
let trendWord = "lol";
const deferSlot = (key) => `<div class="st-pending" data-defer="${key}" aria-busy="true" aria-label="Loading"></div>`;

function renderStats() {
  const v = document.getElementById("view-stats");
  // the innerHTML writes below detach the previous render's canvases —
  // destroy their charts first or every re-render leaks three instances.
  statCharts.forEach((c) => { try { c.destroy(); } catch (e) {} });
  statCharts = [];
  const seq = ++statsRenderSeq;
  delete v.dataset.ready;
  if (!N) {
    // No messages: none at all, or every sender is ignored.
    v.innerHTML = '<div class="page"><div class="empty"><div class="big">' + cmdIco("stats") + '</div><div>' + emptyConvText() + '</div></div></div>';
    v.dataset.ready = "1";
    return;
  }
  const a = timeAgg();
  const first = MSGS[0].t, last = MSGS[N - 1].t;
  const days = Math.max(1, Math.round((last - first) / 86400000));
  const maxPP = Math.max(...PARTS.map((p) => p.count));

  // ---- Milestones (longest active streak, busiest single day, anniversary) ----
  const ms = computeMilestones();

  // ---- Hero sparkline (mock-stats .spark): monthly message volume ----------
  // monthArr is [["YYYY-MM", count], …] sorted ascending. Fewer than 2 months →
  // no trend to draw, skip the block entirely. Fixed gradient id is safe: only
  // one stats view exists per document and Chart.js paints to canvas, not SVG.
  let sparkHtml = "";
  if (a.monthArr.length >= 2) {
    const counts = a.monthArr.map((m) => m[1]);
    const max = Math.max(...counts);
    const SW = 280, SH = 96;
    const stepX = SW / (counts.length - 1);
    const pts = counts.map((c, i) =>
      (i * stepX).toFixed(1) + " " + (SH - (max > 0 ? (c / max) * 88 : 0) - 4).toFixed(1));
    const lineD = pts.map((p, i) => (i ? "L" : "M") + p).join(" ");
    const [lx, ly] = pts[pts.length - 1].split(" ");
    sparkHtml = `<div class="spark">
          <svg viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="hero-spark-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/>
                <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path d="${lineD} L${SW} ${SH} L0 ${SH} Z" fill="url(#hero-spark-grad)"/>
            <path d="${lineD}" stroke="var(--accent-soft)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${lx}" cy="${ly}" r="3.5" fill="var(--accent)" stroke="var(--bg-card)" stroke-width="1.5"/>
          </svg>
          <div class="cap">messages / month · ${zonedParts(first).y} → ${zonedParts(last).y}</div>
        </div>`;
  }

  // compute the whole-archive media count once — it's used twice below
  // (data-count + the formatted label) and is an O(N) scan over all messages.
  let mediaMsgCount = 0;
  for (let i = 0; i < N; i++) if (MSGS[i].m) mediaMsgCount++;

  // each chart canvas is role=img with a text summary of its peak.
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const peakOf = (arr) => arr.reduce((b, v, k) => (v > arr[b] ? k : b), 0);
  const pm = peakOf(a.monthArr.map((m) => m[1])), pw = peakOf(a.weekdayCount);
  const monthsLabel = a.monthArr.length
    ? "Bar chart: messages per month, " + a.monthArr[0][0] + " to " + a.monthArr[a.monthArr.length - 1][0] + "; busiest " + a.monthArr[pm][0] + " (" + plural(a.monthArr[pm][1], "message") + ")"
    : "Bar chart: messages per month";
  const hoursLabel = "Line chart: messages by hour of day; peak " + ms.peakHourLabel + " (" + plural(ms.peakHourCount, "message") + ")";
  const weekdaysLabel = "Bar chart: messages by day of week; busiest " + WEEKDAYS[pw] + " (" + plural(a.weekdayCount[pw], "message") + ")";

  let html = `<div class="page"><div class="page-head"><div class="page-title">Stats & overview</div>
    <div class="page-sub">${esc(DAY.format(first))} → ${esc(DAY.format(last))}</div></div>
    <div class="page-body">
      <div class="hero">
        <div class="h-main">
          <div class="h-eyebrow">Overview</div>
          <div class="h-num" data-count="${N}">${fmtNum(N)}</div>
          <div class="h-sub">messages · ${esc(DAY.format(first))} → ${esc(DAY.format(last))}</div>
          <div class="h-inline">
            <div class="it"><span class="v" data-count="${PARTS.length}">${PARTS.length}</span><span class="l">People</span></div>
            <div class="it"><span class="v" data-count="${a.daysActive}">${fmtNum(a.daysActive)}</span><span class="l">Active days</span></div>
            <div class="it"><span class="v" data-count="${Math.round(N / a.daysActive)}">${fmtNum(Math.round(N / a.daysActive))}</span><span class="l" title="Messages per day with at least one message">Msgs / active day</span></div>
            <div class="it"><span class="v" data-count="${mediaMsgCount}">${fmtNum(mediaMsgCount)}</span><span class="l">Media</span></div>
            <div class="it"><span class="v" data-count="${days}">${fmtNum(days)}</span><span class="l">Days span</span></div>
          </div>
        </div>
        ${sparkHtml}
      </div>

      <div class="section"><div class="section-h">Milestones</div>
      <div class="cards" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
        <div class="card mile"><div class="stat-num accent" data-count="${ms.streakDays}" data-suffix="${ms.streakDays === 1 ? " day" : " days"}">${ms.streak}</div><div class="stat-lbl">Longest daily streak</div><div class="mile-sub">${esc(ms.streakRange)}</div></div>
        <div class="card mile"><div class="stat-num" data-count="${ms.busiestCount}">${fmtNum(ms.busiestCount)}</div><div class="stat-lbl">Busiest single day</div><div class="mile-sub">${esc(ms.busiestDay)}</div></div>
        <div class="card mile" data-mile="words"><div class="stat-num">${deferSlot("words-total")}</div><div class="stat-lbl">Total words sent</div><div class="mile-sub">&nbsp;</div></div>
        <div class="card mile"><div class="stat-num" data-count="${ms.totalReacts}">${fmtNum(ms.totalReacts)}</div><div class="stat-lbl">Reactions given</div><div class="mile-sub">across the whole chat</div></div>
        <div class="card mile"><div class="stat-num">${esc(ms.age)}</div><div class="stat-lbl">Chat age</div><div class="mile-sub">since ${esc(ms.firstDay)}</div></div>
        <div class="card mile"><div class="stat-num">${esc(ms.peakHourLabel)}</div><div class="stat-lbl">Peak hour</div><div class="mile-sub">${plural(ms.peakHourCount, "message")} all-time</div></div>
      </div></div>

      <div class="section"><div class="section-h">Superlatives & Fun Stats</div>${deferSlot("supers")}</div>

      ${deferSlot("latency")}

      <div class="section"><div class="section-h">Messages per person</div><div class="bars">`;

  PARTS.forEach((p) => {
    html += `<div class="bar-row bar-clickable" data-person-id="${esc(p.id)}">
      <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(p.count / maxPP * 100).toFixed(1)}%"></div></div>
      <div class="bar-val">${fmtNum(p.count)}</div></div>`;
  });
  html += `</div></div>

      ${deferSlot("yapping")}
      ${deferSlot("generosity")}
      ${deferSlot("vocab")}

      <div class="section"><div class="section-h">Activity over time (by month) — busiest day: ${esc(a.busy[0] ? DAY.format(dayKeyBoundInstant(a.busy[0])) : "—")} (${plural(a.busy[1], "message")})</div>
      <div class="chart-container" style="position: relative; height:200px; width:100%"><canvas id="chart-months" role="img" aria-label="${esc(monthsLabel)}"></canvas></div></div>

      <div class="section">
        <div class="section-h">Keyword Trends (Google Trends Style)</div>
        <div style="display:flex; gap:10px; margin-bottom:12px;">
          <input type="text" id="trend-input" aria-label="Word to graph" placeholder="Type a word (e.g. 'lol', 'good')" class="person-name-input" style="flex:1; max-width:300px;" value="${esc(trendWord)}">
          <button class="btn" id="trend-btn">Graph</button>
        </div>
        <div class="chart-container" style="position: relative; height:200px; width:100%"><canvas id="chart-trends" role="img" aria-label="Line chart: monthly uses of a word"></canvas></div>
      </div>

      <div class="section stat-grid2">
        <div>
          <div class="section-h">Activity by time of day</div>
          <div class="chart-container" style="position: relative; height:150px; width:100%"><canvas id="chart-hours" role="img" aria-label="${esc(hoursLabel)}"></canvas></div>
        </div>
        <div>
          <div class="section-h">Activity by Day of Week</div>
          <div class="chart-container" style="position: relative; height:150px; width:100%"><canvas id="chart-weekdays" role="img" aria-label="${esc(weekdaysLabel)}"></canvas></div>
        </div>
      </div>

      <div class="section"><div class="section-h">Top Emojis</div><div class="words" id="top-emojis">${deferSlot("emojis")}</div></div>

      <div class="section"><div class="section-h">Most-used words — click to search</div><div class="words cloud" id="words">${deferSlot("words")}</div></div>
    </div></div>`;
  v.innerHTML = html;

  // Clickable person bars → filter search by person
  v.querySelectorAll(".bar-clickable").forEach(row => {
    row.style.cursor = "pointer";
    asButton(row, () => {
      const pid = row.dataset.personId;
      if (pid) {
        setView("search");
        clearAllFilters();
        F.people.add(pid);
        updatePeopleBadge();
        runSearch();
      }
    }, "Search messages from " + nameOf(row.dataset.personId));
  });

  if (window.Chart) {
    // Theme-aware ticks / grid / accent: refreshChartTheme() keeps the
    // defaults and every open chart in step with later theme / accent changes.
    refreshChartTheme();
    const opts = () => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: chartAxes() });
    statCharts.push(makeChart(document.getElementById("chart-months"), {
      type: 'bar',
      data: {
        labels: a.monthArr.map(m => m[0]),
        datasets: [{ label: 'Messages', data: a.monthArr.map(m => m[1]), borderRadius: 4 }]
      },
      options: opts()
    }));
    statCharts.push(makeChart(document.getElementById("chart-hours"), {
      type: 'line',
      data: {
        labels: Array.from({length: 24}, (_, i) => i + ":00"),
        datasets: [{ label: 'Messages', data: a.hourCount.slice(), fill: true, tension: 0.4 }]
      },
      options: opts()
    }));
    statCharts.push(makeChart(document.getElementById("chart-weekdays"), {
      type: 'bar',
      data: {
        labels: WEEKDAYS,
        datasets: [{ label: 'Messages', data: a.weekdayCount.slice(), borderRadius: 4 }]
      },
      options: opts()
    }));
  }

  const tInput = v.querySelector("#trend-input");
  const tBtn = v.querySelector("#trend-btn");
  if (tInput && tBtn) {
    tBtn.onclick = () => updateTrendChart(tInput.value);
    tInput.onkeydown = (e) => { if (e.key === "Enter") updateTrendChart(tInput.value); };
    // Destroy any prior Chart.js instance so re-rendering stats (same
    // conversation) can't leak a detached chart bound to the old canvas.
    if (trendChart) { try { trendChart.destroy(); } catch (e) {} }
    trendChart = null;
    updateTrendChart(trendWord);
  }

  animateCounts(v); // count-up the hero + milestone numbers (mock-stats liveliness)
  scheduleStatsStage2(v, seq);
}

// Stage 2 driver: step the stats / words jobs in SLICE_MS tasks, then fill the
// deferred slots. Starts after the first paint (rAF → task) when the page is
// visible; a hidden page never runs rAF, so it goes straight to a task.
function scheduleStatsStage2(v, seq) {
  const live = () => seq === statsRenderSeq && v.isConnected;
  const tick = () => {
    if (!live()) return;
    if (!STATS && !runJob(statsJobFor(), SLICE_MS)) { setTimeout(tick, 0); return; }
    fillStatsDeferred(v, computeStats(), computeWords());
    v.dataset.ready = "1";
  };
  if (document.hidden) setTimeout(tick, 0);
  else requestAnimationFrame(() => setTimeout(tick, 0));
}

function fillStatsDeferred(v, s, cloudWords) {
  const slot = (key, markup) => {
    const node = v.querySelector('.st-pending[data-defer="' + key + '"]');
    if (node) node.outerHTML = markup;
  };
  const panel = 'background:var(--bg-panel); border:1px solid var(--border); border-radius:var(--radius-card); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;';
  const av = (id) => pfpHtml(id, "width:22px;height:22px;font-size:10px");
  // a panel with no rows is not drawn (it used to be an empty bordered
  // box); a two-panel row collapses to one column, or vanishes when both are
  // empty.
  const panels = (list) => {
    const shown = list.filter((p) => p.rows);
    if (!shown.length) return "";
    return `<div class="section stat-grid2">` +
      shown.map((p) => `<div data-panel="${p.key}"><div class="section-h">${p.title}</div>${p.extra || ""}<div class="bars" style="${p.style || panel}">${p.rows}</div></div>`).join("") +
      "</div>";
  };

  // ---- Superlatives -----------------------------------------------------------
  // One card per award in STATS.awards (already filtered: shown winners only).
  // A tie names every winner; the definition line says what was measured.
  const DEF = {}; SUPERLATIVES.forEach((d) => { DEF[d.key] = d; });
  const tieNames = (ids) => ids.map((id) => esc(nameOf(id))).join(", ");
  const cards = s.awards.map((a) => {
          const d = DEF[a.key], lead = a.ids[0];
          const def = d.key === "scholar" ? d.def.replace("first N words", "first " + fmtNum(s.scholarW) + " words") : d.def;
          return `
          <div class="card super" data-award="${esc(a.key)}" data-winners="${esc(a.ids.join(" "))}" style="--p:${esc(personColor(lead).p)}">
            ${pfpHtml(lead, "width:40px;height:40px;font-size:16px")}
            <div class="s-body">
              <div class="s-name">${esc(nameOf(lead))}</div>
              ${a.ids.length > 1 ? '<div class="s-tie">tied with ' + tieNames(a.ids.slice(1)) + "</div>" : ""}
              <div class="s-title">${esc(d.title)}</div>
              <div class="s-stat">${esc(a.stat)}</div>
              <div class="s-def">${esc(def)}</div>
            </div>
          </div>`;
  }).join("");
  slot("supers", cards
    ? '<div class="cards" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">' + cards + "</div>"
    : '<div class="pop-empty">Not enough messages yet for any awards — each needs at least two people to compare.</div>');

  // ---- Latency + pairings -----------------------------------------------------
  let latencyRows = "";
  PARTS.forEach(p => {
    const stat = s.replyStats[p.id];
    if (stat) {
      latencyRows += `<div class="bar-row">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div class="bar-val" style="text-align:left; color:var(--text); font-weight:600;">${fmtDur(stat.median)}</div>
        <div class="bar-val" style="font-size:11px;color:var(--text-faint);">${plural(stat.count, "reply", "replies")}</div>
      </div>`;
    }
  });
  let pairRows = "";
  s.topPairs.forEach(pair => {
    pairRows += `<div class="bar-row" style="grid-template-columns: 1fr auto;">
      <div class="bar-name">
        ${av(pair.fromId)}
        <span style="color:var(--text-dim); margin:0 4px;">→</span>
        ${av(pair.toId)}
        <span style="margin-left:8px; font-weight:500;">${esc(nameOf(pair.toId))} replied to ${esc(nameOf(pair.fromId))}</span>
      </div>
      <div class="bar-val" style="font-weight:600;color:var(--accent-text);">${plural(pair.count, "time")}</div>
    </div>`;
  });
  slot("latency", `<div class="section stat-grid2">
        <div>
          <div class="section-h">Typical Reply Time (median, answers within 12 h)</div>
          <div class="bars" style="${panel}">
            ${latencyRows || '<div class="pop-empty">No response latency data yet.</div>'}
          </div>
        </div>
        <div>
          <div class="section-h">Top Interaction Pairings (answers within 30 min)</div>
          <div class="bars" style="${panel}">
            ${pairRows || '<div class="pop-empty">No pairing data yet.</div>'}
          </div>
        </div>
      </div>`);

  // ---- Yapping index + double texting ----------------------------------------
  let yapRows = "";
  const maxYap = Math.max(1, ...PARTS.map(p => s.yapperStats[p.id] || 0));
  PARTS.forEach(p => {
    const yap = s.yapperStats[p.id] || 0;
    if (yap > 0) {
      yapRows += `<div class="bar-row">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(yap / maxYap * 100).toFixed(1)}%; background:var(--accent)"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${yap.toFixed(1)}</div>
      </div>`;
    }
  });
  let dtRows = "";
  const maxDT = Math.max(1, ...PARTS.map(p => s.doubleTextStats[p.id] || 0));
  PARTS.forEach(p => {
    const dt = s.doubleTextStats[p.id] || 0;
    if (dt > 0) {
      dtRows += `<div class="bar-row">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(dt / maxDT * 100).toFixed(1)}%; background:var(--accent-2)"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${fmtNum(dt)}</div>
      </div>`;
    }
  });
  slot("yapping", panels([
    { key: "yapping", title: "The Yapping Index (average words per message)", rows: yapRows },
    { key: "double-text", title: "Double Texting Leaderboard (back-to-back messages within 1 h)", rows: dtRows },
  ]));

  // ---- Reaction generosity ----------------------------------------------------
  let genRows = "";
  const maxReactTotal = Math.max(1, ...PARTS.map(p => (s.reactionGenerosity[p.id]?.given || 0) + (s.reactionGenerosity[p.id]?.received || 0)));
  PARTS.forEach(p => {
    const r = s.reactionGenerosity[p.id] || { given: 0, received: 0 };
    if (r.given > 0 || r.received > 0) {
      genRows += `<div class="bar-row" style="align-items:center;">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div style="flex:1; display:flex; gap:4px; font-size:11px; align-items:center;">
          <div style="width:${(r.given / maxReactTotal * 100).toFixed(1)}%; background:var(--accent); height:8px; border-radius:4px;" title="Given: ${fmtNum(r.given)}"></div>
          <span style="color:var(--accent-text); font-weight:600; width:30px">${fmtNum(r.given)}</span>
          <div style="width:${(r.received / maxReactTotal * 100).toFixed(1)}%; background:var(--success); height:8px; border-radius:4px;" title="Received: ${fmtNum(r.received)}"></div>
          <span style="color:var(--success-text); font-weight:600; width:30px">${fmtNum(r.received)}</span>
        </div>
      </div>`;
    }
  });
  slot("generosity", panels([
    { key: "generosity", title: "Reaction Generosity (given vs. received)", rows: genRows,
      style: "background:var(--bg-panel); border:1px solid var(--border); border-radius:var(--radius-card); padding:16px; display:flex; flex-direction:column; gap:12px;" },
  ]));

  // ---- Vocabulary + platform links -------------------------------------------
  let vocabRows = "";
  const maxVocab = Math.max(1, ...PARTS.map(p => s.vocabStats[p.id] || 0));
  PARTS.forEach(p => {
    const vcb = s.vocabStats[p.id] || 0;
    if (vcb > 0) {
      vocabRows += `<div class="bar-row">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(vcb / maxVocab * 100).toFixed(1)}%; background:var(--accent)"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${fmtNum(vcb)}</div>
      </div>`;
    }
  });
  let platRows = "";
  const maxPlat = Math.max(1, ...PARTS.map(p => {
    const pt = s.platformStats[p.id];
    return pt ? pt.tt + pt.yt + pt.tw + pt.ig : 0;
  }));
  PARTS.forEach(p => {
    const pt = s.platformStats[p.id] || {tt:0, yt:0, tw:0, ig:0};
    const total = pt.tt + pt.yt + pt.tw + pt.ig;
    if (total > 0) {
      platRows += `<div class="bar-row" style="align-items:center;">
        <div class="bar-name">${av(p.id)}${esc(nameOf(p.id))}</div>
        <div style="flex:1; display:flex; font-size:11px; align-items:center; height:12px;">
          ${pt.tt ? `<div style="width:${(pt.tt/maxPlat*100).toFixed(1)}%; height:100%;" class="plat plat-tt" title="TikTok: ${pt.tt}"></div>` : ''}
          ${pt.yt ? `<div style="width:${(pt.yt/maxPlat*100).toFixed(1)}%; height:100%;" class="plat plat-yt" title="YouTube: ${pt.yt}"></div>` : ''}
          ${pt.tw ? `<div style="width:${(pt.tw/maxPlat*100).toFixed(1)}%; height:100%;" class="plat plat-tw" title="Twitter: ${pt.tw}"></div>` : ''}
          ${pt.ig ? `<div style="width:${(pt.ig/maxPlat*100).toFixed(1)}%; height:100%;" class="plat plat-ig" title="Insta: ${pt.ig}"></div>` : ''}
        </div>
        <div class="bar-val" style="width:30px; text-align:right;">${fmtNum(total)}</div>
      </div>`;
    }
  });
  slot("vocab", panels([
    { key: "vocab", title: "Vocabulary Size (distinct words)", rows: vocabRows },
    { key: "platforms", title: "Platform Links Shared", rows: platRows,
      extra: '<div class="plat-legend"><span><i class="plat plat-tt"></i>TikTok</span><span><i class="plat plat-yt"></i>YouTube</span><span><i class="plat plat-tw"></i>X / Twitter</span><span><i class="plat plat-ig"></i>Instagram</span></div>' },
  ]));

  // ---- Total words milestone (shared tokenizer count) -------------------------
  const wm = v.querySelector('.mile[data-mile="words"]');
  if (wm) {
    slot("words-total", fmtNum(s.totalWords));
    wm.querySelector(".stat-num").dataset.count = String(s.totalWords);
    wm.querySelector(".mile-sub").textContent = "≈ " + plural(Math.round(s.totalWords / 250), "paperback page");
  }

  // ---- Top emojis + word cloud ------------------------------------------------
  const emc = v.querySelector("#top-emojis");
  if (emc) {
    emc.textContent = "";
    s.emojis.forEach(([e, c]) => emc.appendChild(el("div", "word", e + "<b>" + fmtNum(c) + "</b>")));
  }
  const wc = v.querySelector("#words");
  if (wc) {
    wc.textContent = "";
    if (cloudWords.length) {
      const counts = cloudWords.map((x) => x[1]);
      const cmin = Math.min(...counts), cmax = Math.max(...counts);
      const span = Math.max(1, cmax - cmin);
      cloudWords.forEach(([w, c]) => {
        const t = (c - cmin) / span;                 // 0..1
        const size = (13 + t * 23).toFixed(1);       // 13px → 36px
        // Frequency is shown by size and by a dim → full text-colour ramp. Both
        // ends are ≥ 4.5:1, so rarer words never fade below the AA line
        // (opacity used to drop them to ~2.5:1).
        const ink = Math.round(t * 100);
        const chip = btnEl("word cloud-word", esc(w) + "<b>" + fmtNum(c) + "</b>", "Search “" + w + "” — " + fmtNum(c) + " uses");
        chip.style.fontSize = size + "px";
        chip.style.color = "color-mix(in srgb, var(--text) " + ink + "%, var(--text-dim))";
        chip.title = fmtNum(c) + " uses — click to search";
        chip.onclick = () => { setView("search"); clearAllFilters(); sEls.input.value = w; sEls.clear.hidden = false; runSearch(); };
        wc.appendChild(chip);
      });
    }
  }
}

/* ===========================================================================
   PEOPLE VIEW
   ======================================================================== */
function renderPeople() {
  const v = document.getElementById("view-people");
  v.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">People</div>
    <div class="page-sub">The export only has numeric IDs. Give each person a name &amp; color — recognize them from their message counts and sample messages below. Mark yourself with “This is me” to right-align your messages.</div></div>
    <div class="page-body" id="people-body"></div></div>`;
  const body = v.querySelector("#people-body");
  PARTS.forEach((p) => body.appendChild(personCard(p)));
}
function personCard(p) {
  const card = el("div", "person");

  // Avatar + "change photo" uploader. Uploads are stored as data URLs in
  // settings.pfps (localStorage), so editing works from file:// with no server.
  const avWrap = el("div", "person-avwrap");
  const av = el("div", "av"); applyPfp(av, p.id);
  const file = document.createElement("input");
  file.type = "file"; file.accept = "image/*"; file.className = "pfp-file";
  file.setAttribute("aria-label", (PFPS[p.id] ? "Change" : "Add") + " photo for " + nameOf(p.id));
  const pick = el("button", "btn sm ghost pfp-pick", PFPS[p.id] ? "Change photo" : "Add photo");
  pick.onclick = () => file.click();
  file.addEventListener("change", () => {
    const f = file.files && file.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      settings.pfps[p.id] = url; PFPS[p.id] = url;
      // If the photo can't be saved (over quota), roll back so state matches
      // storage; savePfps() has already warned the user.
      if (!savePfps()) { delete settings.pfps[p.id]; delete PFPS[p.id]; }
      renderPeople();
      if (typeof updateBrand === "function") updateBrand();
    };
    reader.readAsDataURL(f);
  });
  avWrap.appendChild(av); avWrap.appendChild(pick); avWrap.appendChild(file);
  if (PFPS[p.id]) {
    const rm = el("button", "btn sm ghost pfp-rm", "Remove");
    rm.onclick = () => { delete settings.pfps[p.id]; delete PFPS[p.id]; savePfps(); renderPeople(); updateBrand(); };
    avWrap.appendChild(rm);
  }
  card.appendChild(avWrap);

  const main = el("div", "person-main");
  const row = el("div", "person-row");
  const input = el("input", "person-name-input");
  input.type = "text"; input.value = settings.names[p.id] || ""; input.placeholder = GENERIC[p.id] || nameOf(p.id);
  input.setAttribute("aria-label", "Display name for " + (GENERIC[p.id] || p.id));
  input.addEventListener("input", () => {
    const val = input.value.trim();
    if (val) settings.names[p.id] = val; else delete settings.names[p.id];
    saveSettings();
    resetGallery();   // its cells name the sender
    if (!PFPS[p.id]) av.textContent = initials(nameOf(p.id));
  });
  row.appendChild(input);
  main.appendChild(row);

  const span = p.count
    ? plural(p.count, "message") + " · " + DT.format(p.first).split(",")[0] + ", " + zonedParts(p.first).y +
      " → " + DT.format(p.last).split(",")[0] + ", " + zonedParts(p.last).y
    : "Never posted — on the member list, reacting or in a join / leave event only";
  main.appendChild(el("div", "person-meta", esc(span) + ' &nbsp; <span class="person-id">id ' + esc(p.id) + "</span>"));

  if (p.samples.length) {
    const sw = el("div", "samples");
    p.samples.forEach((s) => { const d = el("div", "sample", esc(s)); d.dir = "auto"; sw.appendChild(d); });
    main.appendChild(sw);
  }

  // A few media this person shared — extra memory jogs for naming them.
  if (p.media && p.media.length) {
    const mw = el("div", "person-media");
    p.media.forEach((it) => {
      if (it.k === "vid") {
        const v = el("video", "person-media-thumb"); v.src = safeHref(it.m); v.muted = true; v.preload = "metadata";
        mw.appendChild(v);
      } else {
        const img = el("img", "person-media-thumb"); img.src = safeHref(it.m); img.loading = "lazy"; img.alt = "";
        mw.appendChild(img);
      }
    });
    main.appendChild(mw);
  }

  card.appendChild(main);

  const side = el("div", "person-side");
  const me = el("label", "me-toggle");
  const radio = document.createElement("input"); radio.type = "checkbox"; radio.checked = settings.me === p.id;
  radio.addEventListener("change", () => { settings.me = radio.checked ? p.id : (settings.me === p.id ? null : settings.me); saveSettings(); renderPeople(); });
  me.appendChild(radio); me.appendChild(document.createTextNode("This is me"));
  side.appendChild(me);

  const sws = el("div", "swatches");
  const override = sanitizeColor(settings.colors[p.id]);
  const auto = btnEl("swatch swatch-auto" + (override ? "" : " sel"), "A", "Automatic colour", !override);
  auto.title = "Automatic colour";
  auto.style.setProperty("--p", autoColor(p.id).p);   // the hash hue, not the override
  auto.onclick = () => { delete settings.colors[p.id]; saveSettings(); renderPeople(); };
  sws.appendChild(auto);
  PALETTE.forEach((col) => {
    const on = !!override && override.toLowerCase() === col.toLowerCase();
    const sw = btnEl("swatch" + (on ? " sel" : ""), "", "Colour " + col, on); sw.style.background = col; sw.style.color = col;
    sw.onclick = () => { settings.colors[p.id] = col; saveSettings(); renderPeople(); };
    sws.appendChild(sw);
  });
  side.appendChild(sws);
  card.appendChild(side);
  return card;
}

/* ===========================================================================
   SETTINGS VIEW
   ======================================================================== */
// Merge the wizard's local.js identity (per-conversation LOCAL_GC) with the
// in-app settings.gc into one { convId: { name, photo } } map for export.
function effectiveGcExport() {
  const out = {};
  if (LOCAL_GC && typeof LOCAL_GC === "object" && !("name" in LOCAL_GC) && !("photo" in LOCAL_GC)) {
    for (const id of Object.keys(LOCAL_GC)) {
      const e = LOCAL_GC[id] || {};
      out[id] = { name: e.name || "", photo: e.photo || "" };
    }
  }
  for (const id of Object.keys(settings.gc || {})) {
    const e = settings.gc[id] || {};
    const base = out[id] || { name: "", photo: "" };
    out[id] = { name: e.name || base.name || "", photo: e.photo || base.photo || "" };
  }
  return out;
}

// Build the portable identity+preferences object. Folds the wizard's LOCAL_*
// (names/pfps/me/gc/ignored) into the settings so an exported file carries every
// wizard-assigned name and photo — a recipient imports it and needs no setup.
function buildExportPayload() {
  return Object.assign({}, settings, {
    version: 2,
    names: Object.assign({}, LOCAL_NAMES, settings.names),
    pfps: Object.assign({}, (typeof window !== "undefined" && window.LOCAL_PFPS) || {}, settings.pfps),
    me: settings.me || LOCAL_ME || null,
    gc: effectiveGcExport(),
    ignoredUsers: [...ignoredUserIds()],
    ignoredGroups: [...ignoredGroupIds()],
  });
}

function renderSettings() {
  const v = document.getElementById("view-settings");
  v.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">Settings</div>
    <div class="page-sub">All preferences are saved in this browser.</div></div>
    <div class="page-body">

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Accent color</div><div class="set-desc">Pick a preset shade or a custom color.</div></div>
          <div class="set-control"><div class="preset-swatches" id="set-accents"></div><input type="color" id="set-accent-custom" aria-label="Custom accent color" value="${esc(shade(sanitizeColor(settings.accent) || DEFAULTS.accent, 0))}"><button class="btn ghost sm" id="set-shuffle" title="Surprise me">${cmdIco("random")} Shuffle</button></div></div>
        <div class="set-row"><div><div class="set-label">Theme</div><div class="set-desc">X's Light, Dim, or Lights out.</div></div>
          <div class="set-control"><div class="seg" id="set-theme">
            <button data-v="light">Light</button><button data-v="dim">Dim</button><button data-v="lightsout">Lights out</button>
          </div></div></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Font size</div><div class="set-desc">${settings.fontSize}px</div></div>
          <div class="set-control"><input type="range" id="set-font" aria-label="Font size" min="13" max="19" step="1" value="${settings.fontSize}"></div></div>
        <div class="set-row"><div><div class="set-label">Density</div><div class="set-desc">Spacing between messages.</div></div>
          <div class="set-control"><div class="seg" id="set-density">
            <button data-v="comfortable">Comfortable</button><button data-v="compact">Compact</button>
          </div></div></div>
        <div class="set-row"><div><div class="set-label">Show avatars</div></div>
          <div class="set-control"><label class="switch"><input type="checkbox" id="set-av" ${settings.avatars ? "checked" : ""}><span class="track"></span></label></div></div>
        <div class="set-row"><div><div class="set-label">Show timestamps</div></div>
          <div class="set-control"><label class="switch"><input type="checkbox" id="set-ts" ${settings.timestamps ? "checked" : ""}><span class="track"></span></label></div></div>
        <div class="set-row"><div><div class="set-label">Timezone</div><div class="set-desc">How timestamps, days and every stats bucket are dated. Defaults to this browser's zone.</div></div>
          <div class="set-control tz-pick">
            <input type="search" id="set-tz-filter" class="person-name-input" placeholder="Filter zones (e.g. Tokyo)" aria-label="Filter timezones" autocomplete="off" spellcheck="false">
            <select id="set-tz" aria-label="Timezone"></select>
          </div></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Group chats</div><div class="set-desc">Rename a group or change its sidebar photo — saved in this browser.</div></div></div>
        <div class="gc-list" id="set-gcs"></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Saved searches</div><div class="set-desc">Created from the Search tab.</div></div></div>
        <div class="saved-list" id="set-saved"></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Reset customization</div><div class="set-desc">Resets appearance (theme, accent, font size, density, avatars, timestamps), people &amp; group names, colors and saved searches. Keeps bookmarks, “this is me”, hidden people &amp; groups, timezone and photos.</div></div>
          <div class="set-control"><button class="btn ghost" id="set-reset">Reset…</button></div></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Export settings</div><div class="set-desc">Download your names, colors, themes and saved searches.</div></div>
          <div class="set-control"><button class="btn ghost" id="set-export">Export JSON</button></div></div>
        <div class="set-row"><div><div class="set-label">Import settings</div><div class="set-desc">Restore settings from a previously saved JSON file.</div></div>
          <div class="set-control">
            <input type="file" id="set-import-file" accept=".json" aria-label="Import settings JSON file" style="display:none;">
            <button class="btn ghost" id="set-import">Import JSON</button>
          </div></div>
      </div>

    </div></div>`;

  // accents
  const ac = v.querySelector("#set-accents");
  ACCENTS.forEach((col) => {
    const on = settings.accent.toLowerCase() === col.toLowerCase();
    const p = btnEl("preset" + (on ? " sel" : ""), "", "Accent " + col, on); p.style.background = col;
    p.onclick = () => { settings.accent = col; saveSettings(); applyTheme(); renderSettings(); };
    ac.appendChild(p);
  });
  v.querySelector("#set-accent-custom").oninput = (e) => { settings.accent = e.target.value; saveSettings(); applyTheme(); };
  v.querySelector("#set-shuffle").onclick = () => shuffleTheme();

  segWire(v.querySelector("#set-theme"), getTheme(), (val) => setTheme(val));
  segWire(v.querySelector("#set-density"), settings.density, (val) => { settings.density = val; saveSettings(); applyTheme(); });

  const font = v.querySelector("#set-font");
  font.oninput = () => { settings.fontSize = +font.value; font.closest(".set-row").querySelector(".set-desc").textContent = settings.fontSize + "px"; saveSettings(); applyTheme(); };
  v.querySelector("#set-av").onchange = (e) => { settings.avatars = e.target.checked; saveSettings(); applyTheme(); };
  v.querySelector("#set-ts").onchange = (e) => { settings.timestamps = e.target.checked; saveSettings(); applyTheme(); };
  const tzSel = v.querySelector("#set-tz"), tzFilter = v.querySelector("#set-tz-filter");
  fillTzOptions(tzSel, "");
  tzFilter.oninput = () => fillTzOptions(tzSel, tzFilter.value);
  tzSel.onchange = (e) => {
    // Any pick — UTC included — is an explicit choice.
    settings.timezone = e.target.value; settings.tzExplicit = true; saveSettings(); initDateFormatters();
    // Every zone-dependent derived cache must be dropped: stats, word/keyword
    // months, milestones, Hall of Fame years, threads, and each Wrapped year.
    STATS = null; MILES = null; HOF = null; threadsCache = null;
    for (const k in wrappedCache) delete wrappedCache[k];
    cancelStatsRender();   // a pending stage 2 would fill old-zone DOM with new-zone numbers
    // already-rendered Search results / Timeline rows carry old-zone
    // labels, and the From/To bounds were computed for the old zone. Recompute
    // the bounds from the picked dates and re-run the search.
    syncDateBounds();
    if (searchBuilt) runSearch();
    // The timeline rebuilds on its next visit, reopening on the message that
    // was first in view when the user left it (recorded by setView).
    invalidateTimeline();
    resetGallery();   // its cells carry dates
    updateBrand();   // the sidebar year range is zone-dependent too
    buildSidebarSparkline();
    toast("Timezone updated");
  };

  const gcl = v.querySelector("#set-gcs");
  visibleConvos().forEach((c) => {
    const entry = (settings.gc && settings.gc[c.id]) || {};
    const lgc = localGcFor(c);
    const effPhoto = sanitizePhoto(entry.photo || (lgc && lgc.photo) || settings.gcPhoto || "");
    const row = el("div", "gc-item");
    const av = el("div", "gc-av");
    if (effPhoto) av.style.backgroundImage = `url('${effPhoto}')`; else av.innerHTML = cmdIco("bubble");
    const mid = el("div", "gc-mid");
    const name = document.createElement("input");
    name.type = "text"; name.className = "gc-name-input";
    name.placeholder = convLabel(c); name.value = entry.name || "";
    name.setAttribute("aria-label", "Display name for " + convLabel(c));
    name.oninput = () => {
      if (!settings.gc[c.id]) settings.gc[c.id] = {};
      const val = name.value.trim();
      if (val) settings.gc[c.id].name = val; else delete settings.gc[c.id].name;
      saveGc();
      renderConvPicker();   // both pickers carry the name
      if (CONV && c.id === CONV.id) updateBrand();
    };
    mid.appendChild(name);
    mid.appendChild(el("div", "gc-item-meta", esc(convLabel(c)) + " · " + fmtNum(c.count) + " messages"));
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.style.display = "none";
    file.setAttribute("aria-label", (effPhoto ? "Change" : "Add") + " photo for " + convLabel(c));
    const pick = el("button", "btn sm ghost", effPhoto ? "Change photo" : "Add photo");
    pick.onclick = () => file.click();
    file.addEventListener("change", () => {
      const f = file.files && file.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (!settings.gc[c.id]) settings.gc[c.id] = {};
        settings.gc[c.id].photo = reader.result;
        if (!saveGc()) delete settings.gc[c.id].photo;
        else if (CONV && c.id === CONV.id) updateBrand();
        renderSettings();
      };
      reader.readAsDataURL(f);
    });
    row.appendChild(av); row.appendChild(mid); row.appendChild(pick); row.appendChild(file);
    if (entry.photo) {
      const rm = el("button", "btn sm ghost", "Remove");
      rm.onclick = () => { delete settings.gc[c.id].photo; saveGc(); if (CONV && c.id === CONV.id) updateBrand(); renderSettings(); };
      row.appendChild(rm);
    }
    gcl.appendChild(row);
  });

  const sl = v.querySelector("#set-saved");
  if (!settings.saved.length) sl.appendChild(el("div", "pop-empty", "No saved searches yet."));
  settings.saved.forEach((s, idx) => {
    const item = el("div", "saved-item");
    item.innerHTML = `<span class="s-name">★ ${esc(s.name)}</span><span class="s-q">${esc(s.q || "(filters only)")}</span>`;
    const run = el("button", "btn sm ghost", "Run"); run.onclick = () => { setView("search"); applySaved(s); };
    const del = btnEl("icon-btn", cmdIco("trash"), "Delete saved search " + s.name); del.title = "Delete";
    del.onclick = () => { settings.saved.splice(idx, 1); saveSettings(); renderSettings(); };
    item.appendChild(run); item.appendChild(del); sl.appendChild(item);
  });

  v.querySelector("#set-reset").onclick = () => {
    if (!confirm(RESET_CONFIRM)) return;
    resetCustomization();
    toast("Customization reset");
  };

  v.querySelector("#set-export").onclick = () => {
    const data = JSON.stringify(buildExportPayload(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gca-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Settings exported");
  };

  const importFile = v.querySelector("#set-import-file");
  v.querySelector("#set-import").onclick = () => importFile.click();
  importFile.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let imported;
      try { imported = JSON.parse(ev.target.result); }
      catch (err) { toast("Error parsing settings file"); importFile.value = ""; return; }
      if (!(isPlainObj(imported) && (imported.names || imported.colors || imported.accent || imported.gc))) {
        toast("Invalid settings file"); importFile.value = ""; return;
      }
      // This replaces customizations with no undo, so confirm first — naming
      // exactly what this file replaces and what it keeps.
      if (!confirm(importConfirmText(imported))) {
        importFile.value = "";
        return;
      }
      // validate BEFORE anything is saved or applied — a crafted
      // colour or photo is dropped and nothing throws, so nothing bad ever
      // reaches storage or the DOM. A field the file lacks, or gets wrong,
      // keeps its CURRENT value (not the default): a file with no photos must
      // not wipe the saved ones.
      settings = validateSettings(imported, settings);
      if (!settings.me && LOCAL_ME) settings.me = LOCAL_ME;   // same rule as loadSettings
      saveSettings(); savePfps(); saveGc();   // bulky photos live under their own keys
      importFile.value = "";
      applySettingsChange();   // imported timezone + ignored people/groups take effect now
      toast("Settings imported successfully");
    };
    reader.readAsText(file);
  };
}
/* ---- Timezone picker --------------------------------------------
   Every IANA zone the browser knows (Intl.supportedValuesOf, or a short list of
   common zones on engines without it), filterable by id or friendly name.
   "Browser local" and "UTC" are always the first two options, and the zone in
   effect is always present (and marked selected) even when the filter would
   hide it, so the <select> never silently shows a different zone. */
const TZ_LABELS = {
  local: "Browser local time", UTC: "UTC (as exported)",
  "America/New_York": "US Eastern (EST/EDT)", "America/Chicago": "US Central (CST/CDT)",
  "America/Denver": "US Mountain (MST/MDT)", "America/Los_Angeles": "US Pacific (PST/PDT)",
  "Europe/London": "British Time (GMT/BST)", "Europe/Paris": "Central European (CET/CEST)",
  "Australia/Sydney": "Australian Eastern (AEST/AEDT)",
};
let TZ_ALL = null;
function tzZoneList() {
  if (TZ_ALL) return TZ_ALL;
  let z = null;
  try { if (typeof Intl.supportedValuesOf === "function") z = Intl.supportedValuesOf("timeZone"); } catch (e) { z = null; }
  if (!z || !z.length) z = Object.keys(TZ_LABELS).filter((k) => k !== "local" && k !== "UTC");
  TZ_ALL = z.filter((k) => k !== "UTC");
  return TZ_ALL;
}
function tzLabel(z) {
  if (TZ_LABELS[z]) return z === "local" || z === "UTC" ? TZ_LABELS[z] : TZ_LABELS[z] + " — " + z.replace(/_/g, " ");
  return z.replace(/_/g, " ");
}
function fillTzOptions(sel, filter) {
  const f = String(filter || "").toLowerCase().replace(/_/g, " ").trim();
  const cur = settings.timezone;
  const hit = (z) => !f || (z + " " + tzLabel(z)).toLowerCase().replace(/_/g, " ").includes(f);
  const zones = ["local", "UTC"].concat(tzZoneList().filter((z) => hit(z) || z === cur));
  if (zones.indexOf(cur) < 0) zones.push(cur);
  const frag = document.createDocumentFragment();
  zones.forEach((z) => {
    const o = document.createElement("option");
    o.value = z; o.textContent = tzLabel(z);
    if (z === cur) { o.defaultSelected = true; o.selected = true; }
    frag.appendChild(o);
  });
  sel.replaceChildren(frag);
}
// a SCOPED reset. The old "Reset all" silently wiped bookmarks,
// "me", ignored people/groups and the timezone while its dialog only
// mentioned names/colors/theme/saved searches. It now resets exactly what the
// dialog lists and keeps the rest; the new object is built from a deep clone
// of DEFAULTS so nothing can alias the defaults afterwards.
const RESET_CONFIRM = "Reset customization?\n\n" +
  "Resets: theme, accent color, font size, density, avatar & timestamp display, people & group names, person colors, and saved searches.\n\n" +
  "Keeps: bookmarks, Word Battles words, “this is me”, hidden people & groups, timezone, timeline reading positions, and profile & group photos.";
// What an Import can replace, in the order its confirm lists them. A section is
// replaced only when the file carries at least one of its fields.
const IMPORT_SECTIONS = [
  ["appearance (accent color, font size, density, avatar & timestamp display)", ["accent", "fontSize", "density", "avatars", "timestamps"]],
  ["people names", ["names"]],
  ["person colors", ["colors"]],
  ["profile photos", ["pfps"]],
  ["group names & photos", ["gc", "gcName", "gcPhoto"]],
  ["saved searches", ["saved"]],
  ["bookmarks", ["pins"]],
  ["Word Battles words", ["battleWords"]],
  ["“this is me”", ["me"]],
  ["timezone", ["timezone", "tzExplicit"]],
  ["hidden people & groups", ["ignoredUsers", "ignoredGroups"]],
];
function importConfirmText(doc) {
  const has = (k) => Object.prototype.hasOwnProperty.call(doc, k);
  const rep = [], keep = [];
  for (const [label, keys] of IMPORT_SECTIONS) (keys.some(has) ? rep : keep).push(label);
  keep.push("theme");   // lives under its own gca.theme key; Import never touches it
  return "Import settings?\n\n" +
    "Replaces: " + rep.join(", ") + ".\n\n" +
    "Keeps: " + keep.join(", ") + ".\n\n" +
    "Invalid values in the file are skipped and keep their current setting.";
}
function resetCustomization() {
  const prev = settings;
  const next = cloneDefaults();
  next.pins = prev.pins.slice();
  next.battleWords = prev.battleWords.slice();
  next.me = prev.me;
  next.ignoredUsers = prev.ignoredUsers.slice();
  next.ignoredGroups = prev.ignoredGroups.slice();
  next.timezone = prev.timezone;
  next.tzExplicit = prev.tzExplicit;
  next.pfps = Object.assign({}, prev.pfps);
  next.gcPhoto = prev.gcPhoto;
  for (const cid in prev.gc) { if (prev.gc[cid] && prev.gc[cid].photo) next.gc[cid] = { photo: prev.gc[cid].photo }; }
  settings = next;
  setTheme("lightsout");   // theme lives under its own gca.theme key
  saveSettings(); savePfps(); saveGc();
  applySettingsChange();
}
// Settings were replaced wholesale (Import / Reset): re-derive everything that
// reads them — photo map, date formatters (timezone), theme vars — then
// re-activate the conversation, which re-filters MSGS for ignored people,
// drops every derived cache, rebuilds brand / picker / sparkline and
// re-renders the current view. A conversation that is now hidden is swapped
// for the first still-visible one.
function applySettingsChange() {
  rebuildPfps();
  initDateFormatters();
  applyTheme();
  let id = CONV && CONV.id;
  if (id == null || ignoredGroupIds().has(String(id))) { const vis = visibleConvos(); id = vis[0] ? vis[0].id : id; }
  activateConversation(id, true);
}
// PFPS is a const map used across the app; refill it in place.
function rebuildPfps() {
  for (const k in PFPS) delete PFPS[k];
  Object.assign(PFPS, (typeof window !== "undefined" && window.LOCAL_PFPS) || {}, settings.pfps);
}
function segWire(seg, cur, cb) {
  seg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("sel", b.dataset.v === cur);
    b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b)); cb(b.dataset.v); };
  });
}

/* ===========================================================================
   NAVIGATION / INIT
   ======================================================================== */
let curView = null;
const VIEWS = ["search", "timeline", "stats", "people", "settings", "capsule", "gallery", "pins", "hof", "wrapped", "threads", "battles", "chains"];

/* ---- URL hash state ----------------------------------------------------
   The address bar carries where you are, as ids only: #v=<view>&c=<conversation
   id>[&m=<message id> — the message a Timeline jump landed on]. The search
   query is private-chat text and browser history can sync to the cloud, so it
   NEVER goes in the URL: it rides in history.state ({ q }), which Back /
   Forward and a reload restore (file:// included); a legacy #q= is ignored and
   dropped by the canonical rewrite. Hash-only, so it works from file:// as
   well as the server. A navigation
   (view switch, conversation switch, jump to a message) is a history entry
   (pushState); typing in Search only rewrites the current one (replaceState).
   Back / Forward (popstate) and an edited or pasted hash (hashchange) are read
   back by applyHash(), which switches conversations through the normal
   activateConversation() path (so filters never leak across chats) and
   never puts anything from the hash into markup. Unknown / garbage values are
   ignored; a link into a hidden or missing conversation or message says so
   and falls back. "Copy link to message" (a message action) builds an
   ids-only #v=timeline&c=&m= link. Microtask-batched, so one user action
   (e.g. a cross-chat jump: switch + view + message) is one history entry. */
let navMsg = null;          // id of the message the Timeline was jumped to (#m=)
let navReady = false;       // init() done: before that nothing is written
let hashApplying = false;   // applying a hash: don't write one back mid-way
let navPending = 0, navQueued = false, lastNav = null;
function navHash() {
  const p = [];
  if (curView) p.push("v=" + encodeURIComponent(curView));
  if (CONV) p.push("c=" + encodeURIComponent(CONV.id));
  if (curView === "search" && allScope()) p.push("s=all");   // the scope flag (never the query)
  if (curView === "timeline" && navMsg != null) p.push("m=" + encodeURIComponent(navMsg));
  return "#" + p.join("&");
}
// The search query this history entry carries (history.state.q), "" outside Search.
function navQ() { return curView === "search" && sEls.input ? sEls.input.value : ""; }
// A history entry's query: a capped string, or null (no state / not ours).
function stateQ(st) { return st && typeof st.q === "string" && st.q.length <= 1000 ? st.q : null; }
// Identity of a history entry: two entries can share a hash and differ by query.
const navKey = (h, q) => h + "\n" + (q || "");
function navCommit(mode) {
  if (!navReady || hashApplying) return;
  navPending = Math.max(navPending, mode === "push" ? 2 : 1);
  if (navQueued) return;
  navQueued = true;
  queueMicrotask(() => {
    navQueued = false;
    const push = navPending === 2;
    navPending = 0;
    if (!hashApplying) writeHash(navHash(), push);
  });
}
function writeHash(h, push) {
  const q = navQ();
  if (h === location.hash) {
    // same place: only the query may have changed — rewrite this entry's
    // state, never push a duplicate
    if ((stateQ(history.state) || "") !== q) { try { history.replaceState({ q }, ""); } catch (e) { /* state unavailable */ } }
    lastNav = navKey(location.hash, q);
    return;
  }
  const url = location.href.split("#")[0] + h;
  try { history[push ? "pushState" : "replaceState"]({ q }, "", url); }
  catch (e) {
    // a browser that refuses history entries for this URL: fall back to the
    // plain hash (still a history entry when pushing; the query isn't kept)
    try { if (push) location.hash = h; else location.replace(url); } catch (e2) { /* give up quietly */ }
  }
  lastNav = navKey(location.hash, stateQ(history.state));
}
// "#v=…&c=…" -> { v, c, m } (first of each; undecodable / unknown keys —
// including a legacy q — dropped; values length-capped). Plain strings —
// never markup.
function parseHash(h) {
  const out = {};
  // Only what follows the LAST "#": pasting a copied "#v=…&m=…" at the end of
  // an address that already has a hash (the app always writes one) gives
  // "…#v=search&c=A#v=timeline&c=B&m=b5", and the pasted part is what's meant.
  const raw = String(h || "");
  const s = raw.slice(raw.lastIndexOf("#") + 1);
  if (!s || s.length > 8000) return out;
  for (const part of s.split("&")) {
    const k = part.indexOf("=");
    if (k <= 0) continue;
    const key = part.slice(0, k);
    if ((key !== "v" && key !== "c" && key !== "m" && key !== "s") || Object.prototype.hasOwnProperty.call(out, key)) continue;
    let val;
    try { val = decodeURIComponent(part.slice(k + 1).replace(/\+/g, " ")); } catch (e) { continue; }
    if (val.length > 200) continue;
    out[key] = val;
  }
  return out;
}
// The active conversation's index for a message id from a URL (ids may be
// numbers in older builds), or -1.
function idxForMsgId(id) {
  let i = ID2IDX.get(id);
  if (i == null && /^\d{1,17}$/.test(id)) i = ID2IDX.get(Number(id));
  return i == null ? -1 : i;
}
// Apply a hash (+ the entry's history.state for the search query). Returns
// true if it set a view (boot falls back to the last view otherwise).
function applyHash(h, state) {
  const st = parseHash(h);
  if (st.v == null && st.c == null && st.m == null) return false;
  hashApplying = true;
  let viewSet = false;
  try {
    let convOk = true;
    if (st.c != null) {
      const c = CONVOS.find((x) => String(x.id) === st.c);
      convOk = !!c && !ignoredGroupIds().has(String(c.id));
      if (!c) toast("That conversation isn't in this archive — showing this one instead");
      else if (!convOk) toast("That conversation is hidden in Settings — showing this one instead");
      else if (!CONV || c.id !== CONV.id) activateConversation(c.id, true);
    }
    const view = VIEWS.indexOf(st.v) >= 0 ? st.v : null;
    // a message id only means something in its own conversation
    if (st.m != null && !convOk) { if (!view) { setView("timeline"); viewSet = true; } }
    if (st.m != null && convOk && (!view || view === "timeline")) {
      const idx = idxForMsgId(st.m);
      if (idx >= 0) { jumpTo(idx); viewSet = true; }
      else {
        const raw = CONV && (CONV.msgs || []).some((x) => String(x.i) === st.m);
        toast(raw ? "That message is from someone hidden in Settings" : "That message isn't in this conversation");
        if (curView !== "timeline") setView("timeline");
        viewSet = true;
      }
    } else if (view) {
      // the search scope is part of the address (&s=all)
      const scopeWas = searchScope;
      if (view === "search") searchScope = st.s === "all" ? "all" : "this";
      if (view !== curView || view === "search") setView(view);
      viewSet = true;
      // the entry's own query (no state — a typed / pasted address — leaves
      // the box alone)
      const q = stateQ(state);
      if (view === "search" && sEls.input && q != null && sEls.input.value !== q) {
        sEls.input.value = q; sEls.clear.hidden = !q; runSearch();
      } else if (view === "search" && sEls.input && searchScope !== scopeWas) runSearch();
    }
  } finally { hashApplying = false; }
  return viewSet;
}
// Back / Forward / an edited hash: close whatever overlay is open, then follow.
function onHashNav() {
  const key = navKey(location.hash, stateQ(history.state));
  if (key === lastNav) return;
  lastNav = key;
  for (let k = 0; k < 10 && closeTopModal(); k++) { /* pop every layer */ }
  closeMsgActs(); closePopovers();
  applyHash(location.hash, history.state);
  writeHash(navHash(), false);   // canonical form of whatever was applied
}
// A shareable link to one message: ids only. From file:// the page address is
// a local path (often with the OS user name in it), so only the "#…" part is
// copied there, and the toast says where to paste it.
function msgLink(convId, mid) {
  const h = "#v=timeline&c=" + encodeURIComponent(convId) + "&m=" + encodeURIComponent(mid);
  return location.protocol === "file:" ? h : location.href.split("#")[0] + h;
}
function copyMsgLink(convId, mid) {
  const local = location.protocol === "file:";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(msgLink(convId, mid))
      .then(() => (local ? toast("Copied the message's #link — paste it at the end of this archive's address to open it", 6000) : toast("Copied link to message")))
      .catch(() => toast("Copy failed"));
  } else toast("Copy failed");
}

function setView(name) {
  // Remember where the timeline was being read, so a rebuild (timezone
  // change) can reopen there instead of at the top — and for the next
  // visit / reload of this conversation.
  if (curView === "timeline" && name !== "timeline") { tlResume = timelineFirstVisible(); saveTlPos(); }
  curView = name;
  if (!tlJumping) navMsg = null;   // #m= names a jump target, not a view visit
  navCommit("push");
  try { localStorage.setItem("gca.lastView", name); } catch(e) {}
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  document.querySelectorAll(".nav-item").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  reflectMobileNav(name);
  // never pull focus out of an open dialog layer (e.g. first-run onboarding)
  // and only with a fine pointer — on a phone focusing the box pops the
  // soft keyboard over the results.
  if (name !== "search") closeFilterSheet();
  if (name === "search") { ensureSearch(); setTimeout(() => { if (sEls.input && !topModal() && matchMedia("(pointer: fine)").matches) sEls.input.focus(); }, 0); }
  else if (name === "timeline") {
    // an open is quiet (no highlight) and a cold jumpTo() doesn't
    // render a position first. Where a first open lands has since changed: the
    // newest message (or where this conversation was last read), not the top.
    if (!tlBuilt && !tlJumping) openTimelineAtReadingPosition();
    else if (!tlBuilt) ensureTimelineShell();
    updateLatestBtn();
  }
  else if (name === "stats") renderStats();
  else if (name === "people") renderPeople();
  else if (name === "settings") renderSettings();
  else if (name === "capsule") renderCapsule();
  else if (name === "gallery") renderGallery();
  else if (name === "pins") renderPins();
  else if (name === "hof") renderHallOfFame();
  else if (name === "wrapped") renderWrapped();
  else if (name === "threads") renderThreads();
  else if (name === "battles") renderBattles();
  else if (name === "chains") renderChains();
}

function convLabel(c) {
  if (!c) return "Conversation";
  if (c.title) return c.title;
  return "Group " + String(c.id).slice(-4);
}
// LOCAL_GC is per-conversation { convId: { name, photo } }; older builds wrote a
// single flat { name, photo } that applied to every group — support both.
function flatLocalGc() {
  return LOCAL_GC && ("name" in LOCAL_GC || "photo" in LOCAL_GC) ? LOCAL_GC : null;
}
function localGcFor(c) {
  return LOCAL_GC ? (LOCAL_GC[c && c.id] || flatLocalGc()) : null;
}
// The name a chat goes by everywhere (brand, pickers, Pinned and All chats
// headers, exports): the in-app per-group override (Settings → Group chats)
// wins over the wizard's LOCAL_GC, which wins over the legacy flat name,
// then the chat's own title, its last rename, "Group 1234".
// The legacy flat name (a flat LOCAL_GC, settings.gcName) is one name from
// when an archive held one chat. It names that chat everywhere when it is the
// only one; with several it names only the sidebar brand (brand = true), as it
// always has, so the pickers and headers still tell the chats apart.
function displayConvName(c, brand) {
  if (!c) return convLabel(c);
  const sgc = settings.gc ? settings.gc[c.id] : null, lgc = LOCAL_GC ? LOCAL_GC[c.id] : null;
  const flat = flatLocalGc();
  const legacy = (brand || visibleConvos().length <= 1) ? ((flat && flat.name) || settings.gcName) : "";
  const nameEv = (c.events || []).filter((e) => e.type === "name");
  return (sgc && sgc.name) || (lgc && lgc.name) || legacy || c.title || (nameEv.length ? nameEv[nameEv.length - 1].name : convLabel(c));
}

function updateBrand() {
  const lgc = localGcFor(CONV);
  const sgc = (settings.gc && CONV) ? settings.gc[CONV.id] : null;
  const title = displayConvName(CONV, true);
  // Restore the real group photo on the sidebar brand mark when present.
  const mark = document.querySelector(".brand-mark");
  const gcPhoto = sanitizePhoto((sgc && sgc.photo) || (lgc && lgc.photo) || settings.gcPhoto);
  if (mark) {
    if (gcPhoto) {
      mark.textContent = "";
      mark.style.backgroundImage = `url('${gcPhoto}')`;
      mark.style.backgroundSize = "cover";
      mark.style.backgroundPosition = "center";
      mark.style.backgroundRepeat = "no-repeat";
    } else {
      mark.style.backgroundImage = "";
      if (!mark.querySelector("svg")) {
        mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12.5h5"/></svg>';
      }
    }
  }
  document.getElementById("brand-title").textContent = title || "Group Chat";
  document.getElementById("brand-sub").textContent = fmtNum(N) + " messages";
  // only the text line — the sparkline lives in its own #sidebar-spark.
  document.getElementById("sidebar-foot-text").innerHTML =
    (N ? zonedParts(MSGS[0].t).y + "–" + zonedParts(MSGS[N - 1].t).y : "") +
    " · " + PARTS.length + " people<br>" + fmtNum(MSGS.filter((m) => m.m).length) + " photos & videos";
  syncMobileConvPicker();   // mobile top bar mirrors the brand name + count
}

function renderConvPicker() {
  const host = document.getElementById("conv-picker");
  if (!host) return;
  const convos = visibleConvos();
  syncMobileConvPicker();   // the mobile <select> carries the same options
  if (convos.length <= 1) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  const opt = (c) => `<option value="${esc(c.id)}"${CONV && c.id === CONV.id ? " selected" : ""}>${esc(displayConvName(c))} · ${fmtNum(c.count)}</option>`;
  const body = convos.map(opt).join("");
  host.innerHTML = `<label class="conv-pick-label" for="conv-select">Group chat (${convos.length})</label>
    <select id="conv-select" class="conv-select">${body}</select>`;
  host.querySelector("#conv-select").onchange = (e) => activateConversation(e.target.value, true);
}

// Fills the onboarding card's wizard address (called once the card exists).
function updateSetupUrlInfo() {
  // If the server injected the actual URL, use it; otherwise default message stays.
  if (window.GCA_SERVER_URL) {
    const el = document.getElementById("setup-url-note");
    if (el) el.textContent = window.GCA_SERVER_URL + "/setup.html";
  }
}

function init() {
  applyTheme();
  initTheme();
  updateBrand();
  renderConvPicker();

  document.querySelectorAll(".nav-item").forEach((b) => {
    if (b.id !== "nav-random") b.onclick = () => setView(b.dataset.view);
  });
  
  const navRand = document.getElementById("nav-random");
  if (navRand) {
    navRand.onclick = () => {
      const idx = Math.floor(Math.random() * N);
      jumpTo(idx);
    };
  }

  // Decorative icons in nav items — hide from assistive tech so the label reads cleanly.
  document.querySelectorAll(".nav-item svg").forEach((s) => s.setAttribute("aria-hidden", "true"));

  initMobileChrome();

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openCommandPalette(); return; }
    if (e.key === "Escape") {
      if (closeTopModal()) return;      // the More sheet / onboarding are stack layers too
      if (closeMsgActs()) return;       // an open ⋯ action toolbar
      closePopovers();
    }
    if (curView === "wrapped" && !topModal() && wrappedKey(e)) return;
    // "/" focuses the search box — on the Search view too (it used to
    // be a no-op there), never while typing or with an overlay open.
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable && !topModal()) {
      e.preventDefault();
      if (curView !== "search") setView("search");
      const si = document.getElementById("s-input"); if (si) si.focus();
    }
    if (e.key === "?" && document.activeElement.tagName !== "INPUT" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleKeyboardHelp(); }
    // Home / End = oldest / newest message in the Timeline (a text field
    // keeps its own Home / End; an open overlay keeps the keys too).
    if ((e.key === "Home" || e.key === "End") && curView === "timeline" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
        !topModal() && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
      e.preventDefault();
      if (e.key === "End") jumpToLatest(); else jumpToOldest();
    }
  });
  // a reload / closed tab keeps the Timeline's reading position.
  window.addEventListener("pagehide", saveTlPos);

  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;
  buildSidebarSparkline();
  showOnThisDayToast();
  // guarded like every other storage access — with site data blocked
  // the localStorage getter itself throws, and an unguarded read here used to
  // abort init() before setView() ever ran (blank main area).
  let lastView = null;
  try { lastView = localStorage.getItem("gca.lastView"); } catch (e) { /* storage blocked */ }
  // a #v=/c=/m=/q= hash (a shared link, a reload, Back into the app)
  // wins over the last view.
  if (!applyHash(location.hash, history.state)) setView((lastView && VIEWS.includes(lastView)) ? lastView : "search");
  navReady = true;
  writeHash(navHash(), false);
  window.addEventListener("popstate", onHashNav);
  window.addEventListener("hashchange", onHashNav);
  maybeShowOnboarding();
}

// First-run prompt: shown while the demo data is loaded, or when real data is
// loaded but nobody has been named / marked as "you" yet. Dismissible; the
// choice is remembered so it never nags.
function maybeShowOnboarding() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("gca.onboarded") === "1"; } catch (e) {}
  if (dismissed) return;
  const named = Object.keys(settings.names).length > 0 || Object.keys(LOCAL_NAMES).length > 0;
  const firstRun = IS_SAMPLE || (!settings.me && !named);
  if (!firstRun) return;

  const ov = el("div", "onboard");
  // The wizard works only through the server (src/setup.html, served at
  // /setup.html). From file:// there is usually no server running, so the
  // button opens src/setup.html from disk, which shows only how to start it.
  ov.innerHTML = `
    <div class="onboard-card">
      <div class="onboard-title" id="onboard-title">Welcome to your Group Chat Archive</div>
      <div class="onboard-body">
        ${IS_SAMPLE
          ? `You're looking at <b>synthetic demo data</b>. To load your own Twitter/X
             group chat export, run the one-time <b>setup wizard</b> — it points the
             build at your raw <code>.js</code> + media, restores the group photo, and
             helps you name everyone.`
          : `Your archive is loaded, but no one's named yet. Open the <b>setup wizard</b>
             for a guided walkthrough, or jump to the <b>People</b> tab to name
             participants and mark which one is you.`}
      </div>
      <div class="onboard-note">${location.protocol === "file:"
        ? `The wizard needs the local server: double-click <code>start-setup.cmd</code>
           (Windows) or <code>start-setup.command</code> (macOS/Linux) in the project folder,
           or run <code>npm start</code> and open
           <code><span id="setup-url-note">localhost:8765/setup.html</span></code>.`
        : `The wizard runs on this server, at
           <code><span id="setup-url-note">localhost:8765/setup.html</span></code>.`}</div>
      <div class="onboard-actions">
        <a class="btn primary" href="${location.protocol === "file:" ? "src/setup.html" : "setup.html"}">Open setup wizard</a>
        <button class="btn ghost" id="onboard-people">Go to People tab</button>
        <button class="btn ghost" id="onboard-dismiss">Maybe later</button>
      </div>
      <label class="onboard-dontshow"><input type="checkbox" id="onboard-never"> Don't show this again</label>
    </div>`;
  const close = () => {
    if (ov.querySelector("#onboard-never").checked) { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) {} }
    ov.remove();
    restoreFocus(ov);
  };
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector("#onboard-people").onclick = () => { close(); setView("people"); };
  ov.querySelector("#onboard-dismiss").onclick = close;
  document.body.appendChild(ov);
  updateSetupUrlInfo();
  // a real dialog — labelled, focus moved in and trapped; Esc = "Maybe later"
  // Opened at boot, so there is no opener to hand focus back to: return it to
  // the current view's own nav item (sidebar on desktop, tab bar on mobile).
  ov._close = close;
  ov.setAttribute("aria-labelledby", "onboard-title");
  const home = [...document.querySelectorAll(".nav-item.active, .tabbar .tab.active, #tab-more.active")]
    .find((n) => n.getClientRects().length) || null;
  applyDialog(ov, null, { initial: ".onboard-actions .btn", opener: home });
}

/* ===========================================================================
   TIME CAPSULE VIEW
   ======================================================================== */
function renderCapsule() {
  const v = document.getElementById("view-capsule");
  v.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">Time Capsule</div>
    <div class="page-sub">On this day in history...</div></div>
    <div class="page-body" id="capsule-body"></div></div>`;
  // no hardcoded calc(100vh - 120px) nested scroller — the .page (flex: 1,
  // overflow auto, padded clear of the mobile tab bar) scrolls like every view.
  const body = v.querySelector("#capsule-body");
  
  // "Today" and each message are compared in the configured zone, so "on this
  // day" means the same calendar day the timestamps are labelled with.
  const todayZ = zonedParts(Date.now());
  const tMonth = todayZ.mo;
  const tDate = todayZ.d;
  const tYear = todayZ.y;

  const matchesByYear = {};

  const TI = timeIndex();
  for (let i = 0; i < N; i++) {
    if (TI.month[i] === tMonth && TI.mday[i] === tDate) {
      const yr = TI.year[i];
      // Only past years qualify (>= guards against a future year ever rendering
      // "0 years ago" if this filter is loosened later).
      if (yr >= tYear) continue;
      if (!matchesByYear[yr]) matchesByYear[yr] = [];
      matchesByYear[yr].push(i);
    }
  }
  
  const years = Object.keys(matchesByYear).sort((a,b) => b - a);
  if (years.length === 0) {
    body.appendChild(emptyState("clock", "Nothing was said on " + DAY.formatToParts(Date.now()).filter((p) => p.type === "month" || p.type === "day").map((p) => p.value).join(" ") + " in earlier years.",
      "The capsule shows messages sent on today's date in earlier years — check back another day, or read the whole story.",
      ["Open Timeline", () => setView("timeline")]));
    return;
  }
  
  const frag = document.createDocumentFragment();
  years.forEach(yr => {
    const diff = tYear - parseInt(yr, 10);
    const yrHead = el("div", "section-h", `${diff} year${diff > 1 ? 's' : ''} ago today (${yr})`);
    yrHead.style.marginTop = "24px";
    yrHead.style.marginBottom = "12px";
    frag.appendChild(yrHead);
    
    const list = el("div", "list");
    matchesByYear[yr].forEach(idx => {
       list.appendChild(renderMsg(idx, { clickable: true }));
    });
    frag.appendChild(list);
  });
  
  body.appendChild(frag);
}

/* ===========================================================================
   GALLERY VIEW
   ======================================================================== */
let galleryState = { items: [], page: 0 };
let galleryObserver = null;
let galEls = {};

function renderGallery() {
  const v = document.getElementById("view-gallery");
  // No messages (none, or every sender ignored): nothing to gallery — show a panel, not an
  // empty grid that looks broken.
  if (!N) {
    v.innerHTML = '<div class="empty"><div class="big">' + cmdIco("gallery") + '</div><div>' + emptyConvText() + '</div></div>';
    return;
  }
  if (!v.innerHTML) {
    const items = [];
    const kinds = { img: 0, vid: 0, file: 0 };
    for (let i = 0; i < N; i++) {
      if (MSGS[i].m) { items.push(i); const k = MSGS[i].k; kinds[k === "img" || k === "vid" ? k : "file"]++; }
    }
    // the standard page header (title + count), like every other view;
    // the .page itself is the scroll root the lazy pages observe.
    const parts = [];
    if (kinds.img) parts.push(plural(kinds.img, "photo"));
    if (kinds.vid) parts.push(plural(kinds.vid, "video"));
    if (kinds.file) parts.push(plural(kinds.file, "file"));
    v.innerHTML = `<div class="page" id="gal-scroll"><div class="page-head"><div class="page-title">Gallery</div>
        <div class="page-sub">${esc(parts.length ? parts.join(" · ") + " · newest first" : "No media yet")}</div></div>
      <div class="page-body"><div class="gallery" id="gal-list"></div></div></div>`;

    galEls = { scroll: v.querySelector("#gal-scroll"), list: v.querySelector("#gal-list") };
    // MSGS is oldest-first; reverse in place so the gallery shows newest media
    // first (matches the lazy-loaded page order below).
    galleryState.items = items.reverse();
    // no media → say so, not a blank grid.
    if (!items.length) {
      galEls.list.appendChild(emptyState("gallery", "No photos or videos in this conversation yet.",
        "Shared photos and videos collect here. Links and text are in Search.", ["Search messages", () => setView("search")]));
    }

    galleryObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) appendGalleryPage();
    }, { root: galEls.scroll, rootMargin: "600px" });
  }
  
  if (galleryState.page === 0) {
    appendGalleryPage();
  }
}

function appendGalleryPage() {
  const { items, page } = galleryState;
  const PAGE_SIZE = 100;
  const start = page * PAGE_SIZE;
  if (start >= items.length) return;
  const slice = items.slice(start, start + PAGE_SIZE);
  
  const frag = document.createDocumentFragment();
  for (const i of slice) {
    frag.appendChild(galleryCell(i, items));   // newest-first, like the grid
  }
  galEls.list.appendChild(frag);
  galleryState.page++;
  
  const old = galEls.list.querySelector(".sentinel"); if (old) old.remove();
  if (galleryState.page * PAGE_SIZE < items.length) {
    const sentinel = el("div", "sentinel"); galEls.list.appendChild(sentinel);
    galleryObserver.observe(sentinel);
  }
}

/* ===========================================================================
   THEME SHUFFLE (surprise me — random theme + accent)
   ======================================================================== */
function shuffleTheme() {
  settings.accent = ACCENTS[Math.floor(Math.random() * ACCENTS.length)];
  const t = THEMES[Math.floor(Math.random() * THEMES.length)];
  setTheme(t);
  saveSettings(); applyTheme();
  if (curView === "settings") renderSettings();
  toast("New theme — " + t + " · " + settings.accent);
}

/* ===========================================================================
   SIDEBAR ACTIVITY SPARKLINE (monthly message volume)
   ======================================================================== */
function buildSidebarSparkline() {
  // own container, content REPLACED on every build (it used to be
  // prepended to #sidebar-foot, duplicating on each timezone change, while
  // updateBrand() wiped it on every rename / photo change / import).
  const foot = document.getElementById("sidebar-spark");
  if (!foot) return;
  foot.innerHTML = "";
  // Monthly counts from the zoned time-index aggregate — zero-filled,
  // the same series as the Stats months chart.
  const vals = timeAgg().monthArr.map((m) => m[1]);
  if (vals.length < 2) return;
  const W = 240, H = 38, max = Math.max(...vals);
  const step = W / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, H - 3 - (v / max) * (H - 6)]);
  const line = pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = "0," + H + " " + line + " " + W + "," + H;
  const peak = pts[vals.indexOf(max)] || pts[pts.length - 1];
  const svg = `<div class="spark" title="Monthly message volume — ${vals.length} months">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}">
      <polygon points="${area}" fill="var(--accent-glow)"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${peak[0].toFixed(1)}" cy="${peak[1].toFixed(1)}" r="2.4" fill="var(--accent)"/>
    </svg></div>`;
  foot.innerHTML = svg;
}

/* ===========================================================================
   HALL OF FAME — most-reacted messages & media, ranked
   ======================================================================== */
let HOF = null;
let hofYear = "all";
function computeHOF() {
  if (HOF) return HOF;
  const arr = [];
  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    const rc = m.r ? m.r.length : 0;
    if (rc > 0) arr.push({ i, rc, t: m.t, media: !!m.m });
  }
  arr.sort((a, b) => b.rc - a.rc || b.t - a.t);
  const TI = timeIndex();
  arr.forEach((x) => { x.y = TI.year[x.i]; });   // zoned year, read by the year chips
  const years = [...new Set(arr.map((x) => x.y))].sort((a, b) => b - a);
  HOF = { arr, years };
  return HOF;
}
function renderHallOfFame() {
  const v = document.getElementById("view-hof");
  const h = computeHOF();
  if (!hofYear || (hofYear !== "all" && h.years.indexOf(+hofYear) < 0)) hofYear = "all";
  const inYear = (x) => hofYear === "all" || x.y === +hofYear;
  const items = h.arr.filter(inYear);

  const yearChips = ['<button class="pill hof-yr' + (hofYear === "all" ? " active" : "") + '" data-yr="all">All time</button>']
    .concat(h.years.map((y) => '<button class="pill hof-yr' + (hofYear === String(y) ? " active" : "") + '" data-yr="' + y + '">' + y + "</button>")).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">Hall of Fame</div>
      <div class="page-sub">The most-reacted messages of all time — the legendary moments, ranked by reaction count.</div></div>
    <div class="page-body">
      <div class="hof-years">${yearChips}</div>
      ${items.length ? '<div class="hof-podium" id="hof-podium"></div>' : ''}
      <div class="section"><div class="section-h">Top reacted messages</div><div class="list" id="hof-list"></div></div>
      <div class="section" id="hof-media-sec" hidden><div class="section-h">Most-reacted media</div><div class="gallery" id="hof-media"></div></div>
    </div></div>`;

  v.querySelectorAll(".hof-yr").forEach((b) => { b.onclick = () => { hofYear = b.dataset.yr; renderHallOfFame(); }; });

  if (!items.length) {
    v.querySelector("#hof-list").appendChild(hofYear !== "all"
      ? emptyState("hof", "No reacted messages in " + hofYear + ".", "Try another year, or the whole chat.", ["Show all time", () => { hofYear = "all"; renderHallOfFame(); }])
      : emptyState("hof", "No reacted messages yet.", "Messages people react to are ranked here, most reactions first.", ["Open Timeline", () => setView("timeline")]));
    return;
  }

  // Podium — top 3
  const podium = v.querySelector("#hof-podium");
  const medals = ["🥇", "🥈", "🥉"];
  items.slice(0, 3).forEach((x, k) => {
    const m = MSGS[x.i];
    const card = el("div", "hof-card rank-" + (k + 1));
    const snippet = (m.x || "").trim() || (m.m ? "media" : "—");
    card.innerHTML = `<div class="hof-medal">${medals[k]}</div>
      ${pfpHtml(m.s, "width:34px;height:34px;font-size:13px")}
      <div class="hof-meta">
        <div class="hof-name">${esc(nameOf(m.s))}</div>
        <div class="hof-date">${esc(DT.format(m.t))}</div>
      </div>
      <div class="hof-snip">${esc(snippet.slice(0, 140))}${snippet.length > 140 ? "…" : ""}</div>
      <div class="hof-rc">🔥 ${fmtNum(x.rc)} reaction${x.rc === 1 ? "" : "s"}</div>`;
    asButton(card, () => jumpTo(x.i), "#" + (k + 1) + ": " + nameOf(m.s) + ", " + DT.format(m.t) + ", " + plural(x.rc, "reaction") + " — jump to message");
    podium.appendChild(card);
  });

  // Full ranked list (skip media-only so the bubble list stays readable; media gets its own grid)
  const list = v.querySelector("#hof-list");
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const x of items) {
    if (shown >= 50) break;
    const m = MSGS[x.i];
    if (!(m.x && m.x.trim())) continue;
    const node = renderMsg(x.i, { clickable: true });
    node._msgAct.hof = { rank: items.indexOf(x) + 1, year: hofYear };   // its Share card carries the rank
    const badge = el("div", "hof-badge", "🔥 " + fmtNum(x.rc));
    node.appendChild(badge);
    frag.appendChild(node);
    shown++;
  }
  if (shown === 0) list.appendChild(el("div", "empty", '<div class="big">' + cmdIco("gallery") + '</div><div>The most-reacted items here are all media — see below.</div>'));
  list.appendChild(frag);

  // Media grid
  const mediaItems = items.filter((x) => x.media).slice(0, 24);
  if (mediaItems.length) {
    v.querySelector("#hof-media-sec").hidden = false;
    const grid = v.querySelector("#hof-media");
    const ranked = mediaItems.map((x) => x.i);   // arrows walk the ranking
    mediaItems.forEach((x) => {
      const cell = galleryCell(x.i, ranked);
      const tag = el("div", "hof-cell-rc", "🔥 " + fmtNum(x.rc));
      cell.appendChild(tag);
      grid.appendChild(cell);
    });
  }
}

/* ===========================================================================
   WRAPPED — animated Year in Review slideshow
   ======================================================================== */
let wrappedYear = null, wrappedSlide = 0;
const wrappedCache = {};
function wrappedYears() {
  if (wrappedCache.__years) return wrappedCache.__years;
  const set = new Set(), TI = timeIndex();
  for (let i = 0; i < N; i++) set.add(TI.year[i]);
  wrappedCache.__years = [...set].sort((a, b) => a - b);
  return wrappedCache.__years;
}
function computeWrapped(year) {
  if (wrappedCache[year]) return wrappedCache[year];
  const perPerson = {}, dayCount = {}, emojis = {}, words = new Map();
  let total = 0, media = 0, reacts = 0, chars = 0;
  let topMsg = { i: -1, rc: -1 };
  const TI = timeIndex();
  for (let i = 0; i < N; i++) {
    if (TI.year[i] !== year) continue;
    const m = MSGS[i];
    total++;
    perPerson[m.s] = (perPerson[m.s] || 0) + 1;
    const dk = dayNumKey(TI.day[i]);
    dayCount[dk] = (dayCount[dk] || 0) + 1;
    if (m.m) media++;
    const rc = m.r ? m.r.length : 0;
    reacts += rc;
    if (rc > topMsg.rc) topMsg = { i, rc };
    if (m.x) {
      chars += m.x.length;
      // Same emoji grammar and tokenizer as Stats.
      for (const e of extractEmojis(m.x)) emojis[e] = (emojis[e] || 0) + 1;
      for (const t of tokenize(m.x)) words.set(t, (words.get(t) || 0) + 1);
    }
  }
  const people = Object.entries(perPerson).sort((a, b) => b[1] - a[1]);
  let busyDay = "", busyN = 0;
  for (const k in dayCount) if (dayCount[k] > busyN) { busyN = dayCount[k]; busyDay = k; }
  const topEmoji = Object.entries(emojis).sort((a, b) => b[1] - a[1])[0] || null;
  const topWords = topCloudWords(words, 5);   // spellings merged, like the Stats word cloud
  wrappedCache[year] = {
    year, total, media, reacts, chars,
    people, activeDays: Object.keys(dayCount).length,
    busyDay, busyN, topEmoji, topWords, topMsg,
  };
  return wrappedCache[year];
}
function wrappedSlides(w) {
  // `num` is presentation-only (raw value behind a formatted `big`) so the
  // renderer can emit data-count for the count-up; the data math is unchanged.
  const slides = [];
  slides.push({ kind: "intro", big: w.year, label: "Wrapped", sub: "A year in the group chat" });
  slides.push({ kind: "stat", big: fmtNum(w.total), num: w.total, label: "messages sent in " + w.year, sub: "across " + fmtNum(w.activeDays) + " active days" });
  if (w.people.length) {
    const [id, c] = w.people[0];
    slides.push({ kind: "person", id, big: fmtNum(c), num: c, label: "messages from " + nameOf(id), sub: nameOf(id) + " was the most active this year", podium: w.people.slice(0, 3) });
  }
  if (w.busyDay) slides.push({ kind: "stat", big: fmtNum(w.busyN), num: w.busyN, label: "messages in a single day", sub: "the busiest day was " + DAY.format(dayKeyBoundInstant(w.busyDay)) });
  if (w.topWords.length) slides.push({ kind: "words", big: '"' + w.topWords[0][0] + '"', label: "the word of the year", sub: "used " + fmtNum(w.topWords[0][1]) + " times", list: w.topWords });
  if (w.topEmoji) slides.push({ kind: "stat", emoji: w.topEmoji[0], big: w.topEmoji[0], label: "the emoji of the year", sub: "sent " + fmtNum(w.topEmoji[1]) + " times", giant: true });
  slides.push({ kind: "stat", big: fmtNum(w.media), num: w.media, label: "photos & videos shared", sub: fmtNum(w.reacts) + " reactions given all year" });
  if (w.topMsg.i >= 0 && w.topMsg.rc > 0) slides.push({ kind: "star", i: w.topMsg.i, rc: w.topMsg.rc });
  slides.push({ kind: "outro", label: "That was " + w.year, sub: "Tap a different year above to relive another one" });
  return slides;
}
// Wrapped nav pill icons (mock-wrapped .nav-btn chevrons + restart loop).
const WR_ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 108-8M4 4v4h4"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
};
// slide kind → backdrop wash (intro/outro share the hero wash; every wash is
// mixed from the accent).
const WR_BG = { intro: "wr-bg-hero", outro: "wr-bg-hero", stat: "wr-bg-vol", person: "wr-bg-people", words: "wr-bg-word", star: "wr-bg-star" };

// Story state. Autoplay runs unless the OS asks for reduced motion; the
// current segment's fill is a CSS animation (--wr-dur) whose end advances the
// story, so pausing is animation-play-state and resuming continues the fill.
// Pause reasons: the Pause button (wrUserPaused), a press-and-hold, keyboard
// focus on the story (`wrHolds`), and any open dialog (`topModal()`). Dialogs
// repaint on open and close: applyDialog / restoreFocus, plus an observer for
// the few that are removed without restoring focus.
let wrUserPaused = false, wrEnded = false;
const wrHolds = new Set();
const wrAutoplayAllowed = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
const wrPlaying = () => wrAutoplayAllowed() && !wrUserPaused && !wrEnded && !wrHolds.size && !topModal();
function wrHold(reason, on) {
  if (on) wrHolds.add(reason); else wrHolds.delete(reason);
  paintWrappedPlay();
}
// What a slide says, for the polite live region ("Slide 3 of 9: …").
function wrappedSummary(s, w) {
  if (s.kind === "intro") return w.year + " Wrapped";
  if (s.kind === "outro") return s.label;
  if (s.kind === "words") return s.label + ": " + s.big;
  if (s.kind === "star") return "Most-reacted message of " + w.year + ", " + plural(s.rc, "reaction");
  if (s.emoji && s.big === s.emoji) return s.label + ": " + s.emoji;
  return s.big + " " + s.label;
}

function renderWrapped() {
  const v = document.getElementById("view-wrapped");
  const years = wrappedYears();
  if (!years.length) { v.innerHTML = '<div class="page"><div class="empty"><div class="big">' + cmdIco("wrapped") + '</div><div>No data to wrap.</div></div></div>'; return; }
  if (wrappedYear == null || years.indexOf(wrappedYear) < 0) wrappedYear = years[years.length - 1];
  // the old stage goes away with whatever it held: a press in progress or
  // focus (removing a focused node fires no blur) must not pause the new one
  wrHolds.delete("hold"); wrHolds.delete("focus");
  wrLiveNode();

  const chips = years.map((y) => '<button class="pill wr-yr' + (y === wrappedYear ? " active" : "") + '" data-yr="' + y + '">' + y + "</button>").join("");
  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">Wrapped</div>
      <div class="page-sub">Your group chat, recapped year by year. Tap the sides or swipe to flip through (or use ← →); press and hold to pause.</div></div>
    <div class="page-body">
      <div class="wr-years">${chips}</div>
      <div class="wr-stage" id="wr-stage" tabindex="0" role="group" aria-roledescription="story" aria-label="${wrappedYear} Wrapped">
        <div class="wr-progress"><div class="wr-segs" id="wr-segs" aria-hidden="true"></div><div class="wr-ctx" id="wr-ctx" aria-hidden="true"></div></div>
        <div class="wr-slide" id="wr-slide"></div>
      </div>
      <div class="wr-controls">
        <button class="nav-btn" id="wr-prev" type="button">${WR_ICON.back}Back</button>
        <div class="wr-mid">
          <button class="nav-btn wr-icon-btn" id="wr-play" type="button"></button>
          <button class="nav-btn wr-icon-btn" id="wr-share" type="button" aria-label="Share slide" title="Share this slide as an image">${WR_ICON.share}<span class="wr-btn-txt">Share</span></button>
        </div>
        <button class="nav-btn primary" id="wr-next" type="button">Next${WR_ICON.next}</button>
      </div>
    </div></div>`;

  v.querySelectorAll(".wr-yr").forEach((b) => { b.onclick = () => { wrappedYear = +b.dataset.yr; wrappedSlide = 0; wrEnded = false; renderWrapped(); wrAnnounce(); }; });
  v.querySelector("#wr-prev").onclick = () => wrappedGo(-1, true);
  // Next becomes "Restart" on the last slide → jump back to the intro.
  v.querySelector("#wr-next").onclick = () => {
    const n = wrappedSlides(computeWrapped(wrappedYear)).length;
    if (wrappedSlide >= n - 1) { wrappedSlide = 0; wrEnded = false; drawWrappedSlide(); wrAnnounce(); } else wrappedGo(1, true);
  };
  v.querySelector("#wr-share").onclick = shareWrappedSlide;
  v.querySelector("#wr-play").onclick = () => {
    if (wrEnded) { wrEnded = false; wrUserPaused = false; wrappedSlide = 0; drawWrappedSlide(); wrAnnounce(); return; }
    wrUserPaused = !wrUserPaused; paintWrappedPlay();
  };
  wireWrappedStage(v.querySelector("#wr-stage"));
  drawWrappedSlide();
}
// Tap zones (left / right third), swipe, press-and-hold to pause, and the end
// of the current segment's fill (autoplay). A press that starts on something
// interactive inside the slide (an avatar, the star message) is left to it.
// A press becomes a hold after 280 ms only if the pointer stays within 10 px;
// a finger-speed swipe often takes longer than that, so moving cancels the
// timer, and the release is judged by displacement first.
const WR_TAP_SKIP = CARD_CHILD_SEL + ", .msg, [role=button]";
function wireWrappedStage(stage) {
  let down = null;
  const end = () => { if (down && down.timer) clearTimeout(down.timer); if (down && down.held) wrHold("hold", false); down = null; };
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest(WR_TAP_SKIP))) return;
    end();
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, held: false, moved: false };
    down.timer = setTimeout(() => { if (down) { down.timer = null; down.held = true; wrHold("hold", true); } }, 280);
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!down || e.pointerId !== down.id || down.moved) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 10) return;
    down.moved = true;
    if (down.timer) { clearTimeout(down.timer); down.timer = null; }
  });
  stage.addEventListener("pointerup", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, held = down.held, moved = down.moved;
    end();
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { wrappedGo(dx < 0 ? 1 : -1, true); return; }
    if (held) return;                                   // a still hold only pauses
    if (moved || Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // a scroll / stray drag
    const r = stage.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
    if (f > 2 / 3) wrappedGo(1, true);
    else if (f < 1 / 3) wrappedGo(-1, true);
  });
  stage.addEventListener("pointercancel", end);
  // a long press on touch would open the callout menu instead of pausing
  stage.addEventListener("contextmenu", (e) => { if (down) e.preventDefault(); });
  // APG carousel: keyboard focus on the story pauses autoplay.
  stage.addEventListener("focus", () => { if (stage.matches(":focus-visible")) wrHold("focus", true); });
  stage.addEventListener("blur", () => wrHold("focus", false));
  stage.addEventListener("animationend", (e) => {
    if (e.animationName !== "wrFill" || !e.target.closest(".wr-seg.cur") || !wrPlaying()) return;
    const n = wrappedSlides(computeWrapped(wrappedYear)).length;
    if (wrappedSlide >= n - 1) { wrEnded = true; paintWrappedPlay(); return; }
    wrappedGo(1, false);
  });
}
// manual = the user moved the story (announced); autoplay steps are not.
function wrappedGo(dir, manual) {
  const w = computeWrapped(wrappedYear);
  const slides = wrappedSlides(w);
  const to = Math.max(0, Math.min(slides.length - 1, wrappedSlide + dir));
  if (to === wrappedSlide) return;
  wrappedSlide = to; wrEnded = false;
  drawWrappedSlide();
  if (manual) wrAnnounce();
}
// The polite live region lives outside the re-rendered view, so a year change
// (which rebuilds the view) updates a region assistive tech already watches.
function wrLiveNode() {
  let live = document.getElementById("wr-live");
  if (!live) {
    live = el("div", "sr-only");
    live.id = "wr-live";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    document.body.appendChild(live);
  }
  return live;
}
function wrAnnounce() {
  if (!document.getElementById("wr-stage")) return;
  const live = wrLiveNode();
  const w = computeWrapped(wrappedYear), slides = wrappedSlides(w);
  live.textContent = "Slide " + (wrappedSlide + 1) + " of " + slides.length + ": " + wrappedSummary(slides[wrappedSlide], w);
}
// ←/→/Space move the story — never from a text field, never while a control
// inside Wrapped (a year chip, Back / Next, an avatar) has focus, and Space
// never from any control at all (it activates it). The story itself is a
// focus stop that takes all three.
const WR_KEY_OWNERS = "button, a[href], input, select, textarea, summary, [role=button], [role=option], [tabindex]";
function wrappedKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== " ") return false;
  const a = document.activeElement;
  const stage = document.getElementById("wr-stage");
  if (!stage || !a) return false;
  if (a !== stage && a !== document.body) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return false;
    if (a.matches(WR_KEY_OWNERS) && (e.key === " " || a.closest("#view-wrapped"))) return false;
  }
  e.preventDefault();
  wrappedGo(e.key === "ArrowLeft" ? -1 : 1, true);
  return true;
}
function drawWrappedSlide() {
  const stage = document.getElementById("wr-stage");
  if (!stage) return;
  const slideEl = stage.querySelector("#wr-slide");
  if (!slideEl) return;
  const w = computeWrapped(wrappedYear);
  const slides = wrappedSlides(w);
  wrappedSlide = Math.max(0, Math.min(slides.length - 1, wrappedSlide));
  const s = slides[wrappedSlide];

  // Numeric bigs carry data-count so animateCounts() (shared helper) counts
  // them up; markup seeds the final value so no-JS/reduced-motion stays correct.
  const big = s.num != null
    ? `<div class="wr-big st" data-count="${s.num}">${esc(String(s.big))}</div>`
    : `<div class="wr-big st">${esc(String(s.big))}</div>`;

  let inner;
  if (s.kind === "intro") {
    inner = `<div class="wr-eyebrow st">${esc(s.sub)}</div>
      <div class="wr-big wr-big-year st">${esc(String(s.big))}</div>
      <div class="wr-tag st">${esc(s.label)}</div>`;
  } else if (s.kind === "outro") {
    inner = `<div class="wr-emoji giant st">${cmdIco("wrapped")}</div>
      <div class="wr-tag st">${esc(s.label)}</div>
      <div class="wr-sub st">${esc(s.sub)}</div>`;
  } else if (s.kind === "person") {
    const max = (s.podium[0] && s.podium[0][1]) || 1;
    const rows = s.podium.map(([id, c], k) => {
      const hue = personColor(id);
      return `<div class="pl-row st"><span class="pl-rank">0${k + 1}</span>
        ${pfpHtml(id, "width:46px;height:46px;font-size:16px")}
        <div class="pl-main"><div class="pl-name" style="--p:${esc(hue.p)}">${esc(nameOf(id))}</div>
          <div class="pl-track"><div class="pl-fill" data-w="${Math.round((c / max) * 100)}" style="--p:${esc(hue.p)};--f:${esc(hue.f)}"></div></div></div>
        <div class="pl-val" data-count="${c}">${fmtNum(c)}</div></div>`;
    }).join("");
    inner = `<div class="wr-eyebrow st">Your loudest voices</div>${big}
      <div class="wr-label st">${esc(s.label)}</div><div class="wr-sub st">${esc(s.sub)}</div>
      <div class="wr-people">${rows}</div>`;
  } else if (s.kind === "words") {
    const chips = s.list.map(([word, c], k) => `<span class="wr-wordchip${k === 0 ? " top" : ""}">${esc(word)} <b>${fmtNum(c)}</b></span>`).join("");
    inner = `<div class="wr-eyebrow st">${esc(s.label)}</div>
      <div class="wr-big wr-big-word st">${esc(String(s.big))}</div>
      <div class="wr-sub st">${esc(s.sub)}</div>
      <div class="wr-wordchips st">${chips}</div>`;
  } else if (s.kind === "star") {
    inner = `<div class="wr-emoji st">${cmdIco("wrapped")}</div>
      <div class="wr-tag st">Most-reacted message of ${w.year}</div>
      <div class="wr-sub st">${fmtNum(s.rc)} reaction${s.rc === 1 ? "" : "s"}</div>
      <div class="wr-star st" id="wr-star"></div>`;
  } else {
    // stat: the number leads (per the mock); a glyph shows only for the "emoji
    // of the year" slide, where the emoji itself is the data being celebrated.
    inner = `${s.emoji ? `<div class="wr-emoji${s.giant ? " giant" : ""} st">${s.emoji}</div>` : ""}
      ${s.big === s.emoji ? "" : big}
      <div class="wr-label st">${esc(s.label)}</div><div class="wr-sub st">${esc(s.sub)}</div>`;
  }

  // Swap backdrop + content, force reflow, then arm the staged entrance so the
  // .st rise animation re-triggers on every slide change.
  slideEl.className = "wr-slide " + (WR_BG[s.kind] || "wr-bg-vol");
  slideEl.innerHTML = `<div class="wr-inner">${inner}</div>`;
  void slideEl.offsetWidth;
  slideEl.classList.add("wr-anim");
  if (s.kind === "star") {
    const host = slideEl.querySelector("#wr-star");
    if (host) host.appendChild(renderMsg(s.i, { clickable: true }));
  }
  animateCounts(slideEl);
  animateWrappedFills(slideEl);
  paintWrappedChrome(slides.length);
}
// Grow the .pl-fill bars 0 → pct, staggered ~80ms (mock playSlide). Reduced
// motion or a hidden document (rAF/transitions unreliable) → final width now.
function animateWrappedFills(rootEl) {
  const fills = rootEl.querySelectorAll(".pl-fill");
  if (!fills.length) return;
  const instant = matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden;
  void rootEl.offsetWidth; // commit width:0 so the transition has a start frame
  fills.forEach((f, i) => {
    f.style.transitionDelay = instant ? "0s" : i * 0.08 + "s";
    f.style.width = f.dataset.w + "%";
  });
}
// Segmented progress (replaces the dots; non-interactive, aria-hidden —
// the live region says where you are) + context label + nav buttons.
function paintWrappedChrome(n) {
  const segs = document.getElementById("wr-segs");
  if (segs) {
    segs.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const sg = el("span", "wr-seg" + (i < wrappedSlide ? " done" : i === wrappedSlide ? " cur" : ""));
      sg.innerHTML = "<i></i>";
      segs.appendChild(sg);
    }
  }
  const ctx = document.getElementById("wr-ctx");
  if (ctx) ctx.textContent = wrappedSlide + 1 + " / " + n + " · " + wrappedYear + " Wrapped";
  const prev = document.getElementById("wr-prev");
  if (prev) prev.disabled = wrappedSlide === 0;
  const next = document.getElementById("wr-next");
  if (next) next.innerHTML = wrappedSlide === n - 1 ? "Restart" + WR_ICON.restart : "Next" + WR_ICON.next;
  paintWrappedPlay();
}
// A palette command or a calendar jump removes its dialog without restoring
// focus; this catches those so the story never stays paused behind nothing.
// It also runs on every toast and live-region append, which is cheap (no
// stage: early return; same button state: no repaint). Keep it for the jumps.
new MutationObserver(() => paintWrappedPlay()).observe(document.body, { childList: true });
// Autoplay classes on the stage + the Pause / Play button (hidden when
// reduced motion turns autoplay off). A hold or focus pauses the fill but
// doesn't flip the button — only the button's own choice (or the end) does.
function paintWrappedPlay() {
  const stage = document.getElementById("wr-stage");
  if (!stage) return;
  const allowed = wrAutoplayAllowed();
  stage.classList.toggle("wr-auto", allowed);
  stage.classList.toggle("wr-paused", allowed && !wrPlaying());
  const b = document.getElementById("wr-play");
  if (!b) return;
  b.hidden = !allowed;
  const on = !wrUserPaused && !wrEnded;
  const label = on ? "Pause" : "Play";
  // repaint only on a change: pressing the button blurs the story, and a
  // rebuilt button under the pointer never gets the click
  if (b.dataset.state === label) return;
  b.dataset.state = label;
  b.setAttribute("aria-label", label + " autoplay");
  b.title = label + " autoplay";
  b.innerHTML = (on ? WR_ICON.pause : WR_ICON.play) + '<span class="wr-btn-txt">' + label + "</span>";
}

/* ---- Keyboard shortcuts modal ------------------------------------------- */
function toggleKeyboardHelp() {
  const existing = document.querySelector(".kb-modal");
  if (existing) { existing.remove(); restoreFocus(existing); return; }
  const modal = el("div", "kb-modal");
  modal.innerHTML = `
    <div class="kb-content">
      <div class="kb-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="kb-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="kb-body">
        <div class="kb-row"><kbd>${MOD_KEY}</kbd> <kbd>K</kbd><span>Command palette — jump anywhere, search messages</span></div>
        <div class="kb-row"><kbd>/</kbd><span>Focus search</span></div>
        <div class="kb-row"><kbd>j</kbd> <kbd>k</kbd><span>Next / previous search result (↓ ↑ too) — with a result focused</span></div>
        <div class="kb-row"><kbd>c</kbd> <kbd>b</kbd><span>The focused result's context / bookmark it (Enter opens it)</span></div>
        <div class="kb-row"><kbd>Home</kbd> <kbd>End</kbd><span>Oldest / newest message in the Timeline</span></div>
        <div class="kb-row"><kbd>?</kbd><span>Show this help</span></div>
        <div class="kb-row"><kbd>Esc</kbd><span>Close palette / modal / lightbox / popover</span></div>
        <div class="kb-row"><kbd>←</kbd> <kbd>→</kbd><span>Navigate lightbox</span></div>
        <div class="kb-row"><kbd>Scroll</kbd><span>Zoom image in lightbox</span></div>
        <div class="kb-row"><kbd>★</kbd><span>Hover a message → bookmark, share, or peek context</span></div>
      </div>
      <div class="kb-footer">Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</div>
    </div>`;
  const closeKb = () => { modal.remove(); restoreFocus(modal); };
  modal.addEventListener("click", (e) => { if (e.target === modal) closeKb(); });
  modal.querySelector(".kb-close").onclick = closeKb;
  document.body.appendChild(modal);
  applyDialog(modal, "Keyboard shortcuts", { initial: ".kb-close" });
}

/* ---- User Profile Modal -------------------------------------------------- */
document.addEventListener("click", (e) => {
  const av = e.target.closest(".av-clickable");
  if (av && av.dataset.id) {
    e.stopPropagation();
    openProfileModal(av.dataset.id);
  }
});

function openProfileModal(id) {
  const existing = document.querySelector(".profile-modal");
  const inherit = existing ? existing._opener : undefined;   // replacing: keep the original opener
  const inheritHeld = existing ? existing._wrFocusHeld : undefined;   // ...and its keyboard-focus pause
  if (existing) existing.remove();

  const p = PARTS.find(x => x.id === id);
  if (!p) return;

  const modal = el("div", "profile-modal");

  modal.innerHTML = `
    <div class="profile-card">
      <div class="profile-cover">
        ${pfpHtml(id, "border:4px solid var(--bg-panel)")}
        <button class="profile-card-close" type="button" aria-label="Close profile">✕</button>
      </div>
      <div class="profile-info">
        <h2 class="profile-name">${esc(nameOf(id))}</h2>
        <div style="color:var(--text-dim); font-size:13px; font-family:ui-monospace,monospace;">id ${esc(id)}</div>

        <div class="profile-stat-row">
          <div class="profile-stat-item">
            <div class="profile-stat-val">${fmtNum(p.count)}</div>
            <div class="profile-stat-lbl">Messages</div>
          </div>
          <div class="profile-stat-item">
            <div class="profile-stat-val" data-stat="wpm">…</div>
            <div class="profile-stat-lbl">Words/Msg</div>
          </div>
          <div class="profile-stat-item">
            <div class="profile-stat-val" data-stat="vocab">…</div>
            <div class="profile-stat-lbl">Vocab Size</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const closeProfile = () => { modal.remove(); restoreFocus(modal); };
  modal.addEventListener("click", (e) => { if (e.target === modal) closeProfile(); });
  modal.querySelector(".profile-card-close").onclick = closeProfile;

  const avInner = modal.querySelector(".av");
  if (avInner) { avInner.classList.remove("av-clickable"); avInner.style.cursor = "default"; }

  document.body.appendChild(modal);
  applyDialog(modal, "Profile — " + nameOf(id), { initial: ".profile-card-close", opener: inherit, focusHeld: inheritHeld });

  // the stats-derived fields (words/msg, vocab, badges). On a cold STATS
  // cache computeStats() sweeps every message — synchronously that freezes the
  // tab on 134k-message archives before the modal can even paint. Warm cache:
  // fill in the same tick (no placeholder flash). Cold: paint the shell now,
  // run the sweep on the next macrotask. Same STATS object either way, so the
  // modal ends up identical and the Stats view reuses the memoized result.
  const fillStats = () => {
    if (!modal.isConnected) return; // closed before the sweep finished
    const s = computeStats();
    if (s.empty) return;
    modal.querySelector('[data-stat="wpm"]').textContent = s.yapperStats[id] ? s.yapperStats[id].toFixed(1) : "0";
    modal.querySelector('[data-stat="vocab"]').textContent = fmtNum(s.vocabStats[id] || 0);

    // exactly the awards the Stats grid shows this person winning (ties
    // included) — one list, one filter, never a badge for a hidden 0-value card.
    const badges = [];
    s.awards.forEach((a) => {
      if (a.ids.indexOf(id) < 0) return;
      const d = SUPERLATIVES.find((x) => x.key === a.key);
      badges.push({ icon: d.icon, text: d.title });
    });
    if (badges.length) {
      const wrap = el("div", "profile-badges");
      wrap.innerHTML = badges.map(b => `<div class="profile-badge"><i>${b.icon}</i> ${esc(b.text)}</div>`).join("");
      modal.querySelector(".profile-info").appendChild(wrap);
    }
  };
  if (STATS) fillStats(); else setTimeout(fillStats, 0);
}

/* ===========================================================================
   PINNED / BOOKMARKED MESSAGES VIEW
   ======================================================================== */
function renderPins() {
  const v = document.getElementById("view-pins");
  // newest pin action first keeps the most-recent bookmark on top of its group
  const ids = settings.pins.slice().reverse();

  // settings.pins is ONE global list, and message ids are globally unique
  // (real builds keep the original X message id — scripts/build-core.js
  // rawToRec; the sample generator shares one counter — scripts/make-sample.js),
  // so resolve pins across ALL visible conversations, not only through the
  // active conversation's ID2IDX (other chats' bookmarks used to be
  // silently dropped from this view and its export).
  const ignored = ignoredUserIds();
  const wanted = new Set(ids);
  const byConv = new Map();   // convId -> Map(msgId -> msg)
  visibleConvos().forEach((c) => {
    const hits = new Map();
    // without ignored people's reactions, as in that chat's own view
    (c.msgs || []).forEach((m) => { if (wanted.has(m.i) && !ignored.has(String(m.s))) hits.set(m.i, m.r ? withoutIgnored([m], ignored)[0] : m); });
    if (hits.size) byConv.set(c.id, hits);
  });

  // Active conversation's group first, the rest in picker order.
  const withPins = visibleConvos().filter((c) => byConv.has(c.id));
  const ordered = withPins.filter((c) => CONV && c.id === CONV.id)
    .concat(withPins.filter((c) => !(CONV && c.id === CONV.id)));
  let total = 0; byConv.forEach((hits) => { total += hits.size; });
  // pins whose message resolves nowhere (removed group / ignored sender) —
  // still stored, just not showable; said out loud instead of silently dropped
  const hidden = ids.length - total;
  const hiddenNote = () => el("div", "pins-hidden-note",
    fmtNum(hidden) + " bookmark" + (hidden === 1 ? "" : "s") + " not shown — from removed group chats or ignored people.");

  const sub = total
    ? fmtNum(total) + " bookmarked message" + (total === 1 ? "" : "s")
      + (ordered.length > 1 ? " across " + ordered.length + " chats" : "")
      + " · saved in this browser"
    : "Bookmark any message with the ★ button to keep it here.";
  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">Pinned</div>
      <div class="page-sub">${sub}</div>
    </div>
    <div class="page-body">
      ${total ? '<div class="pins-actions"><button class="pill" id="pins-export">↓ Export</button><button class="pill danger" id="pins-clear">✕ Clear all</button></div>' : ''}
      <div class="list" id="pins-list"></div>
    </div></div>`;

  const list = v.querySelector("#pins-list");
  if (!total) {
    list.appendChild(emptyState("pins", "No bookmarks yet.",
      "In the Timeline, hover a message (or tap its ⋯ on a phone) and choose ☆ to keep it here.", ["Open Timeline", () => setView("timeline")]));
    if (hidden > 0) list.appendChild(hiddenNote());
    return;
  }
  const frag = document.createDocumentFragment();
  ordered.forEach((c) => {
    const hits = byConv.get(c.id);
    const isActive = CONV && c.id === CONV.id;
    frag.appendChild(el("div", "pins-conv-head",
      esc(displayConvName(c)) + (isActive ? ' <span class="pins-conv-cur">this chat</span>' : "")));
    ids.forEach((id) => {
      if (!hits.has(id)) return;
      if (isActive && ID2IDX.has(id)) frag.appendChild(renderMsg(ID2IDX.get(id), { clickable: true }));
      else frag.appendChild(renderForeignPin(c, hits.get(id)));
    });
  });
  if (hidden > 0) frag.appendChild(hiddenNote());
  list.appendChild(frag);

  const exp = v.querySelector("#pins-export");
  if (exp) exp.onclick = () => {
    const lines = [];
    ordered.forEach((c) => {
      const hits = byConv.get(c.id);
      lines.push("== " + displayConvName(c) + " ==");
      ids.forEach((id) => { const m = hits.get(id); if (m) lines.push(exportLine(m, c)); });
      lines.push("");
    });
    downloadText("pinned-messages-" + todayKey() + ".txt", lines);
    toast("Exported " + fmtNum(total) + " bookmarks");
  };
  const clr = v.querySelector("#pins-clear");
  if (clr) clr.onclick = () => { if (!confirm("Remove all bookmarks?")) return; settings.pins = []; saveSettings(); renderPins(); toast("Cleared bookmarks"); };
}

// A pinned message from a conversation that is NOT active. renderMsg() can't be
// reused here: it renders by index into the active MSGS and wires index-based
// actions (context peek, lightbox, share card). This mirrors its card markup
// with the actions that make sense cross-chat; activating the row switches to
// that conversation and jumps to the message.
function renderForeignPin(conv, m, needles) {
  const wrap = el("div", "msg clickable");
  const who = (id) => nameIn(conv, id);   // names as that chat shows them
  const av = el("div", "av"); applyPfp(av, m.s, who(m.s)); wrap.appendChild(av);
  const body = el("div", "msg-body");
  const head = el("div", "msg-head");
  const nm = el("span", "msg-name"); nm.textContent = who(m.s); nm.style.color = personColor(m.s).p;
  const tm = el("span", "msg-time"); tm.textContent = DT.format(m.t);
  head.appendChild(nm); head.appendChild(tm); body.appendChild(head);

  const go = () => jumpToConvMsg(conv.id, m.i);

  body.appendChild(msgActions(wrap, m, { conv: conv.id }, ["jump", "link"]));

  const txt = (m.x || "").trim();
  if (txt) { const bubbleEl = el("div", "bubble"); bubbleEl.dir = "auto"; bubbleEl.innerHTML = renderText(m.x, m.u); highlightDOM(bubbleEl, needles); body.appendChild(bubbleEl); }
  if (m.m) {
    // no cross-conversation lightbox — media clicks just travel to the message
    const d = el("div", "media");
    if (m.k === "img") {
      const img = el("img"); img.loading = "lazy"; img.src = safeHref(m.m);
      img.alt = "Photo from " + who(m.s) + " · " + DT.format(m.t);
      d.appendChild(img);
    } else if (m.k === "vid") {
      const vd = document.createElement("video"); vd.src = safeHref(m.m); vd.controls = true; vd.preload = "none";
      vd.setAttribute("aria-label", "Video from " + who(m.s) + " · " + DT.format(m.t));
      vd.addEventListener("click", (e) => e.stopPropagation());
      d.appendChild(vd);
    } else {
      const a = urlChipEl(m.m, "media file");
      a.addEventListener("click", (e) => e.stopPropagation());
      d.appendChild(a);
    }
    appendMoreMedia(d, m, who(m.s));   // the message's other files
    body.appendChild(d);
  }
  if (m.r) body.appendChild(renderReacts(m.r, who));
  wrap.appendChild(body);

  cardActivation(wrap, go);
  return wrap;
}

/* ===========================================================================
   CONTEXT PEEK — surrounding messages without leaving the current view
   ======================================================================== */
function openContextPeek(center) {
  const prevCtx = document.querySelector(".ctx-modal");
  const inherit = prevCtx ? prevCtx._opener : undefined;   // replacing: keep the original opener
  const inheritHeld = prevCtx ? prevCtx._wrFocusHeld : undefined;   // ...and its keyboard-focus pause
  document.querySelectorAll(".ctx-modal").forEach((m) => m.remove());
  const RADIUS = 5;
  const lo = Math.max(0, center - RADIUS), hi = Math.min(N - 1, center + RADIUS);
  const modal = el("div", "ctx-modal");
  const card = el("div", "ctx-card");
  const head = el("div", "ctx-head");
  head.innerHTML = '<div class="ctx-title">Conversation context</div>';
  const closeCtx = () => { modal.remove(); restoreFocus(modal); };
  const close = btnEl("kb-close", "✕", "Close"); close.onclick = closeCtx;
  head.appendChild(close);
  card.appendChild(head);

  const bodyEl = el("div", "ctx-body");
  let prevDay = null, prevSender = null, prevT = 0;
  for (let i = lo; i <= hi; i++) {
    const dk = dayKey(MSGS[i].t);
    if (dk !== prevDay) { bodyEl.appendChild(renderDaySep(MSGS[i].t)); prevDay = dk; prevSender = null; prevT = 0; }
    const consecutive = (prevSender === MSGS[i].s) && (MSGS[i].t - prevT < 300000);
    const node = renderMsg(i, { context: true, consecutive });
    if (i === center) node.classList.add("ctx-center");
    bodyEl.appendChild(node);
    prevSender = MSGS[i].s; prevT = MSGS[i].t;
  }
  card.appendChild(bodyEl);

  const foot = el("div", "ctx-foot");
  const openBtn = el("button", "btn sm", "Open in timeline ↗");
  openBtn.onclick = () => { modal.remove(); jumpTo(center); };
  foot.appendChild(openBtn);
  card.appendChild(foot);

  modal.appendChild(card);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeCtx(); });
  document.body.appendChild(modal);
  applyDialog(modal, "Conversation context", { initial: ".kb-close", opener: inherit, focusHeld: inheritHeld });
  const c = bodyEl.querySelector(".ctx-center");
  if (c) c.scrollIntoView({ block: "center" });
}

/* ===========================================================================
   SHARE CARDS — a message, a Hall of Fame card or a Wrapped slide as a PNG.
   ONE pipeline: a builder turns what is shared into a card model (a
   list of blocks), drawShareCard() lays the blocks out and paints them on a
   canvas in the live theme + accent, and the Share dialog previews it with a
   "Hide names" toggle and saves it. Fully offline: canvas → Blob →
   a[download]; nothing is requested, written to the URL or logged, and the
   file name carries ids / dates only.
   ======================================================================== */
const RE_RTL_FIRST = /^[^\p{L}]*[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const { wrapText, createRedactor } = GCAShared;
const SHARE_W = 720, SHARE_PAD = 48, SHARE_DPR = 2;
// "Hide names", remembered per viewer and per kind of card: Wrapped slides
// that rank people start hidden, everything else starts shown.
const SHARE_REDACT_KEY = "gca.shareRedact";
function shareRedactPref(kind, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(SHARE_REDACT_KEY) || "{}");
    if (v && typeof v[kind] === "boolean") return v[kind];
  } catch (e) { /* blocked or corrupt storage → the default */ }
  return fallback;
}
function saveShareRedactPref(kind, on) {
  try {
    let v = {};
    try { v = JSON.parse(localStorage.getItem(SHARE_REDACT_KEY) || "{}") || {}; } catch (e) { v = {}; }
    if (!isPlainObj(v)) v = {};
    v[kind] = !!on;
    localStorage.setItem(SHARE_REDACT_KEY, JSON.stringify(v));
  } catch (e) { /* storage blocked: the choice lasts for this dialog only */ }
}

// Canvas can't read CSS custom properties or color-mix(): every colour is
// resolved through a probe element in the live theme, then handed to the
// canvas as rgb()/rgba().
let shareProbe = null;
function canvasColor(expr) {
  if (!shareProbe) { shareProbe = el("span"); shareProbe.setAttribute("aria-hidden", "true"); shareProbe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"; }
  if (!shareProbe.isConnected) document.body.appendChild(shareProbe);
  shareProbe.style.color = "";
  shareProbe.style.color = expr;
  const c = getComputedStyle(shareProbe).color;
  const m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(c);
  if (m) return "rgba(" + [m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, +v)) * 255)).join(", ") + ", " + (m[4] != null ? +m[4] : 1) + ")";
  return c;
}
function shareTheme() {
  const v = (n) => canvasColor("var(" + n + ")");
  return {
    page: v("--bg-page"), card: v("--bg-card"), text: v("--text"), dim: v("--text-dim"), faint: v("--text-faint"),
    accent: v("--accent"), accentText: v("--accent-text"), border: v("--border"),
    tint: canvasColor("color-mix(in srgb, var(--accent) 14%, var(--bg-page))"),
    glow: canvasColor("color-mix(in srgb, var(--accent) 40%, transparent)"),
    clear: canvasColor("color-mix(in srgb, var(--accent) 0%, transparent)"),
    track: canvasColor("color-mix(in srgb, var(--text) 12%, transparent)"),
    neutral: canvasColor("color-mix(in srgb, var(--text) 26%, var(--bg-card))"),
    font: getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "system-ui, sans-serif",
  };
}
// Everyone a shared text could name: this chat's members plus anyone named in
// settings or local.js (a message can mention someone from another chat).
function shareRedactor() {
  const ids = new Set(PARTS.map((p) => p.id));
  Object.keys(settings.names || {}).forEach((id) => ids.add(id));
  Object.keys(LOCAL_NAMES).forEach((id) => ids.add(id));
  return createRedactor([...ids].map((id) => ({ id, names: personNames(id) })));
}
// A person on a card: name, name colour and avatar. Redacted → "Person A"
// in the text colour on a plain neutral disc (no photo, no initials).
function sharePerson(id, R, T) {
  if (R) return { name: R.label(id), color: T.text, av: { fill: T.neutral } };
  const pc = personColor(id), name = nameOf(id);
  const photo = sanitizePhoto(PFPS[id]);
  // only an uploaded data: URL photo — a file path would taint the canvas
  // under file:// and break toBlob()
  return { name, color: canvasColor(pc.p), av: { fill: canvasColor(pc.f), initials: initials(name), photo: photo.startsWith("data:") ? photo : null } };
}
// A message's text as it reads on screen (t.co links by their display URL),
// line breaks kept.
function shareText(m) {
  let x = m.x || "";
  if (Array.isArray(m.u)) for (const u of m.u) if (u && u.s && (u.d || u.e)) x = x.split(u.s).join(u.d || u.e);
  return x.trim();
}
function shareBrand(R) {
  const b = R ? "" : ((document.getElementById("brand-title") || {}).textContent || "").trim();
  return b || "Group Chat Archive";
}
const shareFileId = (s) => String(s).replace(/[^\w-]+/g, "").slice(0, 40) || "card";

// Card model for a message (Hall of Fame: with its rank).
function shareModelMessage(i, R, T, hof) {
  const m = MSGS[i];
  const blocks = [];
  if (hof) blocks.push({ t: "eyebrow", text: "#" + hof.rank + " · Hall of Fame" + (hof.year && hof.year !== "all" ? " " + hof.year : "") });
  const text = shareText(m);
  blocks.push({ t: "message", who: sharePerson(m.s, R, T), meta: DT.format(m.t), text: R ? R.text(text) : text });
  const rc = m.r ? m.r.length : 0;
  if (rc) blocks.push({ t: "meta", text: "🔥 " + plural(rc, "reaction") });
  return { align: "left", blocks, footer: shareBrand(R), file: (hof ? "hall-of-fame-" : "message-") + shareFileId(m.i) };
}
// Card model for Wrapped slide k (the same facts the slide shows).
function shareModelWrapped(s, w, k, R, T) {
  const tx = (x) => (R ? R.text(String(x)) : String(x));
  const B = [];
  if (s.kind === "intro") {
    B.push({ t: "eyebrow", text: "A year in the group chat" }, { t: "big", text: String(w.year) }, { t: "label", text: "Wrapped" });
  } else if (s.kind === "outro") {
    B.push({ t: "eyebrow", text: "Wrapped" }, { t: "label", text: tx(s.label) });
  } else if (s.kind === "person") {
    const rows = s.podium.map(([id, c]) => ({ who: sharePerson(id, R, T), value: c }));   // ranks first: Person A is #1
    const top = rows[0].who.name;
    B.push({ t: "eyebrow", text: "Your loudest voices" }, { t: "big", text: String(s.big) },
      { t: "label", text: "messages from " + top }, { t: "sub", text: top + " was the most active this year" }, { t: "rank", rows });
  } else if (s.kind === "words") {
    B.push({ t: "eyebrow", text: tx(s.label) }, { t: "big", text: tx(s.big) }, { t: "sub", text: tx(s.sub) },
      { t: "chips", items: s.list.map(([word, c]) => tx(word) + "  " + fmtNum(c)) });
  } else if (s.kind === "star") {
    const m = MSGS[s.i], text = shareText(m);
    B.push({ t: "eyebrow", text: "Most-reacted message of " + w.year }, { t: "sub", text: plural(s.rc, "reaction") },
      { t: "message", who: sharePerson(m.s, R, T), meta: DT.format(m.t), text: R ? R.text(text) : text });
  } else {
    if (s.emoji && s.big === s.emoji) B.push({ t: "emoji", text: s.emoji });
    else B.push({ t: "big", text: String(s.big) });
    B.push({ t: "label", text: tx(s.label) }, { t: "sub", text: tx(s.sub) });
  }
  return { align: "center", minH: 900, blocks: B, footer: shareBrand(R) + " · " + w.year + " Wrapped", file: "wrapped-" + w.year + "-" + (k + 1) };
}

// Decode the (data: URL) photos a model needs, then draw. Resolves the model,
// or null without drawing when `isCurrent()` says a newer render took over
// (a slow photo must never paint over a later, redacted preview).
function renderShareCard(canvas, model, T, isCurrent) {
  const avs = [];
  model.blocks.forEach((b) => { if (b.who) avs.push(b.who.av); if (b.rows) b.rows.forEach((r) => avs.push(r.who.av)); });
  return Promise.all(avs.filter((a) => a.photo).map((a) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { a.img = img; res(); };
    img.onerror = () => res();     // a broken photo falls back to the disc
    img.src = a.photo;
  }))).then(() => {
    if (isCurrent && !isCurrent()) return null;
    drawShareCard(canvas, model, T);
    return model;
  });
}
// The one drawing pipeline: measure every block (text wrapped by
// GCAShared.wrapText between graphemes), size the canvas, paint the
// background, then each block top to bottom. Every string goes through txt().
function drawShareCard(canvas, model, T) {
  const W = SHARE_W, PAD = SHARE_PAD, IN = W - 2 * PAD;
  const center = model.align === "center";
  const ctx = canvas.getContext("2d");
  const F = (wt, px) => wt + " " + px + "px " + T.font;
  const width = (s, f) => { ctx.font = f; return ctx.measureText(s).width; };
  const wrap = (s, f, w, max) => wrapText(s, w, (x) => width(x, f), { maxLines: max }).lines;
  const one = (s, f, w) => wrap(String(s).replace(/\s+/g, " "), f, w, 1)[0] || "";
  const txt = (s, x, y, f, color, align) => {
    if (!s) return;
    ctx.font = f; ctx.fillStyle = color; ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  };
  const rrect = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  const disc = (av, cx, cy, r) => {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (av.img) { ctx.clip(); ctx.drawImage(av.img, cx - r, cy - r, r * 2, r * 2); }
    else {
      ctx.fillStyle = av.fill; ctx.fill();
      if (av.initials) { ctx.font = F(700, Math.round(r * 0.8)); ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(av.initials, cx, cy + 1); }
    }
    ctx.restore();
  };
  const ax = center ? W / 2 : PAD, al = center ? "center" : "left";

  const layout = (b) => {
    if (b.t === "eyebrow") {
      const f = F(700, 15), lines = wrap(b.text.toUpperCase(), f, IN, 2);
      return { h: lines.length * 22 + 12, draw: (y) => lines.forEach((ln, k) => txt(ln, ax, y + 16 + k * 22, f, T.dim, al)) };
    }
    if (b.t === "big") {
      let px = 120;
      while (px > 44 && width(b.text, F(800, px)) > IN) px -= 4;
      const f = F(800, px), text = width(b.text, f) > IN ? one(b.text, f, IN) : b.text;
      return { h: Math.round(px * 1.12) + 6, draw: (y) => {
        const g = ctx.createLinearGradient(0, y, 0, y + px);
        g.addColorStop(0, T.text); g.addColorStop(1, T.accentText);
        txt(text, ax, y + px * 0.94, f, g, al);
      } };
    }
    if (b.t === "emoji") { const f = F(400, 112); return { h: 136, draw: (y) => txt(b.text, ax, y + 112, f, T.text, al) }; }
    if (b.t === "label" || b.t === "sub" || b.t === "meta") {
      const st = { label: [800, 30, 38, 3, T.text], sub: [400, 20, 28, 3, T.dim], meta: [700, 18, 26, 1, T.accentText] }[b.t];
      const f = F(st[0], st[1]), lines = wrap(b.text, f, IN, st[3]);
      return { h: lines.length * st[2] + 10, draw: (y) => lines.forEach((ln, k) => txt(ln, ax, y + st[1] + k * st[2], f, st[4], al)) };
    }
    if (b.t === "message") {
      // left cards: avatar, name + time, body indented under the name (as
      // before); Wrapped: the same on a panel, the body full width
      const AV = 64, inset = center ? 24 : 0, x0 = PAD + inset, inner = IN - 2 * inset;
      const tx = x0 + AV + 20, tw = inner - AV - 20;
      const bf = F(400, 26), bodyX = center ? x0 : tx, bodyW = center ? inner : tw;
      const lines = b.text ? wrap(b.text, bf, bodyW, center ? 8 : 12) : [];
      const rtl = RE_RTL_FIRST.test(b.text || "");
      const h = inset * 2 + AV + (lines.length ? 18 + lines.length * 38 : 0) + 8;
      return { h: h + 12, draw: (y) => {
        if (center) { rrect(PAD, y, IN, h, 18); ctx.fillStyle = T.card; ctx.fill(); ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.stroke(); }
        const y0 = y + inset;
        disc(b.who.av, x0 + AV / 2, y0 + AV / 2, AV / 2);
        txt(one(b.who.name, F(700, 27), tw), tx, y0 + 28, F(700, 27), b.who.color);
        txt(b.meta, tx, y0 + 54, F(400, 17), T.faint);
        // text whose first letter is RTL is drawn right-to-left from
        // the right edge, as dir="auto" does in the page
        if (rtl) ctx.direction = "rtl";
        lines.forEach((ln, k) => txt(ln, rtl ? bodyX + bodyW : bodyX, y0 + AV + 18 + 28 + k * 38, bf, T.text, rtl ? "right" : "left"));
        ctx.direction = "ltr";
      } };
    }
    if (b.t === "rank") {
      const RW = Math.min(IN, 540), x0 = (W - RW) / 2, max = Math.max(1, ...b.rows.map((r) => r.value));
      return { h: b.rows.length * 72 + 14, draw: (y) => b.rows.forEach((r, k) => {
        const ry = y + 14 + k * 72, nx = x0 + 44 + 46 + 16, vw = 96, tw = RW - (nx - x0) - vw;
        txt("0" + (k + 1), x0, ry + 30, F(700, 18), T.dim);
        disc(r.who.av, x0 + 44 + 23, ry + 23, 23);
        txt(one(r.who.name, F(700, 22), tw), nx, ry + 20, F(700, 22), r.who.color);
        rrect(nx, ry + 32, tw, 12, 6); ctx.fillStyle = T.track; ctx.fill();
        rrect(nx, ry + 32, Math.max(12, tw * r.value / max), 12, 6); ctx.fillStyle = r.who.av.img ? T.accent : (r.who.av.initials ? r.who.av.fill : T.accent); ctx.fill();
        txt(fmtNum(r.value), x0 + RW, ry + 30, F(800, 22), T.text, "right");
      }) };
    }
    if (b.t === "chips") {
      const f = F(600, 18), padX = 16, ch = 42, gap = 10, rows = [[]];
      let rw = 0;
      b.items.forEach((s, k) => {
        const w = Math.min(IN, width(s, f) + padX * 2);
        if (rows[rows.length - 1].length && rw + gap + w > IN) { rows.push([]); rw = 0; }
        rows[rows.length - 1].push({ s, w, k }); rw += (rw ? gap : 0) + w;
      });
      return { h: rows.length * (ch + gap) + 10, draw: (y) => rows.forEach((row, ri) => {
        let x = (W - row.reduce((a, c) => a + c.w, 0) - gap * (row.length - 1)) / 2;
        const cy = y + 10 + ri * (ch + gap);
        row.forEach((c) => {
          rrect(x, cy, c.w, ch, ch / 2); ctx.fillStyle = T.card; ctx.fill();
          ctx.strokeStyle = c.k === 0 ? T.accent : T.border; ctx.lineWidth = c.k === 0 ? 2 : 1; ctx.stroke();
          txt(one(c.s, f, c.w - padX * 2), x + c.w / 2, cy + 27, f, T.text, "center");
          x += c.w + gap;
        });
      }) };
    }
    return { h: 0, draw: () => {} };
  };

  const parts = model.blocks.map(layout);
  const content = parts.reduce((a, p) => a + p.h, 0), FOOT = 54;
  const H = Math.ceil(center ? Math.max(model.minH || 0, PAD + content + FOOT + PAD) : PAD + content + FOOT);
  canvas.width = W * SHARE_DPR; canvas.height = H * SHARE_DPR;
  ctx.setTransform(SHARE_DPR, 0, 0, SHARE_DPR, 0, 0);
  if (center) {
    ctx.fillStyle = T.page; ctx.fillRect(0, 0, W, H);
    const lg = ctx.createLinearGradient(0, 0, W * 0.45, H);
    lg.addColorStop(0, T.tint); lg.addColorStop(0.74, T.page);
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W * 0.78, H * 0.05, 0, W * 0.78, H * 0.05, W * 0.8);
    rg.addColorStop(0, T.glow); rg.addColorStop(1, T.clear);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = T.card; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.accent; ctx.fillRect(0, 0, 6, H);
  }
  let y = center ? Math.max(PAD, (H - FOOT - content) / 2) : PAD;
  parts.forEach((p) => { p.draw(y); y += p.h; });
  txt("— " + model.footer, ax, H - 26, F(500, 15), T.faint, al);
}

// The Share dialog (a modal-stack layer): live preview, "Hide names", Copy
// image (where the browser can put a PNG on the clipboard) and Download PNG.
// build(redact, theme) → card model. opts: { kind, defaultRedact }.
function openShareDialog(build, opts) {
  opts = opts || {};
  document.querySelectorAll(".share-modal").forEach((m) => { if (m._close) m._close(); else m.remove(); });
  const modal = el("div", "share-modal");
  const card = el("div", "share-card");
  card.innerHTML = `<div class="ctx-head"><div class="ctx-title">Share image</div></div>
    <div class="share-body"><canvas class="share-preview" role="img" aria-label="Preview of the image"></canvas></div>
    <div class="share-foot">
      <label class="share-redact"><input type="checkbox" class="share-redact-cb"><span>Hide names &amp; photos</span></label>
      <div class="share-acts">
        <button type="button" class="btn share-copy">Copy image</button>
        <button type="button" class="btn primary share-dl">Download PNG</button>
      </div>
    </div>`;
  const close = btnEl("kb-close", "✕", "Close");
  card.querySelector(".ctx-head").appendChild(close);
  modal.appendChild(card);
  const cv = card.querySelector("canvas"), cb = card.querySelector(".share-redact-cb");
  const kind = opts.kind || "card";
  cb.checked = shareRedactPref(kind, !!opts.defaultRedact);
  let ready = null, gen = 0;
  const paint = () => {
    const g = ++gen;
    const T = shareTheme();
    const model = build(cb.checked, T, cb.checked ? shareRedactor() : null);
    // data-rendered = the number of the render now on the canvas
    ready = renderShareCard(cv, model, T, () => g === gen).then((m) => { if (m) cv.dataset.rendered = String(g); return m; });
    return ready;
  };
  // The canvas as a PNG once the LATEST render has drawn: if the toggle
  // changed while waiting, wait for the newer render instead.
  const toBlob = () => {
    const p = ready;
    return p.then((model) => {
      if (p !== ready || !model) return toBlob();
      return new Promise((res) => cv.toBlob((blob) => res({ blob, model }), "image/png"));
    });
  };
  modal._close = () => {
    modal.remove();
    restoreFocus(modal);
  };
  close.onclick = modal._close;
  modal.addEventListener("click", (e) => { if (e.target === modal) modal._close(); });
  cb.onchange = () => { saveShareRedactPref(kind, cb.checked); paint(); };
  card.querySelector(".share-dl").onclick = () => toBlob().then(({ blob, model }) => {
    if (!blob) { toast("Could not render image"); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = model.file + ".png"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Saved image");
  }).catch(() => toast("Could not render image"));
  const copyBtn = card.querySelector(".share-copy");
  const canCopy = typeof ClipboardItem === "function" && navigator.clipboard && typeof navigator.clipboard.write === "function";
  copyBtn.hidden = !canCopy;
  copyBtn.onclick = () => {
    const item = new ClipboardItem({ "image/png": toBlob().then(({ blob }) => blob) });
    navigator.clipboard.write([item]).then(() => toast("Copied image")).catch(() => toast("Couldn't copy the image — use Download PNG"));
  };
  document.body.appendChild(modal);
  applyDialog(modal, "Share image", { initial: ".share-dl", opener: opts.opener });
  paint();
  return modal;
}
function shareMessage(i, hof, opener) {
  const m = MSGS[i];
  if (!m || !(m.x || "").trim()) { toast("Nothing to share"); return; }
  openShareDialog((redact, T, R) => shareModelMessage(i, R, T, hof), { kind: hof ? "hof" : "message", defaultRedact: false, opener: opener && opener.tabIndex >= 0 ? opener : undefined });
}
function shareWrappedSlide() {
  const w = computeWrapped(wrappedYear), slides = wrappedSlides(w), k = wrappedSlide, s = slides[k];
  if (!s) return;
  // a slide that ranks people starts with names hidden
  openShareDialog((redact, T, R) => shareModelWrapped(s, w, k, R, T),
    { kind: s.kind === "person" ? "wrapped-ranking" : "wrapped", defaultRedact: s.kind === "person" });
}

/* ===========================================================================
   JUMP TO DATE
   ======================================================================== */
// every typed date goes through GCAShared.parseJumpDate (the
// same parser as before:/after:), so "2021-06", "June 2021" and "Jan 7 2024"
// all work, and an impossible date is rejected instead of rolled over.
// Returns true if it navigated.
const DATE_HINT = "Try 2021-06-14, June 2021, Jan 7 2024 or 6/14/2021 (month/day/year)";
const DATE_ORDER_HINT = "Use YYYY-MM-DD or Jan 7 2024";
// The message for a parseJumpDate error: an impossible date, or a day-first
// slashed date (slashed dates are read month/day/year).
function dateErrorText(raw, p) {
  return p.error === "order" ? raw + " isn't month/day/year. " + DATE_ORDER_HINT : "No such date: " + raw;
}
function jumpToDate(input) {
  const p = GCAShared.parseJumpDate(String(input), CLOCK);
  if (!p) { toast("Not a date. " + DATE_HINT); return false; }
  if (p.error) { toast(dateErrorText(String(input).trim(), p)); return false; }
  return jumpToPeriod(p);
}
// Jump to the first message of a parsed period ([p.start, p.end) in the
// configured zone) and say honestly where that landed: outside the archive it
// clamps to the first / latest message, and an empty period lands on the next
// message after it — never a bare "Jumped to <date>" that isn't true.
function jumpToPeriod(p) {
  if (!N) return false;
  const first = MSGS[0].t, last = MSGS[N - 1].t;
  let idx, msg;
  if (p.end <= first) { idx = 0; msg = "No messages before " + dShort.format(first) + " — jumped to the first one"; }
  else if (p.start > last) { idx = N - 1; msg = "No messages after " + dShort.format(last) + " — jumped to the latest one"; }
  else {
    idx = Math.min(indexAtOrAfter(p.start), N - 1);
    msg = MSGS[idx].t < p.end ? "Jumped to " + p.label
      : "No messages " + (p.unit === "day" ? "on " : "in ") + p.label + " — jumped to the next one, " + dShort.format(MSGS[idx].t);
  }
  jumpTo(idx);
  toast(msg);
  return true;
}

/* ===========================================================================
   CALENDAR — year / month scrubber + month heatmap
   ======================================================================== */
/* The Timeline's "Jump to date" (and the palette's "Browse by date") opens a
   dialog to browse and jump through history:
     - a typed-date box (GCAShared.parseJumpDate, like the palette);
     - a year strip and a month strip whose bars are message volume — the
       year / month scrubber; arrows move the selection (by month across years
       in the month strip), which re-draws the day grid;
     - a month heatmap: one named button per day ("Saturday, January 7, 2023:
       7 messages"), shaded by volume (lv0 none … lv4 busiest, sqrt scale
       against the archive's busiest day). Arrow keys move by day / week,
       Page Up / Down by month, Home / End to the month's first / last day,
       Enter jumps (closing the dialog) through jumpToPeriod, which says
       honestly where it landed.
   Everything comes from timeAgg() — the cached per-conversation time index,
   so days are the CONFIGURED zone's days (incl. "local") and opening it costs
   no per-message work. Roving tabindex: each strip / grid is one Tab stop. */
const MON_LONG = GCAShared.MONTH_NAMES;
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// zoned day number <-> calendar fields (pure UTC arithmetic on day numbers)
const dnOf = (y, mo, d) => Math.floor(Date.UTC(y, mo, d) / DAY_MS);
function ymdOf(dn) { const w = new Date(dn * DAY_MS); return { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), dow: w.getUTCDay() }; }
function calData() {
  const agg = timeAgg();
  if (!agg.cal) {
    const months = new Map();   // year*12+month -> count
    let maxMonth = 0;
    for (const [k, c] of agg.monthArr) {
      const y = +k.slice(0, 4), mo = +k.slice(5, 7) - 1;
      months.set(y * 12 + mo, c);
      if (c > maxMonth) maxMonth = c;
    }
    let maxDay = 0;
    for (let k = 0; k < agg.dayCounts.length; k++) if (agg.dayCounts[k] > maxDay) maxDay = agg.dayCounts[k];
    const years = new Map();
    for (const [mk, c] of months) years.set(Math.floor(mk / 12), (years.get(Math.floor(mk / 12)) || 0) + c);
    let ys = [...years.keys()].sort((a, b) => a - b);
    // A corrupt outlier timestamp can stretch the span to centuries: list
    // every year in a normal span, only the years with messages otherwise.
    if (ys.length && ys[ys.length - 1] - ys[0] <= 60) { const all = []; for (let y = ys[0]; y <= ys[ys.length - 1]; y++) all.push(y); ys = all; }
    else ys = ys.filter((y) => years.get(y));
    agg.cal = { months, maxMonth, maxDay, years, yearList: ys };
  }
  return agg.cal;
}
function dayCount(dn) {
  const agg = timeAgg(), k = dn - agg.dayMin;
  return k >= 0 && k < agg.dayCounts.length ? agg.dayCounts[k] : 0;
}
const countLbl = (n) => (n ? plural(n, "message") : "no messages");
function openCalendar() {
  if (!N) return;
  const prev = document.querySelector(".cal-modal");
  if (prev) { prev.remove(); restoreFocus(prev); }
  closeMsgActs();
  const C = calData(), TI = timeIndex();
  // Start on the day being read in the Timeline, else the newest message's day.
  let i0 = N - 1;
  if (curView === "timeline") { const p = timelineFirstVisible(); if (p && !p.end) i0 = p.idx; }
  const st = { dn: TI.day[i0] };
  const firstDn = dnOf(C.yearList[0], 0, 1), lastDn = dnOf(C.yearList[C.yearList.length - 1], 11, 31);
  const modal = el("div", "cal-modal");
  modal.innerHTML = `<div class="cal-card">
      <div class="cal-head"><h2 class="cal-title" id="cal-title">Jump to date</h2><button class="cal-close" type="button" aria-label="Close">✕</button></div>
      <form class="cal-form" novalidate><input class="cal-input" type="text" aria-label="Date to jump to" placeholder="2021-06-14, June 2021, Jan 7 2024" autocomplete="off" spellcheck="false"><button class="btn primary sm cal-go" type="submit">Go</button></form>
      <div class="cal-msg" role="status"></div>
      <div class="cal-years" role="group" aria-label="Year"></div>
      <div class="cal-months" role="group" aria-label="Month"></div>
      <div class="cal-dow" aria-hidden="true">${DOW_LONG.map((d) => "<span>" + d.slice(0, 2) + "</span>").join("")}</div>
      <div class="cal-days" role="group" aria-describedby="cal-hint"></div>
      <div class="cal-hint" id="cal-hint">Arrow keys move by day · Page Up / Down by month · Enter jumps</div>
      <div class="cal-foot"><span class="cal-range"></span><button class="btn primary sm cal-month-go" type="button"></button></div>
    </div>`;
  const $ = (q) => modal.querySelector(q);
  const yearsEl = $(".cal-years"), monthsEl = $(".cal-months"), daysEl = $(".cal-days"), msgEl = $(".cal-msg"), monthGo = $(".cal-month-go");
  $(".cal-range").textContent = "Messages from " + dShort.format(MSGS[0].t) + " to " + dShort.format(MSGS[N - 1].t);
  const close = () => { modal.remove(); restoreFocus(modal); };
  const go = (p) => { modal.remove(); jumpToPeriod(p); };
  const periodOf = (key) => GCAShared.parseJumpDate(key, CLOCK);
  const p2 = (n) => String(n).padStart(2, "0");

  function drawYears() {
    const { y } = ymdOf(st.dn);
    yearsEl.replaceChildren(...C.yearList.map((yy) => {
      const b = el("button", "cal-yr"); b.type = "button"; b.textContent = String(yy);
      b.dataset.y = yy; b.setAttribute("aria-pressed", yy === y ? "true" : "false");
      b.setAttribute("aria-label", yy + ": " + countLbl(C.years.get(yy) || 0));
      b.tabIndex = yy === y ? 0 : -1;
      return b;
    }));
    const on = yearsEl.querySelector('[aria-pressed="true"]');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function drawMonths() {
    const { y, mo } = ymdOf(st.dn);
    monthsEl.replaceChildren(...MON_LONG.map((name, m) => {
      const c = C.months.get(y * 12 + m) || 0;
      const b = el("button", "cal-mo"); b.type = "button"; b.dataset.mo = m;
      b.setAttribute("aria-pressed", m === mo ? "true" : "false");
      b.setAttribute("aria-label", name + " " + y + ": " + countLbl(c));
      b.tabIndex = m === mo ? 0 : -1;
      const bar = el("span", "cal-bar"); bar.setAttribute("aria-hidden", "true");
      if (c) bar.style.setProperty("--h", Math.max(8, Math.round(100 * Math.sqrt(c / C.maxMonth))) + "%");
      if (!c) bar.classList.add("cal-bar-0");
      const lb = el("span", "cal-mo-lbl"); lb.textContent = name.slice(0, 3);
      b.append(bar, lb);
      return b;
    }));
    monthGo.textContent = "Jump to " + MON_LONG[mo] + " " + y;
    daysEl.setAttribute("aria-label", MON_LONG[mo] + " " + y);
  }
  function drawDays() {
    const { y, mo } = ymdOf(st.dn);
    const first = dnOf(y, mo, 1), dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const cells = [];
    for (let k = 0; k < ymdOf(first).dow; k++) { const pad = el("span", "cal-pad"); pad.setAttribute("aria-hidden", "true"); cells.push(pad); }
    for (let d = 1; d <= dim; d++) {
      const dn = first + d - 1, c = dayCount(dn);
      const lv = c ? Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(c / C.maxDay)))) : 0;
      const b = el("button", "cal-d lv" + lv); b.type = "button"; b.dataset.dn = dn; b.textContent = String(d);
      b.setAttribute("aria-label", DOW_LONG[ymdOf(dn).dow] + ", " + MON_LONG[mo] + " " + d + ", " + y + ": " + countLbl(c));
      b.tabIndex = dn === st.dn ? 0 : -1;
      cells.push(b);
    }
    daysEl.replaceChildren(...cells);
  }
  function draw(focusSel) {
    drawYears(); drawMonths(); drawDays();
    if (focusSel) { const f = modal.querySelector(focusSel); if (f) f.focus(); }
  }
  // Move the selected day; re-draws only when the month changes.
  // With an outlier only years with messages are listed: a step that leaves a
  // listed year lands in the nearest listed year in that direction (its
  // December going back, its January going forward, same day clamped), so the
  // year strip always has a selected button and a Tab stop.
  const dimOf = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  function snapListed(dn, dir) {
    const { y, d } = ymdOf(dn);
    if (!dir || C.yearList.indexOf(y) >= 0) return dn;
    const ys = C.yearList.filter((x) => (dir < 0 ? x < y : x > y));
    if (!ys.length) return st.dn;
    const ny = dir < 0 ? ys[ys.length - 1] : ys[0], nmo = dir < 0 ? 11 : 0;
    return dnOf(ny, nmo, Math.min(d, dimOf(ny, nmo)));
  }
  function moveDay(dn) {
    dn = Math.max(firstDn, Math.min(lastDn, dn));
    dn = snapListed(dn, Math.sign(dn - st.dn));
    const a = ymdOf(st.dn), b = ymdOf(dn);
    st.dn = dn;
    if (a.y !== b.y || a.mo !== b.mo) draw();
    daysEl.querySelectorAll(".cal-d").forEach((n) => { n.tabIndex = +n.dataset.dn === dn ? 0 : -1; });
    const f = daysEl.querySelector('[data-dn="' + dn + '"]'); if (f) f.focus();
  }
  // Same day-of-month in another month, clamped to that month's length.
  function shiftMonth(dn, k) {
    const { y, mo, d } = ymdOf(dn);
    const t = new Date(Date.UTC(y, mo + k, 1));
    const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return dnOf(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, dim));
  }
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  daysEl.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("cal-d")) return;
    const { y, mo } = ymdOf(st.dn);
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (delta) { stop(e); moveDay(st.dn + delta); }
    else if (e.key === "PageUp" || e.key === "PageDown") { stop(e); moveDay(shiftMonth(st.dn, e.key === "PageUp" ? -1 : 1)); }
    else if (e.key === "Home") { stop(e); moveDay(dnOf(y, mo, 1)); }
    else if (e.key === "End") { stop(e); moveDay(dnOf(y, mo + 1, 0)); }
  });
  daysEl.addEventListener("click", (e) => {
    const b = e.target.closest(".cal-d"); if (!b) return;
    const { y, mo, d } = ymdOf(+b.dataset.dn);
    go(periodOf(y + "-" + p2(mo + 1) + "-" + p2(d)));
  });
  // Month strip: select (re-draws the grid); arrows move by month, across years.
  function selectMonth(y, mo, focus) {
    const t = new Date(Date.UTC(y, mo, 1));
    if (t.getUTCFullYear() < C.yearList[0] || t.getUTCFullYear() > C.yearList[C.yearList.length - 1]) return;
    const d = Math.min(ymdOf(st.dn).d, dimOf(t.getUTCFullYear(), t.getUTCMonth()));
    const dn = dnOf(t.getUTCFullYear(), t.getUTCMonth(), d);
    st.dn = snapListed(dn, Math.sign(dn - st.dn));
    draw(focus ? '.cal-mo[aria-pressed="true"]' : null);
  }
  monthsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".cal-mo"); if (!b) return;
    selectMonth(ymdOf(st.dn).y, +b.dataset.mo, true);
  });
  monthsEl.addEventListener("keydown", (e) => {
    const { y, mo } = ymdOf(st.dn);
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (delta) { stop(e); selectMonth(y, mo + delta, true); }
    else if (e.key === "Home") { stop(e); selectMonth(y, 0, true); }
    else if (e.key === "End") { stop(e); selectMonth(y, 11, true); }
  });
  // Year strip: select a year (same month, clamped); arrows step through the list.
  function selectYear(yy) {
    if (yy == null) return;
    const { mo, d } = ymdOf(st.dn);
    st.dn = dnOf(yy, mo, Math.min(d, new Date(Date.UTC(yy, mo + 1, 0)).getUTCDate()));
    draw('.cal-yr[aria-pressed="true"]');
  }
  yearsEl.addEventListener("click", (e) => { const b = e.target.closest(".cal-yr"); if (b) selectYear(+b.dataset.y); });
  yearsEl.addEventListener("keydown", (e) => {
    const k = C.yearList.indexOf(ymdOf(st.dn).y);
    const to = { ArrowLeft: k - 1, ArrowRight: k + 1, ArrowUp: k - 1, ArrowDown: k + 1, Home: 0, End: C.yearList.length - 1 }[e.key];
    if (to == null) return;
    stop(e);
    selectYear(C.yearList[Math.max(0, Math.min(C.yearList.length - 1, to))]);
  });
  monthGo.onclick = () => { const { y, mo } = ymdOf(st.dn); go(periodOf(y + "-" + p2(mo + 1))); };
  $(".cal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = $(".cal-input").value.trim();
    const p = GCAShared.parseJumpDate(raw, CLOCK);
    if (!p) msgEl.textContent = "Not a date. " + DATE_HINT;
    else if (p.error) msgEl.textContent = dateErrorText(raw, p);
    else go(p);
  });
  $(".cal-close").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  modal._close = close;
  draw();
  document.body.appendChild(modal);
  applyDialog(modal, null, { initial: '.cal-d[tabindex="0"]' });
  modal.setAttribute("aria-labelledby", "cal-title");
}

/* ===========================================================================
   COMMAND PALETTE (Ctrl/Cmd+K)
   ======================================================================== */
// Line-icon set — symbols from the mockup's IC map (mock-cmdk.html) plus a few
// extras, keyed by name and rendered via cmdIco(). Shared by the command palette,
// the search filter bar, empty states, Wrapped and other chrome so the whole UI
// carries the nav rail's tasteful iconography instead of emoji glyphs.
const CMD_IC = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  timeline: '<path d="M4 6h16M4 12h16M4 18h11"/>',
  gallery: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
  hof: '<circle cx="12" cy="9" r="5.5"/><path d="M9 13.5L7.5 21l4.5-2.5L16.5 21 15 13.5M12 6.5v2.5l1.8 1"/>',
  pins: '<path d="M7 4h10l-1 7 3 3H5l3-3z"/><path d="M12 14v6"/>',
  capsule: '<path d="M3.5 9a9 9 0 113 8.5M3.5 9V4.5M3.5 9H8M12 8v4.5l3 2"/>',
  wrapped: '<path d="M12 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L12 18.7 7.8 16l.8-4.7L5.2 8l4.7-.7z"/>',
  threads: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="12" r="2.5"/><path d="M8.5 6H13a2 2 0 012 2v2M8.5 18H13a2 2 0 002-2v-2"/>',
  battles: '<path d="M12 3v18M6 8l-2 2 2 2M18 8l2 2-2 2M4.5 10H9M15 10h4.5"/>',
  chains: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M6.7 11l3.6-3.4M13.7 7.4L17.3 11M17.3 13l-3.6 3.6M10.3 16.6L6.7 13"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  people: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3 19c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M15.5 18c.4-2 1.6-3 3-3s2.4 1 2.8 2.6"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  random: '<path d="M4 7h3.5l9 10H20M16.5 7H20M4 17h3.5l3-3.3"/><path d="M17.5 5.5L20 7l-2.5 1.5M17.5 15.5L20 17l-2.5 1.5"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  accent: '<path d="M12 3s6 6.4 6 10.5a6 6 0 01-12 0C6 9.4 12 3 12 3z"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 000 18z" fill="currentColor" stroke="none"/>',
  saved: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l2.3-2.3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0L6 12.3a4 4 0 005.7 5.7l1-1"/>',
  heart: '<path d="M12 20s-7-4.6-7-9.6A3.4 3.4 0 0112 7a3.4 3.4 0 017 3.4C19 15.4 12 20 12 20z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bubble: '<path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12.5h5"/>',
};
function cmdIco(k) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (CMD_IC[k] || CMD_IC.search) + "</svg>";
}
function buildCommands() {
  const cmds = [];
  const views = [
    ["search", "search", "Search messages", "Full-text across every message"],
    ["timeline", "timeline", "Open Timeline", "The full conversation"],
    ["gallery", "gallery", "Media Gallery", "Photos & videos"],
    ["hof", "hof", "Hall of Fame (most reacted)", "Most-reacted moments"],
    ["pins", "pins", "Pinned messages", "Saved highlights"],
    ["capsule", "capsule", "Time Capsule (on this day)", "On this day, across the years"],
    ["wrapped", "wrapped", "Wrapped (year in review)", "Year in review"],
    ["threads", "threads", "Conversation Threads", "Activity bursts"],
    ["battles", "battles", "Word Battles (head-to-head)", "Head-to-head word usage"],
    ["chains", "chains", "Reply Chains (longest exchanges)", "Longest exchanges"],
    ["stats", "stats", "Stats & overview", "Every metric, at a glance"],
    ["people", "people", "People", "Names, colors, photos"],
    ["settings", "settings", "Settings", "Theme, density, data"],
  ];
  views.forEach(([v, ico, label, sub]) => cmds.push({ ico, label, sub, hint: "View", run: () => setView(v) }));
  cmds.push({ ico: "random", label: "Random quote", sub: "Jump somewhere unexpected", hint: "Action", run: () => jumpTo(Math.floor(Math.random() * N)) });
  cmds.push({ ico: "calendar", label: "Browse by date (calendar)", sub: "Message volume by year, month and day", hint: "Action", run: () => openCalendar() });
  cmds.push({ ico: "keyboard", label: "Keyboard shortcuts", sub: "Every key, at a glance", hint: "Help", run: () => toggleKeyboardHelp() });
  cmds.push({ ico: "accent", label: "Cycle accent color", sub: "Rotate through the accent palette", hint: "Theme", run: () => {
    const i = (ACCENTS.indexOf(settings.accent) + 1) % ACCENTS.length;
    settings.accent = ACCENTS[i]; saveSettings(); applyTheme(); toast("Accent: " + settings.accent);
  }});
  cmds.push({ ico: "theme", label: "Cycle theme (Light / Dim / Lights out)", sub: "Switch to the next theme", hint: "Theme", run: () => {
    const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    setTheme(next); toast("Theme: " + next);
  }});
  cmds.push({ ico: "random", label: "Shuffle theme (surprise me)", sub: "Random theme + accent combo", hint: "Theme", run: () => shuffleTheme() });
  // People → jump to their first message
  PARTS.forEach((p) => p.firstIdx >= 0 && cmds.push({ ico: "people", pid: p.id, label: "Go to " + nameOf(p.id) + "'s first message", sub: "Jump to their first message", hint: "Person", run: () => jumpTo(p.firstIdx) }));
  // Saved searches
  (settings.saved || []).forEach((s) => cmds.push({ ico: "saved", label: "Search: " + s.name, sub: s.q || "Filters only", hint: "Saved", run: () => { setView("search"); applySaved(s); } }));
  return cmds;
}
// open the Search view on a query, box focused (the palette's
// "See all in Search", the Timeline's Search button). The query rides in
// history.state like any typed one — never the URL.
function openSearchWith(q) {
  setView("search");
  if (q != null && sEls.input) {
    searchScope = "this";   // the palette's hits (and its count) are this chat's
    clearTimeout(sDeb);
    sEls.input.value = q; sEls.clear.hidden = !q;
    runSearch();
  }
  if (sEls.input) { sEls.input.focus(); const n = sEls.input.value.length; sEls.input.setSelectionRange(n, n); }
}
// A message's text as it reads on screen: t.co links shown by their display /
// expanded URL (renderText does the same for the bubble).
function displayText(m) {
  let x = m.x || "";
  if (Array.isArray(m.u)) for (const u of m.u) if (u && u.s && (u.d || u.e)) x = x.split(u.s).join(u.d || u.e);
  return x.replace(/\s+/g, " ").trim();
}
// An escaped one-line snippet of `text` around the first needle, every needle
// marked (XSS-safe: marks are placed on the raw text, each part esc()'d).
function snippetHtml(text, needles, width) {
  width = width || 110;
  const low = text.toLowerCase();
  const sameLen = low.length === text.length;
  let at = -1;
  if (sameLen) for (const n of needles) { const k = low.indexOf(n); if (k >= 0 && (at < 0 || k < at)) at = k; }
  let a = 0, b = Math.min(text.length, width);
  if (at > 30) { a = at - 30; b = Math.min(text.length, a + width); }
  const s = text.slice(a, b), sl = low.slice(a, b);
  const ranges = [];
  if (sameLen) for (const n of needles) { if (!n) continue; for (let k = sl.indexOf(n); k >= 0; k = sl.indexOf(n, k + n.length)) ranges.push([k, k + n.length]); }
  ranges.sort((x, y) => x[0] - y[0]);
  let html = a > 0 ? "…" : "", pos = 0;
  for (const [x, y] of ranges) {
    if (x < pos) continue;
    html += esc(s.slice(pos, x)) + "<mark>" + esc(s.slice(x, y)) + "</mark>";
    pos = y;
  }
  return html + esc(s.slice(pos)) + (b < text.length ? "…" : "");
}
const PALETTE_HITS = 5;
const PALETTE_DEB = 150;
function openCommandPalette() {
  const prevCmdk = document.querySelector(".cmdk");
  const inherit = prevCmdk ? prevCmdk._opener : undefined;   // replacing: keep the original opener
  const inheritHeld = prevCmdk ? prevCmdk._wrFocusHeld : undefined;   // ...and its keyboard-focus pause
  document.querySelectorAll(".cmdk").forEach((m) => m.remove());
  const all = buildCommands();
  const modal = el("div", "cmdk");
  const searchSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  modal.innerHTML = `<div class="cmdk-card">
      <div class="cmdk-inputrow">
        ${searchSvg}
        <input class="cmdk-input" type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" aria-label="Command, person, date, or message search" placeholder="Type a command, person, date (June 2021) or words to find…" spellcheck="false" autocomplete="off">
        <span class="cmdk-esc" aria-hidden="true">ESC</span>
      </div>
      <div class="cmdk-list" id="cmdk-list" role="listbox" aria-label="Commands and messages"></div>
      <div class="cmdk-foot">
        <span class="cmdk-f"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span class="cmdk-f"><kbd>↵</kbd> select</span>
        <span class="cmdk-f"><kbd>Esc</kbd> close</span>
        <span class="cmdk-grow"></span>
        <span class="cmdk-brandlet"></span>
      </div>
    </div>`;
  const brandEl = document.getElementById("brand-title");
  modal.querySelector(".cmdk-brandlet").textContent =
    ((brandEl && brandEl.textContent) || "").trim() || "Archive";
  const input = modal.querySelector(".cmdk-input");
  const listEl = modal.querySelector(".cmdk-list");
  let filtered = all, sel = 0;
  // message hits for the current input — { q, idx, total,
  // needles } once the debounced search ran for exactly this text, else null.
  let hits = null, hitT = 0;

  // any form parseJumpDate reads ("2021-06", "June 2021", "Jan 7 2024",
  // 1/7/2024 …); a date-shaped input that doesn't exist gets a row that says
  // so instead of silently landing somewhere else.
  function dateCmd(q) {
    const p = GCAShared.parseJumpDate(q, CLOCK);
    if (!p) return null;
    const raw = q.trim();
    if (p.error === "order") return { ico: "calendar", label: raw + " isn't month/day/year", sub: DATE_ORDER_HINT, hint: "Date", run: () => jumpToDate(raw) };
    if (p.error) return { ico: "calendar", label: "No such date: " + raw, sub: "Check the day and month. " + DATE_HINT, hint: "Date", run: () => jumpToDate(raw) };
    const what = p.unit === "day" ? "this day" : p.unit === "month" ? "this month" : "this year";
    return { ico: "calendar", label: "Jump to " + p.label, sub: "First message of " + what + " in the timeline", hint: "Date", run: () => jumpToPeriod(p) };
  }
  // Hint → group header shown above each run of rows (cosmetic only — `filtered`
  // stays flat and index-aligned with the `.cmdk-row` NodeList).
  const GROUP_OF = { Date: "Dates", View: "Views", Action: "Actions", Help: "Actions", Theme: "Theme", Person: "People", Saved: "Saved searches", Message: "Messages", Search: "Messages" };
  // XSS-safe match highlight: split the RAW label at the first case-insensitive
  // occurrence of the query and esc() each part — never regex over escaped HTML.
  function markLabel(label, q) {
    if (!q) return esc(label);
    const i = label.toLowerCase().indexOf(q);
    if (i < 0) return esc(label);
    return esc(label.slice(0, i)) + "<mark>" + esc(label.slice(i, i + q.length)) + "</mark>" + esc(label.slice(i + q.length));
  }
  // Date row + the commands whose label holds the input (as before the palette search).
  function commandRows(raw) {
    const q = raw.trim().toLowerCase();
    const dc = dateCmd(raw);
    const base = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
    return (dc ? [dc].concat(base) : base).slice(0, 50);
  }
  // The message part of the list: the top hits, then the row that opens
  // Search on this query. Only for 2+ characters (a lone letter filters the
  // commands, it isn't a search).
  function msgRows(raw) {
    const q = raw.trim();
    if (q.length < 2) return [];
    const rows = [];
    const ready = hits && hits.q === raw;
    // Until this text's pass lands, the previous query's hits stay (dimmed,
    // list aria-busy) instead of the list blanking on every keystroke.
    const stale = !ready && hits && hits.q.trim().length >= 2;
    if (ready || stale) hits.idx.forEach((i) => {
      const m = MSGS[i], text = displayText(m);
      rows.push({ kind: "msg", stale, pid: m.s, html: snippetHtml(text, hits.needles), label: text,
        sub: nameOf(m.s) + " · " + DT.format(m.t), hint: "Message", run: () => jumpTo(i) });
    });
    rows.push({ kind: "seeall", ico: "search", hint: "Search", run: () => openSearchWith(raw),
      label: ready && hits.total ? "See all in Search" : "Search messages for “" + q + "”",
      sub: !ready ? "Searching this chat…" : hits.total ? fmtNum(hits.total) + " message" + (hits.total === 1 ? " matches" : "s match") + " in this chat"
        : "No exact matches in this chat — Search also finds close matches" });
    return rows;
  }
  function refresh() {
    filtered = commandRows(input.value).concat(msgRows(input.value));
    sel = 0; draw();
    if (filtered.some((c) => c.stale)) listEl.setAttribute("aria-busy", "true"); else listEl.removeAttribute("aria-busy");
    // the message search is debounced — typing never waits on it
    clearTimeout(hitT);
    if (input.value.trim().length >= 2 && !(hits && hits.q === input.value)) hitT = setTimeout(runHits, PALETTE_DEB);
  }
  // The SAME engine as Search: parseSearchQuery + the operator overlay + the
  // literal (exact) tier, in the active chat with its filters; newest first.
  function runHits() {
    if (!modal.isConnected) return;
    const raw = input.value;
    const ctx = buildSearchCtx(raw, searchPeople(PARTS));
    const idx = ctxFiltered(ctx) ? literalHits(ctx, MSGS, LOWER) : [];
    hits = { q: raw, idx: idx.slice(0, PALETTE_HITS), total: idx.length, needles: ctx.needles };
    // keep the selection on the same row (the hits go in before "See all")
    const cur = filtered[sel];
    filtered = commandRows(raw).concat(msgRows(raw));
    if (cur && cur.kind === "seeall") sel = filtered.length - 1;
    else if (sel >= filtered.length) sel = 0;
    draw();
    listEl.removeAttribute("aria-busy");
    if (filtered.length === 1 && filtered[0].kind === "seeall") announce("No matches for “" + raw.trim() + "” — press Enter to search messages");
    listEl.dataset.hits = String((Number(listEl.dataset.hits) || 0) + 1);   // a hits pass completed (tests / perf)
  }
  function draw() {
    listEl.innerHTML = "";
    const rawQ = input.value.trim();
    const q = rawQ.toLowerCase();
    // the input is a combobox driving this listbox; the "selected" row
    // is exposed through aria-activedescendant (focus stays in the input).
    input.setAttribute("aria-expanded", filtered.length ? "true" : "false");
    input.removeAttribute("aria-activedescendant");
    if (!filtered.length) {
      announce("No matches for “" + rawQ + "”");
      listEl.appendChild(el("div", "cmdk-empty",
        '<div class="cmdk-empty-ic">' + searchSvg + "</div>" +
        "<h3>No matches for “" + esc(rawQ) + "”</h3>" +
        "<p>Try a person's name, a view, or a date like 2023-09-12 or June 2021.</p>"));
      return;
    }
    let lastGroup = null;
    filtered.forEach((c, k) => {
      const g = GROUP_OF[c.hint] || c.hint;
      if (g !== lastGroup) {
        const gh = el("div", "cmdk-group", esc(g)); gh.setAttribute("aria-hidden", "true");
        listEl.appendChild(gh); lastGroup = g;
      }
      const row = el("div", "cmdk-row" + (c.kind === "msg" ? " cmdk-msg" + (c.stale ? " stale" : "") : c.kind === "seeall" ? " cmdk-seeall" : "") + (k === sel ? " sel" : ""));
      row.id = "cmdk-opt-" + k; row.setAttribute("role", "option");
      row.setAttribute("aria-selected", k === sel ? "true" : "false");
      const lead = c.pid != null
        ? pfpHtml(c.pid, "")
        : '<span class="cmdk-ico">' + cmdIco(c.ico) + "</span>";
      row.innerHTML = lead +
        '<span class="cmdk-tx"><span class="cmdk-label"' + (c.kind === "msg" ? ' dir="auto"' : "") + ">" + (c.html != null ? c.html : markLabel(c.label, q)) + "</span>" +
        (c.sub ? '<span class="cmdk-sub">' + esc(c.sub) + "</span>" : "") +
        '</span><span class="cmdk-hint">' + esc(c.hint) + "</span>";
      // The whole row is the click target — don't let the global av-clickable
      // handler stack a profile modal on top of the row's own action.
      const av = row.querySelector(".av-clickable");
      if (av) { av.classList.remove("av-clickable"); av.style.cursor = "pointer"; }
      row.onmouseenter = () => { sel = k; highlight(); };
      row.onclick = () => choose(k);
      listEl.appendChild(row);
    });
    input.setAttribute("aria-activedescendant", "cmdk-opt-" + sel);
  }
  function highlight() {
    listEl.querySelectorAll(".cmdk-row").forEach((r, k) => { r.classList.toggle("sel", k === sel); r.setAttribute("aria-selected", k === sel ? "true" : "false"); });
    if (filtered.length) input.setAttribute("aria-activedescendant", "cmdk-opt-" + sel);
  }
  function choose(k) { const c = filtered[k]; clearTimeout(hitT); modal.remove(); if (c) c.run(); }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); highlight(); ensureVisible(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); highlight(); ensureVisible(); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered.length) choose(sel); }
  });
  function ensureVisible() { const r = listEl.querySelectorAll(".cmdk-row")[sel]; if (r) r.scrollIntoView({ block: "nearest" }); }

  modal.addEventListener("click", (e) => { if (e.target === modal) { clearTimeout(hitT); modal.remove(); restoreFocus(modal); } });
  document.body.appendChild(modal);
  refresh();
  // applyDialog captures the opener (for focus restore) before focusing the input.
  applyDialog(modal, "Command palette", { initial: ".cmdk-input", opener: inherit, focusHeld: inheritHeld });
}

// NOTE: boot happens at the very end of this IIFE (see bottom of file), after
// all module-level state is declared — activateConversation() touches it.

/* ===========================================================================
   "ON THIS DAY" TOAST — show a preview on app load
   ======================================================================== */
function showOnThisDayToast() {
  // Same-zone "on this day" match as the Capsule view (configured timezone).
  const todayZ = zonedParts(Date.now());
  const tMonth = todayZ.mo, tDate = todayZ.d, tYear = todayZ.y;
  // gather EVERY same-day match from PAST years (a future-dated outlier
  // is not "N years ago"; the old scan stopped at 20 matches,
  // so a chatty early year hid every later one), then pick a random year and a
  // random message of that year — each past year is equally likely.
  const TI = timeIndex(), byYear = new Map();
  for (let i = 0; i < N; i++) {
    if (TI.month[i] === tMonth && TI.mday[i] === tDate && TI.year[i] < tYear) {
      const y = TI.year[i];
      let list = byYear.get(y); if (!list) byYear.set(y, (list = []));
      list.push(i);
    }
  }
  if (byYear.size === 0) return;
  const years = [...byYear.keys()].sort((x, z) => x - z);
  const yr = years[Math.floor(Math.random() * years.length)];
  const inYear = byYear.get(yr);
  const pick = inYear[Math.floor(Math.random() * inYear.length)];
  const m = MSGS[pick];
  const ago = tYear - yr;
  const snippet = (m.x || "").trim().slice(0, 60) || "[media]";
  // Mock .toast structure: header (clock icon + "On This Day" + "N years ago"),
  // body (avatar + hue-colored name · quoted snippet), uppercase CTA row, and a
  // ✕ that dismisses without navigating. Click anywhere else → Time Capsule.
  const hue = personColor(m.s);
  const otdToast = el("div", "otd-toast");
  otdToast.innerHTML = `
    <button class="otd-close" type="button" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="otd-head"><span class="otd-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9a9 9 0 113 8.5M3.5 9V4.5M3.5 9H8M12 8v4.5l3 2"/></svg></span><span class="otd-title">On This Day</span><span class="otd-yr">${esc(plural(ago, "year"))} ago</span></div>
    <div class="otd-body">${pfpHtml(m.s, "width:30px;height:30px;font-size:11px")}<div class="otd-q"><span class="otd-name" style="color:${esc(hue.p)}">${esc(nameOf(m.s))}</span> · “${esc(snippet)}${snippet.length >= 60 ? "…" : ""}”</div></div>
    <button class="otd-cta" type="button">Open Time Capsule <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`;
  // The whole toast is one click target (→ Capsule); don't let the avatar's
  // global av-clickable handler stack a profile modal on top of the navigation.
  const tAv = otdToast.querySelector(".av");
  if (tAv) { tAv.classList.remove("av-clickable"); tAv.style.cursor = "pointer"; }
  let timer = 0;
  const dismiss = () => { clearTimeout(timer); otdToast.classList.add("otd-exit"); setTimeout(() => otdToast.remove(), 220); };
  otdToast.onclick = () => { clearTimeout(timer); otdToast.remove(); setView("capsule"); };
  otdToast.querySelector(".otd-close").onclick = (e) => { e.stopPropagation(); dismiss(); };
  document.body.appendChild(otdToast);
  // the Timeline's "Latest" pill shares this corner; CSS lifts it by the
  // toast's real height while the toast is up (body:has(.otd-toast)).
  document.body.style.setProperty("--otd-h", otdToast.offsetHeight + "px");
  timer = setTimeout(dismiss, 7000);
}

/* ===========================================================================
   CONVERSATION THREADS — detect bursts of activity as "threads"
   ======================================================================== */
let threadsCache = null;
function computeThreads() {
  if (threadsCache) return threadsCache;
  const GAP = 3600000; // 1hr gap = new thread
  const MIN_MSGS = 8;  // minimum messages to count as a thread
  const threads = [];
  let cur = { start: 0, end: 0, people: new Set(), count: 0 };

  for (let i = 0; i < N; i++) {
    if (i > 0 && MSGS[i].t - MSGS[i-1].t > GAP) {
      if (cur.count >= MIN_MSGS) {
        threads.push({
          startIdx: cur.start, endIdx: i - 1,
          startT: MSGS[cur.start].t, endT: MSGS[i-1].t,
          people: [...cur.people], count: cur.count,
          duration: MSGS[i-1].t - MSGS[cur.start].t
        });
      }
      cur = { start: i, end: i, people: new Set(), count: 0 };
    }
    cur.people.add(MSGS[i].s);
    cur.count++;
    cur.end = i;
  }
  if (cur.count >= MIN_MSGS) {
    threads.push({
      startIdx: cur.start, endIdx: cur.end,
      startT: MSGS[cur.start].t, endT: MSGS[cur.end].t,
      people: [...cur.people], count: cur.count,
      duration: MSGS[cur.end].t - MSGS[cur.start].t
    });
  }
  threads.sort((a, b) => b.count - a.count);
  threadsCache = threads;
  return threads;
}

let threadSort = "biggest";
let threadFilter = "all";
function renderThreads() {
  const v = document.getElementById("view-threads");
  const threads = computeThreads();
  // a year chosen for another conversation / zone that has no threads
  // here falls back to "All" (same guard renderHallOfFame uses).
  const TI = timeIndex();
  const yearOf = (t) => TI.year[t.startIdx];   // zoned year the thread starts in
  if (threadFilter !== "all" && !threads.some((t) => String(yearOf(t)) === threadFilter)) threadFilter = "all";

  let filtered = threads;
  if (threadFilter !== "all") {
    filtered = threads.filter(t => {
      return String(yearOf(t)) === threadFilter;
    });
  }

  if (threadSort === "biggest") filtered.sort((a, b) => b.count - a.count);
  else if (threadSort === "longest") filtered.sort((a, b) => b.duration - a.duration);
  else if (threadSort === "newest") filtered.sort((a, b) => b.startT - a.startT);
  else if (threadSort === "oldest") filtered.sort((a, b) => a.startT - b.startT);
  else if (threadSort === "liveliest") filtered.sort((a, b) => b.people.length - a.people.length);

  const years = [...new Set(threads.map(yearOf))].sort((a, b) => b - a);
  const yearChips = ['<button class="pill thr-yr' + (threadFilter === "all" ? " active" : "") + '" data-yr="all">All</button>']
    .concat(years.map(y => '<button class="pill thr-yr' + (threadFilter === String(y) ? " active" : "") + '" data-yr="' + y + '">' + y + '</button>')).join("");

  const sortOpts = [
    ["biggest", "Most messages"], ["longest", "Longest duration"],
    ["newest", "Newest"], ["oldest", "Oldest"], ["liveliest", "Most people"]
  ].map(([val, label]) => `<option value="${val}"${threadSort === val ? " selected" : ""}>${label}</option>`).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">Conversation Threads</div>
      <div class="page-sub">Activity bursts detected: ${plural(threads.length, "thread")} with 8+ messages, separated by 1-hour gaps. Browse the conversations that brought the group alive.</div></div>
    <div class="page-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px;">
        <div class="thr-years">${yearChips}</div>
        <span class="spacer"></span>
        <label class="pill sortpill">↕ <select id="thr-sort">${sortOpts}</select></label>
      </div>
      <div class="thr-grid" id="thr-grid"></div>
      <div class="result-meta" style="margin-top:14px;">${plural(filtered.length, "thread")} shown</div>
    </div></div>`;

  v.querySelectorAll(".thr-yr").forEach(b => {
    b.onclick = () => { threadFilter = b.dataset.yr; renderThreads(); };
  });
  v.querySelector("#thr-sort").onchange = (e) => { threadSort = e.target.value; renderThreads(); };

  const grid = v.querySelector("#thr-grid");
  const showing = filtered.slice(0, 80);
  const frag = document.createDocumentFragment();

  showing.forEach((t, idx) => {
    const card = el("div", "thr-card");
    const dur = t.duration;
    let durStr = dur < 60000 ? "<1m" : dur < 3600000 ? Math.round(dur / 60000) + "m" : (dur / 3600000).toFixed(1) + "h";

    // Get first text message as preview
    let preview = "";
    for (let j = t.startIdx; j <= t.endIdx && j < N; j++) {
      if (MSGS[j].x && MSGS[j].x.trim().length > 10) { preview = MSGS[j].x.trim().slice(0, 80); break; }
    }

    // People avatars
    const avs = t.people.slice(0, 5).map(id => pfpHtml(id, "width:26px;height:26px;font-size:10px")).join("");
    const extra = t.people.length > 5 ? `<span class="thr-extra">+${t.people.length - 5}</span>` : "";

    card.innerHTML = `
      <div class="thr-rank">#${idx + 1}</div>
      <div class="thr-date">${esc(DT.format(t.startT))}</div>
      <div class="thr-stats">
        <span class="thr-stat"><b>${fmtNum(t.count)}</b> msgs</span>
        <span class="thr-stat">${cmdIco("clock")} ${durStr}</span>
        <span class="thr-stat">${cmdIco("people")} ${t.people.length}</span>
      </div>
      <div class="thr-preview">${preview ? esc(preview) + (preview.length >= 80 ? "…" : "") : "<i>media thread</i>"}</div>
      <div class="thr-people">${avs}${extra}</div>`;
    asButton(card, () => jumpTo(t.startIdx), "Thread #" + (idx + 1) + ", " + DT.format(t.startT) + ", " + plural(t.count, "message") + " — open in timeline");
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

/* ===========================================================================
   WORD BATTLES — head-to-head word usage comparison
   ======================================================================== */
let battleP1 = null, battleP2 = null;
function renderBattles() {
  const v = document.getElementById("view-battles");
  // fewer than two people who posted (others quiet or ignored): nothing to compare
  if (PARTS.filter((p) => p.count > 0).length < 2) {
    v.innerHTML = '<div class="page"><div class="page-head"><div class="page-title">Word Battles</div></div><div class="page-body"></div></div>';
    v.querySelector(".page-body").appendChild(emptyState("battles", "A word battle needs two people who posted."));
    return;
  }

  if (!battleP1 && PARTS.length >= 2) { battleP1 = PARTS[0].id; battleP2 = PARTS[1].id; }

  const pOpts = PARTS.map(p =>
    `<option value="${esc(p.id)}">${esc(nameOf(p.id))} (${fmtNum(p.count)})</option>`
  ).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
    <div class="page-title">Word Battles</div>
    <div class="page-sub">Compare word usage head-to-head between two people. Who says "lmao" more? Who's the real "bruh" user?</div></div>
  <div class="page-body">
    <div class="battle-selectors">
      <div class="battle-picker">
        ${battleP1 ? pfpHtml(battleP1, "width:40px;height:40px;font-size:15px") : ""}
        <select id="battle-p1" aria-label="First person to compare">${pOpts}</select>
      </div>
      <div class="battle-vs">VS</div>
      <div class="battle-picker">
        ${battleP2 ? pfpHtml(battleP2, "width:40px;height:40px;font-size:15px") : ""}
        <select id="battle-p2" aria-label="Second person to compare">${pOpts}</select>
      </div>
    </div>
    <div class="battle-custom" style="margin:16px 0;">
      <input type="text" id="battle-word" aria-label="Add a word to the battle" placeholder="Type a word to compare..." class="person-name-input" style="max-width:260px">
      <button class="btn" id="battle-go">Compare</button>
    </div>
    <div id="battle-results"></div>
  </div></div>`;

  const sel1 = v.querySelector("#battle-p1");
  const sel2 = v.querySelector("#battle-p2");
  sel1.value = battleP1;
  sel2.value = battleP2;
  // changing a person used to re-render the whole view, dropping every
  // added word (and a half-typed one). Now only the picker avatar and the
  // results update; the words live in settings.battleWords.
  const pickAv = (sel, id) => {
    const old = sel.parentElement.querySelector(".av");
    const tmp = document.createElement("div"); tmp.innerHTML = pfpHtml(id, "width:40px;height:40px;font-size:15px");
    if (old) old.replaceWith(tmp.firstElementChild); else sel.before(tmp.firstElementChild);
  };
  sel1.onchange = () => { battleP1 = sel1.value; pickAv(sel1, battleP1); drawBattleResults(); };
  sel2.onchange = () => { battleP2 = sel2.value; pickAv(sel2, battleP2); drawBattleResults(); };

  v.querySelector("#battle-go").onclick = () => {
    const word = v.querySelector("#battle-word").value.trim();
    if (word) addBattleWord(word);
  };
  v.querySelector("#battle-word").onkeydown = (e) => {
    if (e.key === "Enter") { const w = e.target.value.trim(); if (w) addBattleWord(w); }
  };

  drawBattleResults();
}

function drawBattleResults() {
  const container = document.getElementById("battle-results");
  if (!container || !battleP1 || !battleP2) return;

  // Whole-word token counts (the shared tokenizer, apostrophe-folded keys) —
  // "lol!" is the word lol, "many" is not "man". The custom rows added
  // (battleCounts()) count the very same way.
  const counts1 = new Map(), counts2 = new Map();
  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    if (!m.x || (m.s !== battleP1 && m.s !== battleP2)) continue;
    for (const t of tokenize(m.x)) {
      const k = wordKey(t);
      if (m.s === battleP1) counts1.set(k, (counts1.get(k) || 0) + 1);
      if (m.s === battleP2) counts2.set(k, (counts2.get(k) || 0) + 1);
    }
  }

  const BUILT_IN = ["lol", "lmao", "bruh", "nah", "bro", "damn", "like", "yeah", "fuck", "man", "shit", "good", "love", "dead", "fire", "real", "nice", "wait", "facts", "honestly", "literally", "actually", "think", "know", "gonna"];

  // One row per word: the added words first (always shown, removable), then
  // each built-in word either person used that isn't already an added row.
  // The wins are tallied over exactly these rows.
  const rows = settings.battleWords.map((word) => Object.assign({ word, added: true }, battleCounts(word)));
  const addedKeys = new Set(settings.battleWords.map((w) => wordKey(w)));
  BUILT_IN.forEach((word) => {
    const k = wordKey(word);
    if (addedKeys.has(k)) return;
    const c1 = counts1.get(k) || 0, c2 = counts2.get(k) || 0;
    if (c1 || c2) rows.push({ word, added: false, c1, c2 });
  });

  let wins1 = 0, wins2 = 0;
  let html = '<div class="battle-rows">';
  rows.forEach((r) => {
    if (r.c1 > r.c2) wins1++;
    else if (r.c2 > r.c1) wins2++;
    html += battleRowHtml(r);
  });
  html += '</div>';
  html += `<div class="battle-summary">
    <span style="color:${esc(personColor(battleP1).p)};font-weight:700">${esc(nameOf(battleP1))}: ${wins1} ${wins1 === 1 ? "win" : "wins"}</span>
    <span style="color:var(--text-faint)">•</span>
    <span style="color:${esc(personColor(battleP2).p)};font-weight:700">${esc(nameOf(battleP2))}: ${wins2} ${wins2 === 1 ? "win" : "wins"}</span>
  </div>`;

  container.innerHTML = html;
  // each side's bars wear that person's name colour (as the summary does),
  // which reaches 4.5:1 on the page and card in every theme
  container.style.setProperty("--battle-left", personColor(battleP1).p);
  container.style.setProperty("--battle-right", personColor(battleP2).p);
  container.querySelectorAll(".battle-remove").forEach((b) => {
    b.onclick = () => {
      settings.battleWords = settings.battleWords.filter((w) => w !== b.dataset.word);
      saveSettings(); drawBattleResults();
    };
  });
}

// Add a word to the battle (newest first; a word already there stays put).
function addBattleWord(word) {
  const inp = document.getElementById("battle-word");
  const t = word.trim(), k = t.toLowerCase();
  // say why nothing happened — and keep the text so it can be shortened
  if (t.length > BATTLE_WORD_MAX) { toast("Battle words can be up to " + BATTLE_WORD_MAX + " characters"); return; }
  if (settings.battleWords.some((w) => w.toLowerCase() === k)) { if (inp) inp.value = ""; toast("“" + t + "” is already in the battle"); return; }
  const next = cleanBattleWords([t].concat(settings.battleWords));
  const dropped = settings.battleWords.filter((w) => next.indexOf(w) === -1);
  settings.battleWords = next;
  saveSettings();
  if (dropped.length) toast("Added “" + t + "”, dropped the oldest word “" + dropped.join("”, “") + "” (" + BATTLE_WORDS_MAX + " max)");
  drawBattleResults();
  if (inp) inp.value = "";
}

// An added word's counts, with the same whole-word keys as everything else.
function battleCounts(word) {
  const keys = wordKeys(word);
  const probe = keys.length ? keys.reduce((a, b) => (b.length > a.length ? b : a)) : "";
  let c1 = 0, c2 = 0;
  for (let i = 0; i < N; i++) {
    const s = MSGS[i].s;
    if ((s !== battleP1 && s !== battleP2) || !mayContainKey(LOWER[i], probe)) continue;
    const c = countKeys(MSGS[i].x, keys);
    if (s === battleP1) c1 += c;
    if (s === battleP2) c2 += c;
  }
  return { c1, c2 };
}

// One row: both counts and bars, the word between them; an added word can be
// removed.
function battleRowHtml({ word, added, c1, c2 }) {
  const max = Math.max(c1, c2, 1);
  const w1 = (c1 / max * 100).toFixed(0);
  const w2 = (c2 / max * 100).toFixed(0);
  const winner = c1 > c2 ? "left" : c2 > c1 ? "right" : "tie";

  return `<div class="battle-row${added ? " battle-added" : ""}">
    <div class="battle-count ${winner === 'left' ? 'battle-winner' : ''}">${fmtNum(c1)}</div>
    <div class="battle-bar-left"><div class="battle-fill-left" style="width:${w1}%"></div></div>
    <div class="battle-word">${esc(word)}</div>
    <div class="battle-bar-right"><div class="battle-fill-right" style="width:${w2}%"></div></div>
    <div class="battle-count ${winner === 'right' ? 'battle-winner' : ''}">${fmtNum(c2)}</div>
    ${added ? `<button class="icon-btn battle-remove" type="button" data-word="${esc(word)}" aria-label="Remove “${esc(word)}”" title="Remove">✕</button>` : ""}
  </div>`;
}

/* ===========================================================================
   REPLY CHAINS — longest back-and-forth exchanges between two people
   ======================================================================== */
function renderChains() {
  const v = document.getElementById("view-chains");

  // Find longest consecutive back-and-forth exchanges (A→B→A→B...)
  const chains = [];
  let i = 0;
  while (i < N - 1) {
    const a = MSGS[i].s;
    let j = i + 1;
    // Find next message by different person within 10 min. A >10-min gap
    // restarts the outer scan at the gap message (falling through here
    // left `a` stale, so `b` could be the same person and a bogus self-chain
    // "started" across the gap).
    let gapBroke = false;
    while (j < N && (MSGS[j].s === a || MSGS[j].t - MSGS[j-1].t > 600000)) {
      if (MSGS[j].t - MSGS[j-1].t > 600000) { i = j; gapBroke = true; break; }
      j++;
    }
    if (gapBroke) continue;
    if (j >= N) break;
    const b = MSGS[j].s;
    // Now track A↔B exchange
    let chainLen = 2;
    let expected = a; // next should be A again
    let k = j + 1;
    while (k < N && MSGS[k].t - MSGS[k-1].t < 600000) {
      if (MSGS[k].s === expected) {
        chainLen++;
        expected = expected === a ? b : a;
        k++;
      } else if (MSGS[k].s === (expected === a ? b : a)) {
        // Same person sent again, skip
        k++;
      } else {
        break; // third person entered
      }
    }
    if (chainLen >= 6) {
      chains.push({
        startIdx: i, endIdx: k - 1,
        personA: a, personB: b,
        length: chainLen,
        startT: MSGS[i].t,
        duration: MSGS[k-1].t - MSGS[i].t
      });
    }
    i = k;
  }

  chains.sort((a, b) => b.length - a.length);
  const top = chains.slice(0, 40);

  let rows = "";
  top.forEach((c, idx) => {
    const durMs = c.duration;
    let durStr = durMs < 60000 ? "<1m" : durMs < 3600000 ? Math.round(durMs / 60000) + "m" : (durMs / 3600000).toFixed(1) + "h";
    // Get a preview
    let preview = "";
    for (let j = c.startIdx; j <= Math.min(c.endIdx, c.startIdx + 3); j++) {
      if (MSGS[j].x && MSGS[j].x.trim()) {
        preview += esc(nameOf(MSGS[j].s).split(" ")[0]) + ": " + esc(MSGS[j].x.trim().slice(0, 40)) + "… ";
      }
    }

    rows += `<div class="chain-card" data-idx="${c.startIdx}">
      <div class="chain-rank">#${idx + 1}</div>
      <div class="chain-meta">
        <div class="chain-people">
          ${pfpHtml(c.personA, "width:24px;height:24px;font-size:9px")}
          <span class="chain-arrow">↔</span>
          ${pfpHtml(c.personB, "width:24px;height:24px;font-size:9px")}
          <span class="chain-names">${esc(nameOf(c.personA))} & ${esc(nameOf(c.personB))}</span>
        </div>
        <div class="chain-stats">
          <span><b>${c.length}</b> exchanges</span>
          <span>${cmdIco("clock")} ${durStr}</span>
          <span>${esc(DT.format(c.startT))}</span>
        </div>
        <div class="chain-preview">${preview}</div>
      </div>
    </div>`;
  });

  v.innerHTML = `<div class="page"><div class="page-head">
    <div class="page-title">Reply Chains</div>
    <div class="page-sub">The longest back-and-forth exchanges in the chat. Found ${fmtNum(chains.length)} chains with 6+ volleys.</div></div>
  <div class="page-body"><div class="chain-list">${rows || '<div class="empty"><div class="big">' + cmdIco("chains") + '</div><div>No long reply chains found.</div></div>'}</div></div></div>`;

  v.querySelectorAll(".chain-card").forEach(card => {
    card.style.cursor = "pointer";
    asButton(card, () => jumpTo(parseInt(card.dataset.idx)));
  });
}


/* ---- Boot (all module state is declared by now) -------------------------- */
activateConversation(pickInitialConvId(), false);
if (!N) {
  document.getElementById("boot").innerHTML = '<div class="boot-card"><div class="boot-title">No messages found</div><div class="boot-sub">To build your archive from an export, double-click <code>start-setup.cmd</code> (Windows) or <code>start-setup.command</code> (macOS/Linux), or run <code>npm start</code>. To restore the demo data, run <code>node scripts/make-sample.js</code>.</div></div>';
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

})();
