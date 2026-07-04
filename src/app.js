/* =========================================================================
   Group Chat Archive — app logic (vanilla JS, no dependencies)
   ========================================================================= */
(function () {
"use strict";

/* ---- Data (multi-conversation) ------------------------------------------- */
const DATA = window.CHAT_DATA || { conversations: [] };
// True only for the shipped synthetic demo (data.sample.js sets __sample). Any
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
// would blank/crash the app if picked as active (P1-4) — prefer one that
// actually has visible messages; only fall back to saved/first if none do.
function hasVisibleMessages(c) {
  const ignored = ignoredUserIds();
  return (c.msgs || []).some((m) => !ignored.has(String(m.s)));
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
  for (let i = 0; i < N; i++) { LOWER[i] = (MSGS[i].x || "").toLowerCase(); ID2IDX.set(MSGS[i].i, i); }
}

function assignGenericNames() {
  GENERIC = {};
  PARTS.forEach((p, i) => { GENERIC[p.id] = "User " + (i + 1); });
}

// drop derived caches / per-view state so the next render uses the active conversation
function resetDerived() {
  STATS = null; WORDS = null; MILES = null; HOF = null; fuseIndex = null;
  threadsCache = null;
  searchBuilt = false; sEls = {};
  tlBuilt = false; if (virtObs) { try { virtObs.disconnect(); } catch (e) {} virtObs = null; }
  galleryState = { items: [], page: 0 }; galEls = {};
  if (galleryObserver) { try { galleryObserver.disconnect(); } catch (e) {} galleryObserver = null; }
  hofYear = "all"; wrappedYear = null; wrappedSlide = 0;
  battleP1 = null; battleP2 = null;
  for (const k in wrappedCache) delete wrappedCache[k];
  if (trendChart) { try { trendChart.destroy(); } catch (e) {} trendChart = null; }
}

function activateConversation(id, rerender) {
  const c = CONVOS.find(x => x.id === id) || CONVOS[0];
  if (!c) return;
  CONV = c;
  try { localStorage.setItem("gca.conv", c.id); } catch (e) {}
  const ignored = ignoredUserIds();
  MSGS = (c.msgs || []).filter(m => !ignored.has(String(m.s)));
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
const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#ef4444", "#10b981", "#f97316", "#a855f7", "#14b8a6", "#eab308"];
const ACCENTS = ["#3b82f6", "#2563eb", "#1d4ed8", "#0ea5e9", "#38bdf8", "#06b6d4", "#0891b2", "#6366f1", "#818cf8", "#60a5fa"];
const INTENSITY = {
  black:    { bg: "#000000", bg1: "#070708", bg2: "#0f0f13", bg3: "#1b1b22", line: "#23232c" },
  midnight: { bg: "#05070d", bg1: "#0a0e17", bg2: "#111726", bg3: "#1a2236", line: "#1e2740" },
  navy:     { bg: "#0a1020", bg1: "#0f1830", bg2: "#172242", bg3: "#22305c", line: "#2a3a66" },
};
const DENSITY = {
  comfortable: { gap: "14px", pad: "10px 14px" },
  compact:     { gap: "7px",  pad: "6px 11px" },
};
const PAGE = 60;
let DT, DAY, dShort;
// ZP: the ONE cached parts-formatter used by zonedParts() for every message.
// Rebuilt (not per-call) whenever the timezone changes — 134k msgs each call a
// formatToParts, so constructing a formatter per call is not acceptable.
let ZP = null, ZP_LOCAL = false;
function initDateFormatters() {
  const isLocal = !!(settings && settings.timezone === 'local');
  const opts = isLocal ? {} : { timeZone: (settings && settings.timezone) || 'UTC' };
  DT = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }));
  DAY = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
  dShort = new Intl.DateTimeFormat("en-US", Object.assign({}, opts, { month: "short", day: "numeric", year: "numeric" }));
  // 'local' uses native Date accessors (no formatter); every other zone shares
  // this single formatter. hour12:false so hour comes back 0-23.
  ZP_LOCAL = isLocal;
  ZP = isLocal ? null : new Intl.DateTimeFormat("en-US", Object.assign({}, opts, {
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }));
}

// Zoned calendar parts for an epoch (ms), in the CONFIGURED timezone. This is the
// single source of truth for every analytics bucket, so a message's bucket always
// agrees with its DT/DAY/dShort label (same zone, same instant).
//   -> { y, mo (0-11), d, h (0-23), mi, se, dow (0=Sun), key "YYYY-MM-DD" }
const ZP_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function zonedParts(t) {
  if (ZP_LOCAL) {
    const dt = new Date(t);
    const y = dt.getFullYear(), mo = dt.getMonth(), day = dt.getDate();
    return { y, mo, d: day, h: dt.getHours(), mi: dt.getMinutes(), se: dt.getSeconds(), dow: dt.getDay(),
      key: y + "-" + String(mo + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0") };
  }
  const p = {};
  for (const part of ZP.formatToParts(t)) p[part.type] = part.value;
  // Intl returns "24" for midnight under hour12:false in some engines; normalize.
  let h = +p.hour; if (h === 24) h = 0;
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h, mi: +p.minute, se: +p.second, dow: ZP_DOW[p.weekday],
    key: p.year + "-" + p.month + "-" + p.day };
}

// Interpret a "YYYY-MM-DD" string as the start-of-day (or end-of-day when `end`)
// instant in the CONFIGURED zone, returning epoch ms. Used by the date-range
// search filters so `before:`/`after:` mean the same wall-clock day the labels do.
function zonedDateBound(dateStr, end) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return NaN;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (ZP_LOCAL) {
    // 'local' keeps the historical new Date("YYYY-MM-DDThh:mm") behavior.
    return new Date(dateStr + (end ? "T23:59:59.999" : "T00:00:00")).getTime();
  }
  // The wall-clock instant we want, expressed as if it were UTC.
  const targetWall = end ? Date.UTC(y, mo, d, 23, 59, 59, 999) : Date.UTC(y, mo, d, 0, 0, 0, 0);
  // Two-pass offset solve: from a UTC-equals-wall guess, measure the wall-clock the
  // zone actually shows at that guess, then shift by the difference. The 2nd pass
  // re-measures so a DST change straddling the guess is corrected. At a nonexistent
  // (spring-forward) or ambiguous (fall-back) local time the passes converge on the
  // post-transition instant — the standard resolution.
  let guess = targetWall;
  for (let pass = 0; pass < 2; pass++) {
    const zp = zonedParts(guess);
    const guessWall = Date.UTC(zp.y, zp.mo, zp.d, zp.h, zp.mi, zp.se, end ? 999 : 0);
    const delta = targetWall - guessWall;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

// An epoch that falls on the given "YYYY-MM-DD" day IN the configured zone, so
// DT/DAY/dShort format it back to that exact day. Uses local noon (not midnight)
// so a spring-forward-at-midnight zone can't nudge the label to the prior day.
function dayKeyBoundInstant(k) {
  if (ZP_LOCAL) return new Date(k + "T12:00:00").getTime();
  // Start-of-day in the zone + 12h stays on the same calendar day everywhere.
  return zonedDateBound(k, false) + 12 * 3600000;
}
// Subtract n days from a "YYYY-MM-DD" key via UTC arithmetic (calendar-correct,
// independent of any zone offset).
function isoDayKeyMinus(k, n) {
  const t = Date.parse(k + "T00:00:00Z") - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
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
const DEFAULTS = {
  names: {}, pfps: {}, gc: {}, gcName: "", gcPhoto: "",
  colors: {}, me: null, accent: "#3b82f6", intensity: "midnight", fontSize: 15, density: "comfortable", avatars: true, timestamps: true, saved: [], pins: [], ignoredUsers: [], ignoredGroups: [], timezone: "UTC"
};
let settings = loadSettings();
migratePfpsKey();
initDateFormatters();
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("gca.settings") || "{}");
    const s = Object.assign({}, DEFAULTS, saved);
    s.names = Object.assign({}, DEFAULTS.names, saved.names || {});
    s.pfps = loadPfps(saved.pfps);
    s.gc = loadGc(saved.gc);
    s.colors = Object.assign({}, DEFAULTS.colors, saved.colors || {});
    if (!s.me && LOCAL_ME) s.me = LOCAL_ME;   // honor the wizard's "this is you"
    s.pins = Array.isArray(saved.pins) ? saved.pins.slice() : [];   // own array, never share DEFAULTS.pins
    s.ignoredUsers = Array.isArray(saved.ignoredUsers) ? saved.ignoredUsers.map(String) : [];
    s.ignoredGroups = Array.isArray(saved.ignoredGroups) ? saved.ignoredGroups.map(String) : [];
    if (!Array.isArray(s.saved)) s.saved = [];
    return s;
  } catch (e) { 
    // clone deeply to prevent mutation
    return JSON.parse(JSON.stringify(DEFAULTS)); 
  }
}
const PFPS_KEY = "gca.pfps";
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
const GC_KEY = "gca.gc";
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
function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hexA(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; }
function shade(h, p) { let [r, g, b] = hexToRgb(h); const t = p < 0 ? 0 : 255; const f = Math.abs(p) / 100; r = Math.round((t - r) * f + r); g = Math.round((t - g) * f + g); b = Math.round((t - b) * f + b); return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function hashId(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }
// Day bucket for an epoch, in the configured zone ("YYYY-MM-DD"). Callers group
// by equality; the human-readable busiest-day label formats via zone-aware DAY.
function dayKey(t) { return zonedParts(t).key; }
function fmtNum(n) { return n.toLocaleString("en-US"); }

function nameOf(id) { return settings.names[id] || LOCAL_NAMES[id] || GENERIC[id] || ("User " + String(id).slice(-4)); }
function colorOf(id) { return settings.colors[id] || PALETTE[hashId(id) % PALETTE.length]; }

/* ---- Bookmarks / Pinned messages ----------------------------------------- */
function isPinned(msgId) { return settings.pins.indexOf(msgId) >= 0; }
function togglePin(msgId) {
  const at = settings.pins.indexOf(msgId);
  if (at >= 0) { settings.pins.splice(at, 1); toast("Removed bookmark"); }
  else { settings.pins.push(msgId); toast("★ Bookmarked"); }
  saveSettings();
  // keep any open pin buttons in sync
  document.querySelectorAll('.act-pin[data-mid="' + cssEsc(msgId) + '"]').forEach((b) => {
    const on = isPinned(msgId); b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; b.title = on ? "Remove bookmark" : "Bookmark";
  });
  if (curView === "pins") renderPins();
}
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

/* ---- Accessibility: modal dialog focus management ------------------------ */
// Overlays (lightbox, command palette, profile/context modals) are plain divs.
// These helpers make them behave like real dialogs: expose role/aria-modal, trap
// Tab focus inside, move focus in on open, and restore focus to the opener on close.
let modalOpener = null;
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])';
function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE_SEL)]
    .filter((n) => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
}
function trapTab(e) {
  if (e.key !== "Tab") return;
  const box = e.currentTarget;
  const f = focusablesIn(box);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], act = document.activeElement;
  if (e.shiftKey && (act === first || !box.contains(act))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (act === last || !box.contains(act))) { e.preventDefault(); first.focus(); }
}
function applyDialog(box, label, opts) {
  opts = opts || {};
  if (!opts.keepOpener) modalOpener = document.activeElement;   // remember who opened it
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  if (label) box.setAttribute("aria-label", label);
  box.addEventListener("keydown", trapTab);
  const initial = (opts.initial && box.querySelector(opts.initial)) || focusablesIn(box)[0];
  if (initial && initial.focus) { try { initial.focus(); } catch (e) {} }
}
function restoreFocus() {
  if (modalOpener && modalOpener.focus && document.contains(modalOpener)) { try { modalOpener.focus(); } catch (e) {} }
  modalOpener = null;
}

/* ---- Time → index (binary search; MSGS is sorted ascending by t) --------- */
function indexForTime(t) {
  let lo = 0, hi = N - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (MSGS[mid].t <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
// First message index on/after the given date string (YYYY-MM-DD), interpreted
// as start-of-day in the configured zone so it matches the on-screen day labels.
function indexForDate(dateStr) {
  const t = zonedDateBound(dateStr, false);
  if (isNaN(t)) return -1;
  let lo = 0, hi = N - 1, ans = N - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (MSGS[mid].t >= t) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}
function initials(name) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

// No committed profile pictures (the real ones are private). Sources, lowest to
// highest priority: a gitignored local.js (window.LOCAL_PFPS, file paths) and
// in-app uploads stored as data URLs in settings.pfps (so file:// editing works
// without the server). Mutated in place by the People-tab pfp uploader.
const PFPS = Object.assign({}, (typeof window !== "undefined" && window.LOCAL_PFPS) || {}, settings.pfps);

function applyPfp(av, id) {
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
    av.style.background = colorOf(id);
    av.textContent = initials(nameOf(id));
  }
}

function pfpHtml(id, styleStr) {
  const photo = sanitizePhoto(PFPS[id]);
  if (photo) {
    return `<span class="av av-clickable" data-id="${esc(id)}" style="${styleStr};background-image:url('${esc(photo)}');background-size:cover;background-position:center;background-repeat:no-repeat;"></span>`;
  }
  return `<span class="av av-clickable" data-id="${esc(id)}" style="${styleStr};background:${colorOf(id)}">${esc(initials(nameOf(id)))}</span>`;
}

/* ---- Participants & derived stats (computed once) ------------------------ */
// PARTS is computed per-conversation by activateConversation()
let STATS = null, WORDS = null;
// Messages containing a Twitter/X link are useless for telling people apart, so
// they're excluded from the naming samples entirely (not only when they *start*
// with a URL). A few shared-media paths are collected as extra memory jogs.
const X_LINK = /(?:https?:\/\/)?(?:t\.co|(?:[\w-]+\.)?twitter\.com|(?:[\w-]+\.)?x\.com)\//i;
function computeParticipants() {
  const map = new Map();
  for (let i = 0; i < N; i++) {
    const m = MSGS[i]; let p = map.get(m.s);
    if (!p) { p = { id: m.s, count: 0, first: m.t, last: m.t, samples: [], media: [] }; map.set(m.s, p); }
    p.count++; if (m.t < p.first) p.first = m.t; if (m.t > p.last) p.last = m.t;
    if (p.samples.length < 120) { const t = (m.x || "").trim(); if (t.length > 14 && !/^https?:/.test(t) && !X_LINK.test(t)) p.samples.push(t); }
    if (m.m && p.media.length < 6) p.media.push({ m: m.m, k: m.k });
  }
  const arr = [...map.values()].sort((a, b) => b.count - a.count);
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
  const r = document.documentElement.style;
  r.setProperty("--accent", settings.accent);
  r.setProperty("--accent-soft", shade(settings.accent, -20));
  r.setProperty("--accent-glow", hexA(settings.accent, 0.25));
  const ic = INTENSITY[settings.intensity] || INTENSITY.midnight;
  r.setProperty("--bg", ic.bg); r.setProperty("--bg-1", ic.bg1); r.setProperty("--bg-2", ic.bg2);
  r.setProperty("--bg-3", ic.bg3); r.setProperty("--line", ic.line);
  r.setProperty("--font-size", settings.fontSize + "px");
  const dc = DENSITY[settings.density] || DENSITY.comfortable;
  r.setProperty("--gap", dc.gap); r.setProperty("--bubble-pad", dc.pad);
  const app = document.getElementById("app");
  app.classList.toggle("no-avatars", !settings.avatars);
  app.classList.toggle("no-timestamps", !settings.timestamps);
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
  const nm = el("span", "msg-name"); nm.textContent = nameOf(id); nm.style.color = colorOf(id);
  const tm = el("span", "msg-time"); tm.textContent = DT.format(m.t);
  head.appendChild(nm); head.appendChild(tm); body.appendChild(head);

  const acts = el("div", "msg-acts");
  const pinned = isPinned(m.i);
  const actPin = el("button", "act-pin" + (pinned ? " on" : ""), pinned ? "★" : "☆");
  actPin.dataset.mid = m.i; actPin.title = pinned ? "Remove bookmark" : "Bookmark";
  actPin.onclick = (e) => { e.stopPropagation(); togglePin(m.i); };
  const actCopy = el("button", "", "Copy"); actCopy.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(m.x); toast("Copied text"); };
  const actCtx = el("button", "", "Context"); actCtx.onclick = (e) => { e.stopPropagation(); openContextPeek(i); };
  const actQuote = el("button", "", "Quote"); actQuote.onclick = (e) => { e.stopPropagation(); exportQuoteCard(i); };
  const actJump = el("button", "", "Jump"); actJump.onclick = (e) => { e.stopPropagation(); jumpTo(i); };
  acts.appendChild(actPin); acts.appendChild(actCopy); acts.appendChild(actCtx);
  if ((m.x || "").trim()) acts.appendChild(actQuote);
  acts.appendChild(actJump);
  body.appendChild(acts);

  const txt = (m.x || "").trim();
  if (txt) {
    const bubbleEl = el("div", "bubble");
    bubbleEl.innerHTML = renderText(m.x, m.u);
    if (isConsecutive) bubbleEl.dataset.time = DT.format(m.t);
    highlightDOM(bubbleEl, opts.needles);
    body.appendChild(bubbleEl);
  }
  if (m.m) body.appendChild(renderMedia(m, i));
  if (m.r) body.appendChild(renderReacts(m.r));
  wrap.appendChild(body);

  if (opts.clickable) {
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "button");
    wrap.addEventListener("click", () => jumpTo(i));
    wrap.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jumpTo(i); } });
  }
  return wrap;
}
function renderMedia(m, i) {
  const d = el("div", "media");
  if (m.k === "img") {
    const img = el("img"); img.loading = "lazy"; img.src = m.m;
    img.alt = "Photo from " + nameOf(m.s) + " · " + DT.format(m.t);
    img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(i); });
    d.appendChild(img);
  } else if (m.k === "vid") {
    const v = document.createElement("video"); v.src = m.m; v.controls = true; v.preload = "none";
    v.setAttribute("aria-label", "Video from " + nameOf(m.s) + " · " + DT.format(m.t));
    v.addEventListener("click", (e) => e.stopPropagation());
    d.appendChild(v);
  } else {
    const a = el("a", "urlchip"); a.href = m.m; a.target = "_blank"; a.textContent = "📎 media file"; d.appendChild(a);
  }
  return d;
}
function renderReacts(r) {
  const wrap = el("div", "reacts");
  const byK = {}; r.forEach((x) => { (byK[x.k] = byK[x.k] || []).push(x.s); });
  Object.keys(byK).forEach((k) => {
    const c = el("span", "react", (REACT[k] || "•") + ' <span class="who">' + byK[k].length + "</span>");
    c.title = k + " — " + byK[k].map(nameOf).join(", ");
    wrap.appendChild(c);
  });
  return wrap;
}

/* ---- Lightbox ------------------------------------------------------------ */
let lbState = { idxList: [], pos: 0, box: null };

function openLightbox(i) {
  if (document.querySelector(".lightbox")) document.querySelector(".lightbox").remove();
  
  const list = curView === "search" ? resState.idx.filter(idx => MSGS[idx].m) : MSGS.map((_, idx) => idx).filter(idx => MSGS[idx].m);
  if (!list.length) return;
  lbState.idxList = list;
  let pos = list.indexOf(i);
  if (pos < 0) {
    const found = list.findIndex(idx => idx >= i);
    pos = found >= 0 ? found : 0;
  }
  lbState.pos = Math.max(0, Math.min(pos, list.length - 1));
  modalOpener = document.activeElement;   // remember focus to restore on close
  renderLightbox();
}

function renderLightbox() {
  if (lbState.box) lbState.box.remove();
  const i = lbState.idxList[lbState.pos];
  const m = MSGS[i];
  const box = el("div", "lightbox");
  lbState.box = box;
  
  const close = () => { box.remove(); lbState.box = null; document.removeEventListener("keydown", lbKeyHandler); restoreFocus(); };
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  
  const x = el("button", "lb-close", "✕"); x.onclick = close; box.appendChild(x);
  
  const dl = el("a", "lb-dl", "↓ Download");
  dl.href = m.m;
  dl.download = m.m.split('/').pop() || "media";
  dl.onclick = (e) => e.stopPropagation();
  box.appendChild(dl);

  const lbPin = el("button", "lb-pin act-pin" + (isPinned(m.i) ? " on" : ""), isPinned(m.i) ? "★ Bookmarked" : "☆ Bookmark");
  lbPin.dataset.mid = m.i;
  lbPin.onclick = (e) => { e.stopPropagation(); togglePin(m.i); lbPin.textContent = isPinned(m.i) ? "★ Bookmarked" : "☆ Bookmark"; lbPin.classList.toggle("on", isPinned(m.i)); };
  box.appendChild(lbPin);

  if (lbState.pos > 0) {
    const prev = el("button", "lb-nav lb-prev", "‹");
    prev.onclick = (e) => { e.stopPropagation(); lbState.pos--; renderLightbox(); };
    box.appendChild(prev);
  }
  if (lbState.pos < lbState.idxList.length - 1) {
    const next = el("button", "lb-nav lb-next", "›");
    next.onclick = (e) => { e.stopPropagation(); lbState.pos++; renderLightbox(); };
    box.appendChild(next);
  }
  
  let mediaEl;
  if (m.k === "vid") {
    mediaEl = document.createElement("video"); mediaEl.src = m.m; mediaEl.controls = true; mediaEl.autoplay = true;
    mediaEl.onclick = (e) => e.stopPropagation();
  } else {
    mediaEl = el("img"); mediaEl.src = m.m; mediaEl.alt = "Photo from " + nameOf(m.s) + " · " + DT.format(m.t);
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
  cap.innerHTML = esc(nameOf(m.s) + " · " + DT.format(m.t)) + '  —  <a href="#" style="color:var(--accent)">jump to message ↗</a>';
  cap.querySelector("a").onclick = (e) => { e.preventDefault(); close(); jumpTo(i); };
  box.appendChild(cap);
  
  document.body.appendChild(box);
  applyDialog(box, "Media viewer", { initial: ".lb-close", keepOpener: true });

  document.removeEventListener("keydown", lbKeyHandler);
  document.addEventListener("keydown", lbKeyHandler);
}

function lbKeyHandler(e) {
  if (e.key === "Escape") { if(lbState.box) lbState.box.remove(); lbState.box = null; document.removeEventListener("keydown", lbKeyHandler); restoreFocus(); }
  if (e.key === "ArrowLeft" && lbState.pos > 0) { lbState.pos--; renderLightbox(); }
  if (e.key === "ArrowRight" && lbState.pos < lbState.idxList.length - 1) { lbState.pos++; renderLightbox(); }
}

/* ---- Toast --------------------------------------------------------------- */
let toastT = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", "toast", esc(msg)); document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(() => { t.classList.add("fade-out"); setTimeout(() => t.remove(), 300); }, 2200);
}

/* ===========================================================================
   SEARCH VIEW
   ======================================================================== */
const F = { needles: [], people: new Set(), from: null, to: null, media: false, links: false, reacts: false, grid: false, sort: "relevance", fuzzy: true };
let searchBuilt = false;
let sEls = {};
let resState = { idx: [], page: 0 };
let resObserver = null;

function ensureSearch() {
  if (searchBuilt) return;
  searchBuilt = true;
  const v = document.getElementById("view-search");
  v.innerHTML = `
    <div class="toolbar">
      <div class="search-row">
        <div class="search-box">
          <span class="ico">⌕</span>
          <input id="s-input" type="text" placeholder="Search ${fmtNum(N)} messages…  (use &quot;quotes&quot; for exact phrases)" autocomplete="off" spellcheck="false" />
          <button class="search-clear" id="s-clear" title="Clear" hidden>✕</button>
        </div>
      </div>
      <div class="filters">
        <div class="popwrap">
          <button class="pill" id="f-people">◉ People <span class="badge" id="f-people-n" hidden>0</span></button>
        </div>
        <label class="pill" id="f-date"><span>From</span><input type="date" id="f-from" /><span>to</span><input type="date" id="f-to" /></label>
        <button class="pill" id="f-media">📷 Media</button>
        <button class="pill" id="f-links">🔗 Links</button>
        <button class="pill" id="f-reacts">💬 Reactions</button>
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
      </div>
      <div class="match-hint" id="s-matchhint"></div>
      <div class="result-meta" id="s-meta"></div>
    </div>
    <div class="scroll" id="s-scroll"><div class="list" id="s-list"></div></div>
    <button class="back-to-top" id="s-btt" hidden title="Back to top">↑</button>`;

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
  };

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

  // input
  let deb = null;
  sEls.input.addEventListener("input", () => {
    sEls.clear.hidden = !sEls.input.value;
    clearTimeout(deb); deb = setTimeout(runSearch, 150);
  });
  sEls.clear.addEventListener("click", () => { sEls.input.value = ""; sEls.clear.hidden = true; runSearch(); sEls.input.focus(); });

  // toggles
  sEls.media.onclick = () => { F.media = !F.media; sEls.media.classList.toggle("active", F.media); runSearch(); };
  sEls.links.onclick = () => { F.links = !F.links; sEls.links.classList.toggle("active", F.links); runSearch(); };
  sEls.reacts.onclick = () => { F.reacts = !F.reacts; sEls.reacts.classList.toggle("active", F.reacts); runSearch(); };
  sEls.from.onchange = () => { F.from = sEls.from.value ? zonedDateBound(sEls.from.value, false) : null; sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to)); runSearch(); };
  sEls.to.onchange = () => { F.to = sEls.to.value ? zonedDateBound(sEls.to.value, true) : null; sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to)); runSearch(); };

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

  runSearch();
}

function parseQuery(raw) {
  const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().trim()).filter(Boolean);
  const rest = raw.replace(/"[^"]+"/g, " ");
  const terms = rest.toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return phrases.concat(terms);
}
let excludeNeedles = [];
// Transient operator overlay (P2-2): from:/sender:/before:/after: tokens are
// re-parsed from the query text on every run into these, instead of mutating
// the persistent F.people/F.from/F.to filter-panel state. They combine with
// (narrow further than) whatever the manual filter panel has set, and never
// survive past the run that produced them — clearing the query drops them.
let opPeople = null, opFrom = null, opTo = null;
function testMsgNoNeedle(i) {
  const m = MSGS[i];
  if (F.people.size && !F.people.has(m.s)) return false;
  if (F.from != null && m.t < F.from) return false;
  if (F.to != null && m.t > F.to) return false;
  if (opPeople && !opPeople.has(m.s)) return false;
  if (opFrom != null && m.t < opFrom) return false;
  if (opTo != null && m.t > opTo) return false;
  if (F.media && !m.m) return false;
  if (F.links && !m.u) return false;
  if (F.reacts && !m.r) return false;
  if (excludeNeedles.length > 0) {
    const text = LOWER[i];
    for (const term of excludeNeedles) {
      if (text.indexOf(term) >= 0) return false;
    }
  }
  return true;
}
let fuseIndex = null;
function runSearch() {
  let q = sEls.input.value || "";

  // Reset exclusions and the operator overlay — both re-parsed each run.
  excludeNeedles = [];
  opPeople = null; opFrom = null; opTo = null;

  // 1. Parse has:media, has:links, has:reacts from query text (additive to pill state)
  q = q.replace(/\bhas:(media|links|reacts|reactions)\b/ig, (match, p1) => {
    const type = p1.toLowerCase();
    if (type === "media") F.media = true;
    if (type === "links") F.links = true;
    if (type === "reacts" || type === "reactions") F.reacts = true;
    return "";
  });

  // 2. Parse from:name or sender:name into a transient overlay (never F.people).
  // The name value must be followed by whitespace to take effect. Unlike the
  // fixed-length date operators below, a name is an open-ended prefix while
  // being typed (e.g. "from:bo" mid-keystroke toward "from:bob") — treating
  // end-of-string as a boundary here would fire on every partial keystroke,
  // which is exactly the P2-2 pollution bug. Requiring an explicit trailing
  // space is what the checkpoint's "from:bo" (no effect) vs "from:bob "
  // (takes effect) example exercises.
  q = q.replace(/\b(from|sender):(\w+|"[^"]+")(?=\s)/ig, (match, op, val) => {
    const name = val.replace(/"/g, "").toLowerCase().trim();
    const matches = PARTS.filter(p => nameOf(p.id).toLowerCase().includes(name));
    if (!opPeople) opPeople = new Set();
    matches.forEach(p => opPeople.add(p.id));
    return "";
  });

  // 3. Parse before:YYYY-MM-DD and after:YYYY-MM-DD into the transient overlay.
  // Reuses zonedDateBound (SP4) so the operator respects the configured
  // timezone the same way the manual From/To pills do. The manual pills'
  // value/active-state are left untouched — operators must not alter the
  // persistent filter-panel display.
  q = q.replace(/\bbefore:(\d{4}-\d{2}-\d{2})(?=\s|$)/ig, (match, dateStr) => {
    opTo = zonedDateBound(dateStr, true);
    return "";
  });
  q = q.replace(/\bafter:(\d{4}-\d{2}-\d{2})(?=\s|$)/ig, (match, dateStr) => {
    opFrom = zonedDateBound(dateStr, false);
    return "";
  });

  // 4. Parse exclusions: -word or -"exact phrase"
  q = q.replace(/(?:^|\s)-(\w+|"[^"]+")/g, (match, term) => {
    excludeNeedles.push(term.replace(/"/g, "").toLowerCase().trim());
    return "";
  });

  // Toggle active class on pills (manual/persistent state only — the overlay
  // never touches these, so typing operators can't alter the filter panel).
  sEls.media.classList.toggle("active", F.media);
  sEls.links.classList.toggle("active", F.links);
  sEls.reacts.classList.toggle("active", F.reacts);
  updatePeopleBadge();

  F.needles = parseQuery(q);
  updateClearAllBtn();

  const out = [];
  if (F.needles.length > 0) {
    // Fuzzy (default): Fuse.js typo-tolerant ranking. Exact: literal substring AND-match.
    const useFuzzy = F.fuzzy && window.Fuse;
    let baseIdx = [];
    if (useFuzzy) {
      if (!fuseIndex) fuseIndex = new Fuse(LOWER, { threshold: 0.3, ignoreLocation: true });
      baseIdx = fuseIndex.search(F.needles.join(" ")).map(r => r.refIndex);
    } else {
      for (let i = N - 1; i >= 0; i--) {
        const L = LOWER[i];
        let match = true;
        for (const n of F.needles) if (L.indexOf(n) < 0) { match = false; break; }
        if (match) baseIdx.push(i);
      }
    }
    for (let i of baseIdx) if (testMsgNoNeedle(i)) out.push(i);
  } else {
    for (let i = N - 1; i >= 0; i--) if (testMsgNoNeedle(i)) out.push(i);
  }

  // Apply sort order (relevance = leave as-built: Fuse order, or newest-first)
  if (F.sort === "newest") out.sort((a, b) => MSGS[b].t - MSGS[a].t);
  else if (F.sort === "oldest") out.sort((a, b) => MSGS[a].t - MSGS[b].t);
  else if (F.sort === "reactions") out.sort((a, b) => ((MSGS[b].r ? MSGS[b].r.length : 0) - (MSGS[a].r ? MSGS[a].r.length : 0)) || (MSGS[b].t - MSGS[a].t));
  else if (F.sort === "longest") out.sort((a, b) => ((MSGS[b].x || "").length - (MSGS[a].x || "").length) || (MSGS[b].t - MSGS[a].t));

  resState.idx = out; resState.page = 0;
  sEls.list.className = F.grid ? "gallery" : "list";
  sEls.list.innerHTML = "";
  if (resObserver) resObserver.disconnect();

  const hasFilter = F.needles.length || F.people.size || F.from || F.to || F.media || F.links || F.reacts || opPeople || opFrom || opTo;
  const sortLbl = { relevance: F.needles.length && F.fuzzy && window.Fuse ? "relevance" : "newest", newest: "newest", oldest: "oldest", reactions: "most reactions", longest: "longest" }[F.sort];
  sEls.meta.textContent = hasFilter
    ? fmtNum(out.length) + (out.length === 1 ? " message" : " messages") + " found" + (F.grid ? " · showing media only" : "") + " · sorted by " + sortLbl
    : "Showing all " + fmtNum(out.length) + " messages, newest first — start typing or add a filter. Supports 'has:media', 'has:links', 'from:name', 'before:YYYY-MM-DD'";

  if (!out.length) {
    sEls.list.className = "list";
    sEls.list.appendChild(el("div", "empty", '<div class="big">🔍</div><div>No messages match your search.</div><div class="hint">Try fewer words or clear a filter.</div>'));
    return;
  }
  appendResultsPage();
}
function appendResultsPage() {
  const { idx, page } = resState;
  const start = page * PAGE;
  if (start >= idx.length) return;
  const slice = idx.slice(start, start + PAGE);
  const frag = document.createDocumentFragment();
  for (const i of slice) {
    if (F.grid) { if (MSGS[i].m) frag.appendChild(galleryCell(i)); }
    else frag.appendChild(renderMsg(i, { clickable: true, needles: F.needles }));
  }
  sEls.list.appendChild(frag);
  resState.page++;
  // re-arm sentinel
  const old = sEls.list.querySelector(".sentinel"); if (old) old.remove();
  if (resState.page * PAGE < idx.length) {
    const sentinel = el("div", "sentinel"); sEls.list.appendChild(sentinel);
    resObserver.observe(sentinel);
  }
}
function galleryCell(i) {
  const m = MSGS[i], c = el("div", "gcell");
  // P2-4: kindOf() can return "file" for unknown extensions (e.g. .pdf) — that
  // is neither "img" nor "vid", so it must not fall into the video branch
  // (which renders an empty, broken <video>). Reuse renderMedia's file-chip
  // markup instead of forking a third pattern.
  if (m.k === "img") { const img = el("img"); img.loading = "lazy"; img.src = m.m; c.appendChild(img); }
  else if (m.k === "vid") { const v = document.createElement("video"); v.src = m.m; v.preload = "metadata"; c.appendChild(v); c.appendChild(el("div", "play", "▶")); }
  else { const chip = renderMedia(m, i); chip.classList.add("gallery-cell"); c.appendChild(chip); }
  c.title = nameOf(m.s) + " · " + DT.format(m.t);
  c.onclick = () => openLightbox(i);
  return c;
}

/* ---- People filter popover ----------------------------------------------- */
function togglePeoplePopover() {
  closePopovers();
  const wrap = sEls.people.parentElement;
  const pop = el("div", "popover");
  PARTS.forEach((p) => {
    const item = el("div", "pop-item");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = F.people.has(p.id);
    const av = el("span", "av"); applyPfp(av, p.id);
    const lbl = el("span", "", esc(nameOf(p.id)) + ' <span style="color:var(--text-faint)">· ' + fmtNum(p.count) + "</span>");
    item.appendChild(cb); item.appendChild(av); item.appendChild(lbl);
    item.onclick = (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
      if (cb.checked) F.people.add(p.id); else F.people.delete(p.id);
      updatePeopleBadge(); runSearch();
    };
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
  const fuzzy = '<b>Fuzzy</b>: finds close &amp; misspelled matches (typo-tolerant, ranked by relevance).';
  const exact = '<b>Exact</b>: shows only messages that literally contain every word/phrase you type.';
  // Lead with the active mode's description so the user knows what's in effect.
  sEls.matchhint.innerHTML = F.fuzzy ? fuzzy + " &nbsp;·&nbsp; " + exact : exact + " &nbsp;·&nbsp; " + fuzzy;
}
function updateClearAllBtn() {
  const hasFilter = (F.needles && F.needles.length) || F.people.size || F.from || F.to || F.media || F.links || F.reacts || (sEls.input && sEls.input.value.trim());
  if (sEls.clearAll) sEls.clearAll.hidden = !hasFilter;
}
function clearAllFilters() {
  sEls.input.value = ""; sEls.clear.hidden = true;
  F.media = false; F.links = false; F.reacts = false;
  F.people.clear(); F.from = null; F.to = null;
  sEls.from.value = ""; sEls.to.value = "";
  sEls.from.closest(".pill").classList.remove("active");
  sEls.media.classList.remove("active");
  sEls.links.classList.remove("active");
  sEls.reacts.classList.remove("active");
  updatePeopleBadge();
  runSearch();
  sEls.input.focus();
}
function exportResults() {
  if (!resState.idx.length) { toast("No results to export"); return; }
  const lines = resState.idx.map(i => {
    const m = MSGS[i];
    return DT.format(m.t) + " | " + nameOf(m.s) + ": " + (m.x || "[media]");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "search-results-" + new Date().toISOString().slice(0,10) + ".txt";
  a.click(); URL.revokeObjectURL(url);
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
    const item = el("div", "pop-item");
    item.style.justifyContent = "space-between";
    const left = el("span", "", "★ " + esc(s.name));
    const del = el("button", "icon-btn", "🗑"); del.title = "Delete";
    del.onclick = (e) => { e.stopPropagation(); settings.saved.splice(idx, 1); saveSettings(); toggleSavedPopover(); };
    item.appendChild(left); item.appendChild(del);
    item.onclick = (e) => { if (e.target === del) return; applySaved(s); closePopovers(); };
    pop.appendChild(item);
  });
  wrap.appendChild(pop);
}
function applySaved(s) {
  sEls.input.value = s.q || ""; sEls.clear.hidden = !sEls.input.value;
  const f = s.f || {};
  F.people = new Set(f.people || []); updatePeopleBadge();
  sEls.from.value = f.from || ""; sEls.to.value = f.to || "";
  F.from = f.from ? zonedDateBound(f.from, false) : null;
  F.to = f.to ? zonedDateBound(f.to, true) : null;
  sEls.from.closest(".pill").classList.toggle("active", !!(F.from || F.to));
  F.media = !!f.media; F.links = !!f.links; F.reacts = !!f.reacts;
  sEls.media.classList.toggle("active", F.media);
  sEls.links.classList.toggle("active", F.links);
  sEls.reacts.classList.toggle("active", F.reacts);
  runSearch();
}
function closePopovers() { document.querySelectorAll(".popover").forEach((p) => p.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".popwrap")) closePopovers(); });

/* ===========================================================================
   TIMELINE VIEW & VIRTUAL SCROLLER
   ======================================================================== */
let tlBuilt = false, tlEls = {}, virtObs = null;
const CHUNK_SIZE = 50;
let numChunks = 0, chunkHeights = [], chunkRendered = [];

function ensureTimelineShell() {
  if (tlBuilt) return;
  tlBuilt = true;
  const v = document.getElementById("view-timeline");
  v.innerHTML = `
    <div class="scroll" id="tl-scroll" style="position:relative;">
      <div class="list" id="tl-list"></div>
    </div>
  `;
  tlEls = { scroll: v.querySelector("#tl-scroll"), list: v.querySelector("#tl-list") };

  virtObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const idx = +e.target.dataset.c;
      if (e.isIntersecting) {
        renderChunk(idx, e.target);
      } else if (chunkRendered[idx]) {
        chunkHeights[idx] = e.target.offsetHeight || 1000;
        e.target.style.height = chunkHeights[idx] + "px";
        e.target.innerHTML = "";
        chunkRendered[idx] = false;
      }
    });
  }, { root: tlEls.scroll, rootMargin: "1500px" });
}

function openTimeline(anchor) {
  ensureTimelineShell();
  // Every sender ignored (P1-4): no chunks to build, and renderChunk() would
  // dereference MSGS[start]/MSGS[N-1] on an empty array. Show a panel instead.
  if (!N) {
    tlEls.list.innerHTML = '<div class="empty"><div class="big">≡</div><div>No messages in this group — every sender is ignored.</div></div>';
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
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "auto" });
    target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1700);
  }
  
  // Re-enable smooth scrolling after jumping
  setTimeout(() => tlEls.scroll.style.scrollBehavior = "", 10);
}

function renderChunk(idx, container) {
  if (chunkRendered[idx]) return;
  container.innerHTML = "";
  const start = idx * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, N);
  const lo = MSGS[start].t;
  const hi = end < N ? MSGS[end - 1].t : MSGS[N - 1].t;

  const items = [];
  for (let i = start; i < end; i++) items.push({ t: MSGS[i].t, kind: "m", i });
  EVENTS.forEach((e) => { if (e.t >= lo && e.t <= hi) items.push({ t: e.t, kind: "e", e }); });
  items.sort((a, b) => a.t - b.t);

  let prevDay = null;
  let prevSenderId = null;
  let prevTimestamp = 0;
  const frag = document.createDocumentFragment();
  items.forEach((it) => {
    const dk = dayKey(it.t);
    if (dk !== prevDay) {
      frag.appendChild(el("div", "daysep", esc(DAY.format(it.t))));
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

function renderEvent(e) {
  let txt = "";
  if (e.type === "name") txt = nameOf(e.s) + " named the group “" + e.name + "”";
  else if (e.type === "join") txt = (e.s ? nameOf(e.s) + " added " : "Added ") + (e.ids || []).map(nameOf).join(", ");
  else if (e.type === "leave") txt = (e.ids || []).map(nameOf).join(", ") + " left";
  else if (e.type === "create") txt = (e.s ? nameOf(e.s) : "Someone") + " created the conversation";
  return el("div", "sysline", "<span>" + esc(txt) + "</span>");
}
function jumpTo(i) { setView("timeline"); openTimeline(i); }

/* ===========================================================================
   STATS VIEW
   ======================================================================== */
function computeStats() {
  if (STATS) return STATS;
  // Every sender in this conversation is ignored (P1-4) — MSGS[0]/MSGS[N-1]
  // below would throw. Nothing to compute; renderStats() shows an empty panel.
  if (!N) return (STATS = { empty: true });
  const perPerson = {}, months = {}, days = {}, emojis = {}, hourCount = new Array(24).fill(0);
  const weekdayCount = new Array(7).fill(0);
  
  // Superlative counters
  const nightCount = {};      // user -> late night msg count
  const emojiCount = {};      // user -> emoji count
  const mediaCount = {};      // user -> media count
  const reactsCount = {};     // user -> reactions received count
  const responseStats = {};   // user -> { sum: 0, count: 0 }
  const replyPairStats = {};  // "userA→userB" -> count (userB replied to userA)

  // NEW Exhaustive Stats
  const wordsTotal = {};
  const msgWithWords = {};
  const swearCount = {};
  const capsCount = {};
  const questionCount = {};
  const narcissistCount = {};
  const comedianCount = {};
  const linkCount = {};
  const reactorCount = {};
  const doubleTextCount = {};
  const weekendCount = {};
  const slackerCount = {};
  const starterCount = {};
  const killerCount = {};

  // Wave 2 Stats
  const uniqueWords = {};
  const periodCount = {};
  const ellipsisCount = {};
  const singleCharCount = {};
  const maxMsgLen = {};
  const lowerMsgCount = {};
  const keysmashCount = {};
  
  const earlyBirdCount = {};
  const vampiricOwlCount = {};
  const holidayCount = {};
  const maxGapCount = {};
  const monologuerCount = {};
  let consecutiveCount = 1; // the first message is itself a run of length 1
  
  const zeroReactCount = {};
  const selfReactCount = {};
  const laughReactCount = {};
  const hateReactCount = {};
  
  const tiktokCount = {};
  const youtubeCount = {};
  const twitterCount = {};
  const instaCount = {};
  
  const hashtagCount = {};
  const mentionCount = {};

  // Wave 3 Stats
  const hesitatorCount = {};
  const apologistCount = {};
  const gratitudeCount = {};
  const agreeableCount = {};
  const disagreerCount = {};
  const selfCorrectorCount = {};
  const laughVoidCount = {};
  const exclaimerCount = {};
  const numberCruncherCount = {};
  const fourTwentyCount = {};
  const midnightSniperCount = {};
  const birthdayCount = {};

  // Wave 4 Stats
  const optimistCount = {};
  const pessimistCount = {};
  const confusedCount = {};
  const zoomerCount = {};
  const gamerCount = {};
  const financeBroCount = {};
  const paragrapherCount = {};
  const screamerCount = {};
  const multiQuestionerCount = {};

  const holidayMap = { "12-25": 1, "12-31": 1, "01-01": 1, "10-31": 1, "02-14": 1 };
  const lastMsgTime = {};

  const profanityRegex = /\b(fuck|shit|bitch|damn|asshole|cunt|dick|pussy|cock|bastard|slut|whore)\b/i;
  const narcissistRegex = /\b(i|me|my|mine)\b/gi;
  const comedianRegex = /\b(lol|lmao|lmfao|rofl|💀|😭)\b/gi;
  const hesitatorRegex = /\b(um|uh|hmm|like)\b/gi;
  const apologistRegex = /\b(sorry|my bad|apologies|whoops)\b/gi;
  const gratitudeRegex = /\b(thanks|thank you|ty|thx)\b/gi;
  const agreeableRegex = /\b(yeah|yes|yep|agreed|yea)\b/gi;
  const disagreerRegex = /\b(no|nope|nah|disagree)\b/gi;
  const birthdayRegex = /\b(happy birthday|hbd)\b/gi;
  const laughVoidRegex = /^(lol|lmao|lmfao|rofl|💀|😭|\s)+$/i;
  
  const optimistRegex = /\b(good|great|awesome|amazing|love|best)\b/gi;
  const pessimistRegex = /\b(bad|terrible|awful|hate|worst)\b/gi;
  const confusedRegex = /\b(what|huh|why|how|confused)\b/gi;
  const zoomerRegex = /\b(fr|ngl|bet|cap|no cap|sus|bruh|based|cringe|rizz|gyatt)\b/gi;
  const gamerRegex = /\b(gg|wp|lag|nerf|buff|noob|bot|fps)\b/gi;
  const financeBroRegex = /\b(crypto|btc|eth|stocks|stonks|moon|bull|bear)\b/gi;
  
  let prevDay = null;
  let prevMsgUser = null;

  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    perPerson[m.s] = (perPerson[m.s] || 0) + 1;
    // Every date/hour bucket below reads the message's parts in the configured
    // zone, so they agree with the DT/DAY labels the same message renders with.
    const zp = zonedParts(m.t);
    const ym = zp.key.slice(0, 7);   // "YYYY-MM"
    months[ym] = (months[ym] || 0) + 1;
    const dk = zp.key;               // "YYYY-MM-DD"
    days[dk] = (days[dk] || 0) + 1;

    // Day Starter & Killer Tracking
    if (dk !== prevDay) {
      starterCount[m.s] = (starterCount[m.s] || 0) + 1;
      if (prevMsgUser) {
        killerCount[prevMsgUser] = (killerCount[prevMsgUser] || 0) + 1;
      }
      prevDay = dk;
    }
    prevMsgUser = m.s;

    if (lastMsgTime[m.s]) {
      const gap = m.t - lastMsgTime[m.s];
      if (gap > (maxGapCount[m.s] || 0)) maxGapCount[m.s] = gap;
    }
    lastMsgTime[m.s] = m.t;
    
    hourCount[zp.h]++;
    weekdayCount[zp.dow]++;

    // Slacker & Weekend checks
    const dayOfWeek = zp.dow;
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      weekendCount[m.s] = (weekendCount[m.s] || 0) + 1;
    }
    const hr = zp.h;
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && hr >= 9 && hr < 17) {
      slackerCount[m.s] = (slackerCount[m.s] || 0) + 1;
    }

    // Late night check (12 AM to 5 AM)
    if (hr >= 0 && hr < 5) {
      nightCount[m.s] = (nightCount[m.s] || 0) + 1;
    }

    if (hr >= 5 && hr < 8) earlyBirdCount[m.s] = (earlyBirdCount[m.s] || 0) + 1;
    if (hr >= 3 && hr < 5) vampiricOwlCount[m.s] = (vampiricOwlCount[m.s] || 0) + 1;

    // Specific times
    const min = zp.mi;
    if ((hr === 4 || hr === 16) && min === 20) fourTwentyCount[m.s] = (fourTwentyCount[m.s] || 0) + 1;
    if (hr === 0 && min === 0) midnightSniperCount[m.s] = (midnightSniperCount[m.s] || 0) + 1;

    const md = zp.key.slice(5);   // "MM-DD"
    if (holidayMap[md]) holidayCount[m.s] = (holidayCount[m.s] || 0) + 1;

    // Media check
    if (m.m) {
      mediaCount[m.s] = (mediaCount[m.s] || 0) + 1;
    }

    // Reactions received check
    if (m.r && m.r.length) {
      reactsCount[m.s] = (reactsCount[m.s] || 0) + m.r.length;
      m.r.forEach(r => {
         reactorCount[r.s] = (reactorCount[r.s] || 0) + 1;
         if (r.s === m.s) selfReactCount[m.s] = (selfReactCount[m.s] || 0) + 1;
         if (r.k === "😂" || r.k === "😭") laughReactCount[r.s] = (laughReactCount[r.s] || 0) + 1;
         if (r.k === "👎" || r.k === "😡" || r.k === "🤡" || r.k === "🤬") hateReactCount[r.s] = (hateReactCount[r.s] || 0) + 1;
      });
    } else {
      zeroReactCount[m.s] = (zeroReactCount[m.s] || 0) + 1;
    }

    // Link check
    if (m.u && m.u.length) {
      linkCount[m.s] = (linkCount[m.s] || 0) + m.u.length;
      m.u.forEach(u => {
        const url = u.e || u.s || "";
        if (/tiktok\.com/i.test(url)) tiktokCount[m.s] = (tiktokCount[m.s] || 0) + 1;
        if (/youtube\.com|youtu\.be/i.test(url)) youtubeCount[m.s] = (youtubeCount[m.s] || 0) + 1;
        if (/twitter\.com|x\.com/i.test(url)) twitterCount[m.s] = (twitterCount[m.s] || 0) + 1;
        if (/instagram\.com/i.test(url)) instaCount[m.s] = (instaCount[m.s] || 0) + 1;
      });
    }

    // Text-based checks
    if (m.x) {
       const txt = m.x;
       // Words
       const wMatch = txt.match(/\b\w+\b/g);
       if (wMatch && wMatch.length > 0) {
         wordsTotal[m.s] = (wordsTotal[m.s] || 0) + wMatch.length;
         msgWithWords[m.s] = (msgWithWords[m.s] || 0) + 1;
         if (!uniqueWords[m.s]) uniqueWords[m.s] = new Set();
         wMatch.forEach(w => uniqueWords[m.s].add(w.toLowerCase()));
       }
       
       if (txt.length === 1) singleCharCount[m.s] = (singleCharCount[m.s] || 0) + 1;
       if (txt.length > (maxMsgLen[m.s] || 0)) maxMsgLen[m.s] = txt.length;
       if (txt === txt.toLowerCase() && /[a-z]/.test(txt)) lowerMsgCount[m.s] = (lowerMsgCount[m.s] || 0) + 1;
       
       const pdMatch = txt.match(/\./g);
       if (pdMatch) periodCount[m.s] = (periodCount[m.s] || 0) + pdMatch.length;
       
       const elMatch = txt.match(/\.\.\./g);
       if (elMatch) ellipsisCount[m.s] = (ellipsisCount[m.s] || 0) + elMatch.length;
       
       if (/\b[a-z]{6,}\b/.test(txt) && !/[aeiouy]/.test(txt)) keysmashCount[m.s] = (keysmashCount[m.s] || 0) + 1;
       else if (/asdf|fdsa|ghjk|hjkl/i.test(txt)) keysmashCount[m.s] = (keysmashCount[m.s] || 0) + 1;

       const hashMatch = txt.match(/#\w+/g);
       if (hashMatch) hashtagCount[m.s] = (hashtagCount[m.s] || 0) + hashMatch.length;

       const mentMatch = txt.match(/@\w+/g);
       if (mentMatch) mentionCount[m.s] = (mentionCount[m.s] || 0) + mentMatch.length;

       if (profanityRegex.test(txt)) swearCount[m.s] = (swearCount[m.s] || 0) + 1;
       if (txt.toUpperCase() === txt && /[A-Z]/.test(txt) && txt.length > 5) capsCount[m.s] = (capsCount[m.s] || 0) + 1;
       
       const qMatch = txt.match(/\?/g);
       if (qMatch) questionCount[m.s] = (questionCount[m.s] || 0) + qMatch.length;

       const exMatch = txt.match(/!/g);
       if (exMatch) exclaimerCount[m.s] = (exclaimerCount[m.s] || 0) + exMatch.length;

       const numMatch = txt.match(/\d/g);
       if (numMatch) numberCruncherCount[m.s] = (numberCruncherCount[m.s] || 0) + numMatch.length;

       const narcMatch = txt.match(narcissistRegex);
       if (narcMatch) narcissistCount[m.s] = (narcissistCount[m.s] || 0) + narcMatch.length;

       const comMatch = txt.match(comedianRegex);
       if (comMatch) comedianCount[m.s] = (comedianCount[m.s] || 0) + comMatch.length;

       const hesMatch = txt.match(hesitatorRegex);
       if (hesMatch) hesitatorCount[m.s] = (hesitatorCount[m.s] || 0) + hesMatch.length;

       const apMatch = txt.match(apologistRegex);
       if (apMatch) apologistCount[m.s] = (apologistCount[m.s] || 0) + apMatch.length;

       const grMatch = txt.match(gratitudeRegex);
       if (grMatch) gratitudeCount[m.s] = (gratitudeCount[m.s] || 0) + grMatch.length;

       const agMatch = txt.match(agreeableRegex);
       if (agMatch) agreeableCount[m.s] = (agreeableCount[m.s] || 0) + agMatch.length;

       const disMatch = txt.match(disagreerRegex);
       if (disMatch) disagreerCount[m.s] = (disagreerCount[m.s] || 0) + disMatch.length;

       const bdayMatch = txt.match(birthdayRegex);
       if (bdayMatch) birthdayCount[m.s] = (birthdayCount[m.s] || 0) + bdayMatch.length;

       if (/^\*[a-z]+/i.test(txt)) selfCorrectorCount[m.s] = (selfCorrectorCount[m.s] || 0) + 1;
       if (laughVoidRegex.test(txt)) laughVoidCount[m.s] = (laughVoidCount[m.s] || 0) + 1;

       // Wave 4 text checks
       const optMatch = txt.match(optimistRegex);
       if (optMatch) optimistCount[m.s] = (optimistCount[m.s] || 0) + optMatch.length;

       const pessMatch = txt.match(pessimistRegex);
       if (pessMatch) pessimistCount[m.s] = (pessimistCount[m.s] || 0) + pessMatch.length;

       const confMatch = txt.match(confusedRegex);
       if (confMatch) confusedCount[m.s] = (confusedCount[m.s] || 0) + confMatch.length;

       const zoomMatch = txt.match(zoomerRegex);
       if (zoomMatch) zoomerCount[m.s] = (zoomerCount[m.s] || 0) + zoomMatch.length;

       const gamMatch = txt.match(gamerRegex);
       if (gamMatch) gamerCount[m.s] = (gamerCount[m.s] || 0) + gamMatch.length;

       const finMatch = txt.match(financeBroRegex);
       if (finMatch) financeBroCount[m.s] = (financeBroCount[m.s] || 0) + finMatch.length;

       const nlMatch = txt.match(/\n.*\n/g);
       if (nlMatch) paragrapherCount[m.s] = (paragrapherCount[m.s] || 0) + nlMatch.length;

       const screamMatch = txt.match(/!{3,}/g);
       if (screamMatch) screamerCount[m.s] = (screamerCount[m.s] || 0) + screamMatch.length;

       const mqMatch = txt.match(/\?{3,}/g);
       if (mqMatch) multiQuestionerCount[m.s] = (multiQuestionerCount[m.s] || 0) + mqMatch.length;

       // Emoji check
       const ems = m.x.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu);
       if (ems) {
         ems.forEach(e => {
           emojis[e] = (emojis[e] || 0) + 1;
           emojiCount[m.s] = (emojiCount[m.s] || 0) + 1;
         });
       }
    }

    // Response latency check
    if (i > 0) {
      const prev = MSGS[i - 1];
      if (m.s === prev.s) {
        consecutiveCount++;
        if (consecutiveCount === 5) {
          monologuerCount[m.s] = (monologuerCount[m.s] || 0) + 1;
        }
        if (m.t - prev.t < 3600000) { // consecutive within 1 hr
          doubleTextCount[m.s] = (doubleTextCount[m.s] || 0) + 1;
        }
      } else {
        consecutiveCount = 1;
      }

      if (m.s !== prev.s) {
        const diff = m.t - prev.t;
        if (diff > 0 && diff < 1800000) { // < 30 minutes
          if (!responseStats[m.s]) responseStats[m.s] = { sum: 0, count: 0 };
          responseStats[m.s].sum += diff;
          responseStats[m.s].count++;

          // Interaction pair: prev.s -> m.s
          const pairKey = prev.s + "→" + m.s;
          replyPairStats[pairKey] = (replyPairStats[pairKey] || 0) + 1;
        }
      }
    }
  }

  let busy = ["", 0];
  for (const k in days) {
    if (days[k] > busy[1]) busy = [k, days[k]];
  }

  // Calculate final metrics for each user to determine who wins each superlative
  let owlWinner = { id: null, val: -1 };
  let emojiWinner = { id: null, val: -1 };
  let mediaWinner = { id: null, val: -1 };
  let reactsWinner = { id: null, val: -1 };
  let swearWinner = { id: null, val: -1 };
  let capsWinner = { id: null, val: -1 };
  let questionWinner = { id: null, val: -1 };
  let narcissistWinner = { id: null, val: -1 };
  let comedianWinner = { id: null, val: -1 };
  let reactorWinner = { id: null, val: -1 };
  let linkWinner = { id: null, val: -1 };
  let starterWinner = { id: null, val: -1 };
  let killerWinner = { id: null, val: -1 };
  let doubleTextWinner = { id: null, val: -1 };
  let weekendWinner = { id: null, val: -1 };
  let slackerWinner = { id: null, val: -1 };
  let yapperWinner = { id: null, val: -1 };
  let cavemanWinner = { id: null, val: 999999 }; // Lowest avg words
  let ghosterWinner = { id: null, val: -1 }; // Highest latency
  let flashWinner = { id: null, val: 999999999 }; // Lowest latency
  let lurkerWinner = { id: null, val: 999999999 }; // Lowest msgs
  let scholarWinner = { id: null, val: -1 };
  let policeWinner = { id: null, val: -1 };
  let ellipsisWinner = { id: null, val: -1 };
  let singleCharWinner = { id: null, val: -1 };
  let novelistWinner = { id: null, val: -1 };
  let minimalistWinner = { id: null, val: -1 };
  let keysmashWinner = { id: null, val: -1 };
  let earlyBirdWinner = { id: null, val: -1 };
  let vampiricOwlWinner = { id: null, val: -1 };
  let holidayWinner = { id: null, val: -1 };
  let deserterWinner = { id: null, val: -1 };
  let monologuerWinner = { id: null, val: -1 };
  let crowdPleaserWinner = { id: null, val: -1 };
  let ignoredWinner = { id: null, val: -1 };
  let selfLoverWinner = { id: null, val: -1 };
  let laughTrackWinner = { id: null, val: -1 };
  let haterWinner = { id: null, val: -1 };
  let tiktokWinner = { id: null, val: -1 };
  let youtubeWinner = { id: null, val: -1 };
  let twitterWinner = { id: null, val: -1 };
  let instaWinner = { id: null, val: -1 };
  let hashtagWinner = { id: null, val: -1 };
  let mentionWinner = { id: null, val: -1 };

  let hesitatorWinner = { id: null, val: -1 };
  let apologistWinner = { id: null, val: -1 };
  let gratitudeWinner = { id: null, val: -1 };
  let agreeableWinner = { id: null, val: -1 };
  let disagreerWinner = { id: null, val: -1 };
  let selfCorrectorWinner = { id: null, val: -1 };
  let laughVoidWinner = { id: null, val: -1 };
  let exclaimerWinner = { id: null, val: -1 };
  let numberCruncherWinner = { id: null, val: -1 };
  let fourTwentyWinner = { id: null, val: -1 };
  let midnightSniperWinner = { id: null, val: -1 };
  let birthdayWinner = { id: null, val: -1 };

  let optimistWinner = { id: null, val: -1 };
  let pessimistWinner = { id: null, val: -1 };
  let confusedWinner = { id: null, val: -1 };
  let zoomerWinner = { id: null, val: -1 };
  let gamerWinner = { id: null, val: -1 };
  let financeBroWinner = { id: null, val: -1 };
  let paragrapherWinner = { id: null, val: -1 };
  let screamerWinner = { id: null, val: -1 };
  let multiQuestionerWinner = { id: null, val: -1 };

  const yapperStats = {};
  const doubleTextStats = {};
  const reactionGenerosity = {};
  const scholarStats = {};
  const platformStats = {};

  PARTS.forEach(p => {
    const id = p.id;
    if (nightCount[id] > owlWinner.val) owlWinner = { id, val: nightCount[id] };
    if (emojiCount[id] > emojiWinner.val) emojiWinner = { id, val: emojiCount[id] };
    if (mediaCount[id] > mediaWinner.val) mediaWinner = { id, val: mediaCount[id] };
    if (reactsCount[id] > reactsWinner.val) reactsWinner = { id, val: reactsCount[id] };
    if ((swearCount[id]||0) > swearWinner.val) swearWinner = { id, val: swearCount[id]||0 };
    if ((capsCount[id]||0) > capsWinner.val) capsWinner = { id, val: capsCount[id]||0 };
    if ((questionCount[id]||0) > questionWinner.val) questionWinner = { id, val: questionCount[id]||0 };
    if ((narcissistCount[id]||0) > narcissistWinner.val) narcissistWinner = { id, val: narcissistCount[id]||0 };
    if ((comedianCount[id]||0) > comedianWinner.val) comedianWinner = { id, val: comedianCount[id]||0 };
    if ((reactorCount[id]||0) > reactorWinner.val) reactorWinner = { id, val: reactorCount[id]||0 };
    if ((linkCount[id]||0) > linkWinner.val) linkWinner = { id, val: linkCount[id]||0 };
    if ((starterCount[id]||0) > starterWinner.val) starterWinner = { id, val: starterCount[id]||0 };
    if ((killerCount[id]||0) > killerWinner.val) killerWinner = { id, val: killerCount[id]||0 };
    if ((doubleTextCount[id]||0) > doubleTextWinner.val) doubleTextWinner = { id, val: doubleTextCount[id]||0 };
    if ((weekendCount[id]||0) > weekendWinner.val) weekendWinner = { id, val: weekendCount[id]||0 };
    if ((slackerCount[id]||0) > slackerWinner.val) slackerWinner = { id, val: slackerCount[id]||0 };
    
    if (p.count < lurkerWinner.val && p.count > 0) lurkerWinner = { id, val: p.count };

    // Wave 2 Winners
    const uWords = uniqueWords[id] ? uniqueWords[id].size : 0;
    scholarStats[id] = uWords;
    if (uWords > scholarWinner.val) scholarWinner = { id, val: uWords };
    
    if ((periodCount[id]||0) > policeWinner.val) policeWinner = { id, val: periodCount[id]||0 };
    if ((ellipsisCount[id]||0) > ellipsisWinner.val) ellipsisWinner = { id, val: ellipsisCount[id]||0 };
    if ((singleCharCount[id]||0) > singleCharWinner.val) singleCharWinner = { id, val: singleCharCount[id]||0 };
    if ((maxMsgLen[id]||0) > novelistWinner.val) novelistWinner = { id, val: maxMsgLen[id]||0 };
    
    const pctLower = p.count ? ((lowerMsgCount[id]||0)/p.count)*100 : 0;
    if (pctLower > minimalistWinner.val) minimalistWinner = { id, val: pctLower };
    
    if ((keysmashCount[id]||0) > keysmashWinner.val) keysmashWinner = { id, val: keysmashCount[id]||0 };
    if ((earlyBirdCount[id]||0) > earlyBirdWinner.val) earlyBirdWinner = { id, val: earlyBirdCount[id]||0 };
    if ((vampiricOwlCount[id]||0) > vampiricOwlWinner.val) vampiricOwlWinner = { id, val: vampiricOwlCount[id]||0 };
    if ((holidayCount[id]||0) > holidayWinner.val) holidayWinner = { id, val: holidayCount[id]||0 };
    if ((maxGapCount[id]||0) > deserterWinner.val) deserterWinner = { id, val: maxGapCount[id]||0 };
    if ((monologuerCount[id]||0) > monologuerWinner.val) monologuerWinner = { id, val: monologuerCount[id]||0 };

    const avgReacts = p.count ? ((reactsCount[id]||0)/p.count) : 0;
    if (avgReacts > crowdPleaserWinner.val) crowdPleaserWinner = { id, val: avgReacts };

    const pctIgnored = p.count ? ((zeroReactCount[id]||0)/p.count)*100 : 0;
    if (pctIgnored > ignoredWinner.val) ignoredWinner = { id, val: pctIgnored };

    if ((selfReactCount[id]||0) > selfLoverWinner.val) selfLoverWinner = { id, val: selfReactCount[id]||0 };
    if ((laughReactCount[id]||0) > laughTrackWinner.val) laughTrackWinner = { id, val: laughReactCount[id]||0 };
    if ((hateReactCount[id]||0) > haterWinner.val) haterWinner = { id, val: hateReactCount[id]||0 };
    if ((tiktokCount[id]||0) > tiktokWinner.val) tiktokWinner = { id, val: tiktokCount[id]||0 };
    if ((youtubeCount[id]||0) > youtubeWinner.val) youtubeWinner = { id, val: youtubeCount[id]||0 };
    if ((twitterCount[id]||0) > twitterWinner.val) twitterWinner = { id, val: twitterCount[id]||0 };
    if ((instaCount[id]||0) > instaWinner.val) instaWinner = { id, val: instaCount[id]||0 };
    if ((hashtagCount[id]||0) > hashtagWinner.val) hashtagWinner = { id, val: hashtagCount[id]||0 };
    if ((mentionCount[id]||0) > mentionWinner.val) mentionWinner = { id, val: mentionCount[id]||0 };

    if ((hesitatorCount[id]||0) > hesitatorWinner.val) hesitatorWinner = { id, val: hesitatorCount[id]||0 };
    if ((apologistCount[id]||0) > apologistWinner.val) apologistWinner = { id, val: apologistCount[id]||0 };
    if ((gratitudeCount[id]||0) > gratitudeWinner.val) gratitudeWinner = { id, val: gratitudeCount[id]||0 };
    if ((agreeableCount[id]||0) > agreeableWinner.val) agreeableWinner = { id, val: agreeableCount[id]||0 };
    if ((disagreerCount[id]||0) > disagreerWinner.val) disagreerWinner = { id, val: disagreerCount[id]||0 };
    if ((selfCorrectorCount[id]||0) > selfCorrectorWinner.val) selfCorrectorWinner = { id, val: selfCorrectorCount[id]||0 };
    if ((laughVoidCount[id]||0) > laughVoidWinner.val) laughVoidWinner = { id, val: laughVoidCount[id]||0 };
    if ((exclaimerCount[id]||0) > exclaimerWinner.val) exclaimerWinner = { id, val: exclaimerCount[id]||0 };
    if ((numberCruncherCount[id]||0) > numberCruncherWinner.val) numberCruncherWinner = { id, val: numberCruncherCount[id]||0 };
    if ((fourTwentyCount[id]||0) > fourTwentyWinner.val) fourTwentyWinner = { id, val: fourTwentyCount[id]||0 };
    if ((midnightSniperCount[id]||0) > midnightSniperWinner.val) midnightSniperWinner = { id, val: midnightSniperCount[id]||0 };
    if ((birthdayCount[id]||0) > birthdayWinner.val) birthdayWinner = { id, val: birthdayCount[id]||0 };

    if ((optimistCount[id]||0) > optimistWinner.val) optimistWinner = { id, val: optimistCount[id]||0 };
    if ((pessimistCount[id]||0) > pessimistWinner.val) pessimistWinner = { id, val: pessimistCount[id]||0 };
    if ((confusedCount[id]||0) > confusedWinner.val) confusedWinner = { id, val: confusedCount[id]||0 };
    if ((zoomerCount[id]||0) > zoomerWinner.val) zoomerWinner = { id, val: zoomerCount[id]||0 };
    if ((gamerCount[id]||0) > gamerWinner.val) gamerWinner = { id, val: gamerCount[id]||0 };
    if ((financeBroCount[id]||0) > financeBroWinner.val) financeBroWinner = { id, val: financeBroCount[id]||0 };
    if ((paragrapherCount[id]||0) > paragrapherWinner.val) paragrapherWinner = { id, val: paragrapherCount[id]||0 };
    if ((screamerCount[id]||0) > screamerWinner.val) screamerWinner = { id, val: screamerCount[id]||0 };
    if ((multiQuestionerCount[id]||0) > multiQuestionerWinner.val) multiQuestionerWinner = { id, val: multiQuestionerCount[id]||0 };

    platformStats[id] = { tt: tiktokCount[id]||0, yt: youtubeCount[id]||0, tw: twitterCount[id]||0, ig: instaCount[id]||0 };

    const avgWords = msgWithWords[id] ? (wordsTotal[id] / msgWithWords[id]) : 0;
    yapperStats[id] = avgWords;
    if (avgWords > yapperWinner.val) yapperWinner = { id, val: avgWords };
    if (avgWords > 0 && avgWords < cavemanWinner.val) cavemanWinner = { id, val: avgWords };

    doubleTextStats[id] = doubleTextCount[id] || 0;
    reactionGenerosity[id] = { given: reactorCount[id] || 0, received: reactsCount[id] || 0 };

    if (responseStats[id] && responseStats[id].count > 0) {
      const avgLat = responseStats[id].sum / responseStats[id].count;
      if (avgLat > ghosterWinner.val) ghosterWinner = { id, val: avgLat };
      if (avgLat < flashWinner.val) flashWinner = { id, val: avgLat };
    }
  });

  if (cavemanWinner.val === 999999) cavemanWinner = { id: null, val: 0 };
  if (flashWinner.val === 999999999) flashWinner = { id: null, val: 0 };
  if (lurkerWinner.val === 999999999) lurkerWinner = { id: null, val: 0 };

  // Sort interaction pairings
  const topPairs = Object.entries(replyPairStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [fromId, toId] = key.split("→");
      return { fromId, toId, count };
    });

  STATS = {
    perPerson,
    days,
    monthArr: Object.entries(months).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    daysActive: Object.keys(days).length,
    busy,
    first: MSGS[0].t,
    last: MSGS[N - 1].t,
    hourCount,
    weekdayCount,
    emojis: Object.entries(emojis).sort((a,b)=>b[1]-a[1]).slice(0, 15),
    owlWinner,
    emojiWinner,
    mediaWinner,
    reactsWinner,
    swearWinner, capsWinner, questionWinner, narcissistWinner,
    comedianWinner, reactorWinner, linkWinner, starterWinner,
    killerWinner, doubleTextWinner, weekendWinner, slackerWinner,
    yapperWinner, cavemanWinner, ghosterWinner, flashWinner, lurkerWinner,
    scholarWinner, policeWinner, ellipsisWinner, singleCharWinner,
    novelistWinner, minimalistWinner, keysmashWinner, earlyBirdWinner,
    vampiricOwlWinner, holidayWinner, deserterWinner, monologuerWinner,
    crowdPleaserWinner, ignoredWinner, selfLoverWinner, laughTrackWinner,
    haterWinner, tiktokWinner, youtubeWinner, twitterWinner, instaWinner,
    hashtagWinner, mentionWinner,
    hesitatorWinner, apologistWinner, gratitudeWinner, agreeableWinner,
    disagreerWinner, selfCorrectorWinner, laughVoidWinner, exclaimerWinner,
    numberCruncherWinner, fourTwentyWinner, midnightSniperWinner, birthdayWinner,
    optimistWinner, pessimistWinner, confusedWinner, zoomerWinner,
    gamerWinner, financeBroWinner, paragrapherWinner, screamerWinner,
    multiQuestionerWinner,
    yapperStats, doubleTextStats, reactionGenerosity,
    scholarStats, platformStats,
    responseStats,
    topPairs
  };
  return STATS;
}
function computeWords() {
  if (WORDS) return WORDS;
  const stop = new Set("the a an and or but to of in on at for with is are was were be been being am i you he she it we they them me my your our this that these those have has had do does did not no so if as up out get got go gonna just like dont didnt cant wont im youre theyre thats whats here there all any some more most then than too very can could would should will shall may might must about into over under again only also even still much many lol lmao lmaooo yeah yea nah ok okay haha hahaha bro man dude what when who whom how why which whose oh uh um yo idk imo tbh".split(/\s+/));
  const counts = {};
  for (let i = 0; i < N; i++) {
    const x = MSGS[i].x; if (!x) continue;
    const toks = x.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9']+/g, " ").split(" ");
    for (const t of toks) { if (t.length < 3 || t.length > 18) continue; if (stop.has(t)) continue; counts[t] = (counts[t] || 0) + 1; }
  }
  WORDS = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 42);
  return WORDS;
}
let trendChart = null;
function computeKeywordTrend(word) {
  const wordLower = word.toLowerCase();
  const monthCounts = {};
  
  if (STATS && STATS.monthArr) {
     STATS.monthArr.forEach(m => monthCounts[m[0]] = 0);
  }

  for (let i = 0; i < N; i++) {
    if (LOWER[i].includes(wordLower)) {
       // Same zoned "YYYY-MM" keys as STATS.monthArr so the trend chart aligns.
       const ym = zonedParts(MSGS[i].t).key.slice(0, 7);
       if (monthCounts[ym] !== undefined) {
          monthCounts[ym]++;
       } else {
          monthCounts[ym] = 1;
       }
    }
  }

  return Object.entries(monthCounts).sort((a,b) => a[0] < b[0] ? -1 : 1);
}

function updateTrendChart(word) {
  if (!word.trim()) return;
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
    trendChart = new Chart(ctx.getContext("2d"), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{ label: '"' + word + '" frequency', data: data, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.2)', fill: true, tension: 0.4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } }
    });
  }
}

let MILES = null;
function computeMilestones() {
  if (MILES) return MILES;
  // Same empty-conversation guard as computeStats() — MSGS[N-1]/MSGS[0] would throw.
  if (!N) return (MILES = { empty: true });
  const dayCount = new Map();   // dayKey -> msg count
  const hourCount = new Array(24).fill(0);
  let totalWords = 0, totalReacts = 0;
  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    const zp = zonedParts(m.t);
    dayCount.set(zp.key, (dayCount.get(zp.key) || 0) + 1);
    hourCount[zp.h]++;
    const t = (m.x || "").trim();
    if (t) totalWords += t.split(/\s+/).length;
    if (m.r) totalReacts += m.r.length;
  }
  // Busiest single day
  let busiestDay = "", busiestCount = 0;
  dayCount.forEach((c, dk) => { if (c > busiestCount) { busiestCount = c; busiestDay = dk; } });
  // Longest streak of consecutive active days. Day keys are "YYYY-MM-DD" in the
  // configured zone; parse them at UTC midnight (uniform 86400000 spacing, so the
  // consecutive-day gap check is exact and DST-proof) for the streak math, then
  // format the winning ends via keyLabel() so the shown dates match the buckets.
  const keyTime = (k) => Date.parse(k + "T00:00:00Z");
  const keyLabel = (fmt, k) => fmt.format(dayKeyBoundInstant(k));
  const dayKeysSorted = [...dayCount.keys()].sort();
  let streak = dayKeysSorted.length ? 1 : 0, best = streak;
  let bestEndKey = dayKeysSorted[0] || "";
  for (let i = 1; i < dayKeysSorted.length; i++) {
    const gap = Math.round((keyTime(dayKeysSorted[i]) - keyTime(dayKeysSorted[i - 1])) / 86400000);
    if (gap === 1) { streak++; if (streak > best) { best = streak; bestEndKey = dayKeysSorted[i]; } }
    else streak = 1;
  }
  const bestStartKey = bestEndKey ? isoDayKeyMinus(bestEndKey, best - 1) : "";
  const streakRange = best > 1 ? keyLabel(dShort, bestStartKey) + " → " + keyLabel(dShort, bestEndKey) : "—";
  // Peak hour
  let peakHour = 0; for (let h = 1; h < 24; h++) if (hourCount[h] > hourCount[peakHour]) peakHour = h;
  const fmtH = (h) => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "am" : "pm");
  const ageMs = MSGS[N - 1].t - MSGS[0].t;
  MILES = {
    streak: fmtNum(best) + (best === 1 ? " day" : " days"), streakRange,
    busiestDay: busiestDay ? keyLabel(DAY, busiestDay) : "—", busiestCount,
    totalWords, bookPages: Math.round(totalWords / 250), totalReacts,
    ageYears: (ageMs / (365.25 * 86400000)).toFixed(1) + " yrs",
    firstDay: dShort.format(MSGS[0].t),
    peakHourLabel: fmtH(peakHour), peakHourCount: hourCount[peakHour],
  };
  return MILES;
}

function renderStats() {
  const v = document.getElementById("view-stats");
  const s = computeStats();
  if (s.empty) {
    v.innerHTML = '<div class="page"><div class="empty"><div class="big">▤</div><div>No messages in this group — every sender is ignored.</div></div></div>';
    return;
  }
  const days = Math.max(1, Math.round((s.last - s.first) / 86400000));
  const maxPP = Math.max(...PARTS.map((p) => p.count));

  // ---- Milestones (longest active streak, busiest single day, anniversary) ----
  const ms = computeMilestones();

  // Compute latency rows
  let latencyRows = "";
  PARTS.forEach(p => {
    const stat = s.responseStats[p.id];
    if (stat && stat.count > 0) {
      const avgMs = stat.sum / stat.count;
      let displayTime;
      if (avgMs < 60000) {
        displayTime = Math.round(avgMs / 1000) + "s";
      } else {
        displayTime = (avgMs / 60000).toFixed(1) + "m";
      }
      latencyRows += `<div class="bar-row">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div class="bar-val" style="text-align:left; color:var(--text); font-weight:600;">${displayTime}</div>
        <div class="bar-val" style="font-size:11px;color:var(--text-faint);">${stat.count} responses</div>
      </div>`;
    }
  });

  // Compute pairing rows
  let pairRows = "";
  s.topPairs.forEach(pair => {
    pairRows += `<div class="bar-row" style="grid-template-columns: 1fr auto;">
      <div class="bar-name">
        ${pfpHtml(pair.fromId, "width:22px;height:22px;font-size:10px")}
        <span style="color:var(--text-dim); margin:0 4px;">→</span>
        ${pfpHtml(pair.toId, "width:22px;height:22px;font-size:10px")}
        <span style="margin-left:8px; font-weight:500;">${esc(nameOf(pair.toId))} replied to ${esc(nameOf(pair.fromId))}</span>
      </div>
      <div class="bar-val" style="font-weight:600;color:var(--accent);">${pair.count} times</div>
    </div>`;
  });

  let html = `<div class="page"><div class="page-head"><div class="page-title">Stats & overview</div>
    <div class="page-sub">${esc(DAY.format(s.first))} → ${esc(DAY.format(s.last))}</div></div>
    <div class="page-body">
      <div class="cards">
        <div class="card"><div class="stat-num accent">${fmtNum(N)}</div><div class="stat-lbl">Messages</div></div>
        <div class="card"><div class="stat-num">${PARTS.length}</div><div class="stat-lbl">People</div></div>
        <div class="card"><div class="stat-num">${fmtNum(s.daysActive)}</div><div class="stat-lbl">Active days</div></div>
        <div class="card"><div class="stat-num">${fmtNum(Math.round(N / s.daysActive))}</div><div class="stat-lbl">Msgs / active day</div></div>
        <div class="card"><div class="stat-num">${fmtNum(MSGS.filter((m) => m.m).length)}</div><div class="stat-lbl">Media shared</div></div>
        <div class="card"><div class="stat-num">${fmtNum(days)}</div><div class="stat-lbl">Days span</div></div>
      </div>

      <div class="section"><div class="section-h">Milestones</div>
      <div class="cards" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
        <div class="card mile"><div class="stat-num accent">${ms.streak}</div><div class="stat-lbl">Longest daily streak</div><div class="mile-sub">${esc(ms.streakRange)}</div></div>
        <div class="card mile"><div class="stat-num">${fmtNum(ms.busiestCount)}</div><div class="stat-lbl">Busiest single day</div><div class="mile-sub">${esc(ms.busiestDay)}</div></div>
        <div class="card mile"><div class="stat-num">${fmtNum(ms.totalWords)}</div><div class="stat-lbl">Total words sent</div><div class="mile-sub">≈ ${fmtNum(ms.bookPages)} paperback pages</div></div>
        <div class="card mile"><div class="stat-num">${fmtNum(ms.totalReacts)}</div><div class="stat-lbl">Reactions given</div><div class="mile-sub">across the whole chat</div></div>
        <div class="card mile"><div class="stat-num">${ms.ageYears}</div><div class="stat-lbl">Chat age</div><div class="mile-sub">since ${esc(ms.firstDay)}</div></div>
        <div class="card mile"><div class="stat-num">${esc(ms.peakHourLabel)}</div><div class="stat-lbl">Peak hour</div><div class="mile-sub">${fmtNum(ms.peakHourCount)} msgs all-time</div></div>
      </div></div>

      <div class="section"><div class="section-h">Superlatives & Fun Stats</div>
      <div class="cards" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
        ${[
          { win: s.owlWinner, title: "Late Night Owl", desc: fmtNum(s.owlWinner.val) + " msgs (12AM-5AM)" },
          { win: s.reactsWinner, title: "Reaction Magnet", desc: fmtNum(s.reactsWinner.val) + " reactions" },
          { win: s.emojiWinner, title: "Emoji Enthusiast", desc: fmtNum(s.emojiWinner.val) + " emojis used" },
          { win: s.mediaWinner, title: "Media Hog", desc: fmtNum(s.mediaWinner.val) + " files shared" },
          { win: s.yapperWinner, title: "The Yapper", desc: s.yapperWinner.val.toFixed(1) + " words / msg" },
          { win: s.cavemanWinner, title: "The Caveman", desc: s.cavemanWinner.val.toFixed(1) + " words / msg" },
          { win: s.swearWinner, title: "The Sailor", desc: fmtNum(s.swearWinner.val) + " msgs w/ swearing" },
          { win: s.capsWinner, title: "The Shouter", desc: fmtNum(s.capsWinner.val) + " ALL CAPS msgs" },
          { win: s.questionWinner, title: "The Inquisitor", desc: fmtNum(s.questionWinner.val) + " questions asked" },
          { win: s.narcissistWinner, title: "The Narcissist", desc: fmtNum(s.narcissistWinner.val) + ' "I/me/my"' },
          { win: s.comedianWinner, title: "The LMAO User", desc: fmtNum(s.comedianWinner.val) + " laughs" },
          { win: s.reactorWinner, title: "The Giver", desc: fmtNum(s.reactorWinner.val) + " reactions given" },
          { win: s.linkWinner, title: "The Link Spammer", desc: fmtNum(s.linkWinner.val) + " URLs shared" },
          { win: s.starterWinner, title: "Thread Starter", desc: fmtNum(s.starterWinner.val) + " days started" },
          { win: s.killerWinner, title: "Thread Killer", desc: fmtNum(s.killerWinner.val) + " days ended" },
          { win: s.doubleTextWinner, title: "The Double Texter", desc: fmtNum(s.doubleTextWinner.val) + " double texts" },
          { win: s.weekendWinner, title: "Weekend Warrior", desc: fmtNum(s.weekendWinner.val) + " weekend msgs" },
          { win: s.slackerWinner, title: "The Work Slacker", desc: fmtNum(s.slackerWinner.val) + " msgs (9-5)" },
          { win: s.lurkerWinner, title: "The Ghost", desc: "Only " + fmtNum(s.lurkerWinner.val) + " messages total" },
          { win: s.ghosterWinner, title: "The Ghoster", desc: s.ghosterWinner.val > 3600000 ? (s.ghosterWinner.val/3600000).toFixed(1) + "h avg reply" : s.ghosterWinner.val > 60000 ? (s.ghosterWinner.val/60000).toFixed(1) + "m avg reply" : Math.round(s.ghosterWinner.val/1000) + "s avg reply" },
          { win: s.flashWinner, title: "The Flash", desc: s.flashWinner.val > 3600000 ? (s.flashWinner.val/3600000).toFixed(1) + "h avg reply" : s.flashWinner.val > 60000 ? (s.flashWinner.val/60000).toFixed(1) + "m avg reply" : Math.round(s.flashWinner.val/1000) + "s avg reply" },
          { win: s.scholarWinner, title: "The Scholar", desc: fmtNum(s.scholarWinner.val) + " unique words" },
          { win: s.novelistWinner, title: "The Novelist", desc: fmtNum(s.novelistWinner.val) + " chars (longest msg)" },
          { win: s.keysmashWinner, title: "The Keysmasher", desc: fmtNum(s.keysmashWinner.val) + " gibberish msgs" },
          { win: s.earlyBirdWinner, title: "The Early Bird", desc: fmtNum(s.earlyBirdWinner.val) + " msgs (5AM-8AM)" },
          { win: s.vampiricOwlWinner, title: "Vampiric Owl", desc: fmtNum(s.vampiricOwlWinner.val) + " msgs (3AM-5AM)" },
          { win: s.deserterWinner, title: "The Deserter", desc: s.deserterWinner.val > 86400000 ? (s.deserterWinner.val/86400000).toFixed(1) + " days without sending" : (s.deserterWinner.val/3600000).toFixed(1) + " hrs without sending" },
          { win: s.monologuerWinner, title: "The Monologuer", desc: fmtNum(s.monologuerWinner.val) + " x 5+ msgs in a row" },
          { win: s.crowdPleaserWinner, title: "Crowd Pleaser", desc: s.crowdPleaserWinner.val.toFixed(1) + " reacts / msg avg" },
          { win: s.ignoredWinner, title: "The Ignored", desc: s.ignoredWinner.val.toFixed(1) + "% msgs 0 reacts" },
          { win: s.laughTrackWinner, title: "The Laugh Track", desc: fmtNum(s.laughTrackWinner.val) + " 😂/😭 given" },
          { win: s.haterWinner, title: "The Hater", desc: fmtNum(s.haterWinner.val) + " 👎/😡 given" },
          { win: s.tiktokWinner, title: "The TikToker", desc: fmtNum(s.tiktokWinner.val) + " TikToks shared" },
          { win: s.youtubeWinner, title: "The YouTuber", desc: fmtNum(s.youtubeWinner.val) + " YouTubes shared" },
          { win: s.twitterWinner, title: "X/Twitter Addict", desc: fmtNum(s.twitterWinner.val) + " Tweets shared" },
          { win: s.gratitudeWinner, title: "Gratitude King", desc: fmtNum(s.gratitudeWinner.val) + " 'thank you's" },
          { win: s.laughVoidWinner, title: "The Laughing Void", desc: fmtNum(s.laughVoidWinner.val) + " 'lol' only msgs" },
          { win: s.exclaimerWinner, title: "The Exclaimer", desc: fmtNum(s.exclaimerWinner.val) + " exclamation marks!" },
          { win: s.midnightSniperWinner, title: "Midnight Sniper", desc: fmtNum(s.midnightSniperWinner.val) + " msgs at 12:00 AM" },
          { win: s.optimistWinner, title: "The Optimist", desc: fmtNum(s.optimistWinner.val) + " positive words" },
          { win: s.pessimistWinner, title: "The Pessimist", desc: fmtNum(s.pessimistWinner.val) + " negative words" },
          { win: s.zoomerWinner, title: "The Zoomer", desc: fmtNum(s.zoomerWinner.val) + " Gen-Z slangs" },
          { win: s.gamerWinner, title: "The Gamer", desc: fmtNum(s.gamerWinner.val) + " gamer terms" },
          { win: s.financeBroWinner, title: "Finance Bro", desc: fmtNum(s.financeBroWinner.val) + " crypto/stock terms" },
        ].filter(x => x.win && x.win.id && x.win.val > 0).map(x => `
          <div class="card" style="display:flex; align-items:center; gap:12px;">
            ${pfpHtml(x.win.id, "width:40px;height:40px;font-size:16px")}
            <div>
              <div style="font-weight:600;font-size:14px;">${esc(nameOf(x.win.id))}</div>
              <div class="stat-lbl" style="margin-top:2px;">${esc(x.title)}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">${esc(x.desc)}</div>
            </div>
          </div>
        `).join("")}
      </div></div>

      <div class="section" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <div class="section-h">Average Response Latency</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
            ${latencyRows || '<div class="pop-empty">No response latency data yet.</div>'}
          </div>
        </div>
        <div>
          <div class="section-h">Top Interaction Pairings</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
            ${pairRows || '<div class="pop-empty">No pairing data yet.</div>'}
          </div>
        </div>
      </div>

      <div class="section"><div class="section-h">Messages per person</div><div class="bars">`;

  PARTS.forEach((p) => {
    html += `<div class="bar-row bar-clickable" data-person-id="${esc(p.id)}">
      <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(p.count / maxPP * 100).toFixed(1)}%"></div></div>
      <div class="bar-val">${fmtNum(p.count)}</div></div>`;
  });
  html += `</div></div>

      <div class="section" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <div class="section-h">The Yapping Index (Avg Words / Message)</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
`;
  const maxYap = Math.max(1, ...PARTS.map(p => s.yapperStats[p.id] || 0));
  PARTS.forEach(p => {
    const yap = s.yapperStats[p.id] || 0;
    if (yap > 0) {
      html += `<div class="bar-row">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(yap / maxYap * 100).toFixed(1)}%; background:var(--accent)"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${yap.toFixed(1)}</div>
      </div>`;
    }
  });
  html += `</div>
        </div>
        <div>
          <div class="section-h">Double Texting Leaderboard</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
`;
  const maxDT = Math.max(1, ...PARTS.map(p => s.doubleTextStats[p.id] || 0));
  PARTS.forEach(p => {
    const dt = s.doubleTextStats[p.id] || 0;
    if (dt > 0) {
      html += `<div class="bar-row">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(dt / maxDT * 100).toFixed(1)}%; background:#e0245e"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${fmtNum(dt)}</div>
      </div>`;
    }
  });
  html += `</div>
        </div>
      </div>

      <div class="section">
        <div class="section-h">Reaction Generosity (Given vs. Received)</div>
        <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; display:flex; flex-direction:column; gap:12px;">
`;
  const maxReactTotal = Math.max(1, ...PARTS.map(p => (s.reactionGenerosity[p.id]?.given || 0) + (s.reactionGenerosity[p.id]?.received || 0)));
  PARTS.forEach(p => {
    const r = s.reactionGenerosity[p.id] || { given: 0, received: 0 };
    if (r.given > 0 || r.received > 0) {
      html += `<div class="bar-row" style="align-items:center;">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div style="flex:1; display:flex; gap:4px; font-size:11px; align-items:center;">
          <div style="width:${(r.given / maxReactTotal * 100).toFixed(1)}%; background:#1da1f2; height:8px; border-radius:4px;" title="Given: ${fmtNum(r.given)}"></div>
          <span style="color:#1da1f2; font-weight:600; width:30px">${fmtNum(r.given)}</span>
          <div style="width:${(r.received / maxReactTotal * 100).toFixed(1)}%; background:#17bf63; height:8px; border-radius:4px;" title="Received: ${fmtNum(r.received)}"></div>
          <span style="color:#17bf63; font-weight:600; width:30px">${fmtNum(r.received)}</span>
        </div>
      </div>`;
    }
  });
  html += `</div>
      </div>

      <div class="section" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <div class="section-h">Vocabulary Size (Unique Words)</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
`;
  const maxVocab = Math.max(1, ...PARTS.map(p => s.scholarStats[p.id] || 0));
  PARTS.forEach(p => {
    const vcb = s.scholarStats[p.id] || 0;
    if (vcb > 0) {
      html += `<div class="bar-row">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(vcb / maxVocab * 100).toFixed(1)}%; background:var(--accent)"></div></div>
        <div class="bar-val" style="width:40px; text-align:right;">${fmtNum(vcb)}</div>
      </div>`;
    }
  });
  html += `</div>
        </div>
        <div>
          <div class="section-h">Platform Links Shared</div>
          <div class="bars" style="background:var(--bg-1); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:150px; display:flex; flex-direction:column; gap:9px;">
`;
  const maxPlat = Math.max(1, ...PARTS.map(p => {
    const pt = s.platformStats[p.id];
    return pt ? pt.tt + pt.yt + pt.tw + pt.ig : 0;
  }));
  PARTS.forEach(p => {
    const pt = s.platformStats[p.id] || {tt:0, yt:0, tw:0, ig:0};
    const total = pt.tt + pt.yt + pt.tw + pt.ig;
    if (total > 0) {
      html += `<div class="bar-row" style="align-items:center;">
        <div class="bar-name">${pfpHtml(p.id, "width:22px;height:22px;font-size:10px")}${esc(nameOf(p.id))}</div>
        <div style="flex:1; display:flex; font-size:11px; align-items:center; height:12px;">
          ${pt.tt ? `<div style="width:${(pt.tt/maxPlat*100).toFixed(1)}%; background:#222; height:100%; border:1px solid #444;" title="TikTok: ${pt.tt}"></div>` : ''}
          ${pt.yt ? `<div style="width:${(pt.yt/maxPlat*100).toFixed(1)}%; background:#FF0000; height:100%;" title="YouTube: ${pt.yt}"></div>` : ''}
          ${pt.tw ? `<div style="width:${(pt.tw/maxPlat*100).toFixed(1)}%; background:#1DA1F2; height:100%;" title="Twitter: ${pt.tw}"></div>` : ''}
          ${pt.ig ? `<div style="width:${(pt.ig/maxPlat*100).toFixed(1)}%; background:#E1306C; height:100%;" title="Insta: ${pt.ig}"></div>` : ''}
        </div>
        <div class="bar-val" style="width:30px; text-align:right;">${fmtNum(total)}</div>
      </div>`;
    }
  });
  html += `</div>
        </div>
      </div>

      <div class="section"><div class="section-h">Activity over time (by month) — busiest day: ${esc(s.busy[0])} (${fmtNum(s.busy[1])} msgs)</div>
      <div class="chart-container" style="position: relative; height:200px; width:100%"><canvas id="chart-months"></canvas></div></div>

      <div class="section">
        <div class="section-h">Keyword Trends (Google Trends Style)</div>
        <div style="display:flex; gap:10px; margin-bottom:12px;">
          <input type="text" id="trend-input" placeholder="Type a word (e.g. 'lol', 'good')" class="person-name-input" style="flex:1; max-width:300px;">
          <button class="btn" id="trend-btn">Graph</button>
        </div>
        <div class="chart-container" style="position: relative; height:200px; width:100%"><canvas id="chart-trends"></canvas></div>
      </div>

      <div class="section" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <div class="section-h">Activity by time of day</div>
          <div class="chart-container" style="position: relative; height:150px; width:100%"><canvas id="chart-hours"></canvas></div>
        </div>
        <div>
          <div class="section-h">Activity by Day of Week</div>
          <div class="chart-container" style="position: relative; height:150px; width:100%"><canvas id="chart-weekdays"></canvas></div>
        </div>
      </div>

      <div class="section"><div class="section-h">Top Emojis</div><div class="words" id="top-emojis"></div></div>

      <div class="section"><div class="section-h">Most-used words — click to search</div><div class="words" id="words"></div></div>
    </div></div>`;
  v.innerHTML = html;

  const emc = v.querySelector("#top-emojis");
  s.emojis.forEach(([e, c]) => {
     const chip = el("div", "word", e + "<b>" + fmtNum(c) + "</b>");
     emc.appendChild(chip);
  });

  const wc = v.querySelector("#words");
  wc.classList.add("cloud");
  const cloudWords = computeWords();
  if (cloudWords.length) {
    const counts = cloudWords.map((x) => x[1]);
    const cmin = Math.min(...counts), cmax = Math.max(...counts);
    const span = Math.max(1, cmax - cmin);
    cloudWords.forEach(([w, c]) => {
      const t = (c - cmin) / span;                 // 0..1
      const size = (13 + t * 23).toFixed(1);       // 13px → 36px
      const op = (0.6 + t * 0.4).toFixed(2);
      const chip = el("div", "word cloud-word", esc(w) + "<b>" + fmtNum(c) + "</b>");
      chip.style.fontSize = size + "px";
      chip.style.opacity = op;
      chip.title = fmtNum(c) + " uses — click to search";
      chip.onclick = () => { setView("search"); clearAllFilters(); sEls.input.value = w; sEls.clear.hidden = false; runSearch(); };
      wc.appendChild(chip);
    });
  }

  // Clickable person bars → filter search by person
  v.querySelectorAll(".bar-clickable").forEach(row => {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      const pid = row.dataset.personId;
      if (pid) {
        setView("search");
        clearAllFilters();
        F.people.add(pid);
        updatePeopleBadge();
        runSearch();
      }
    });
  });

  if (window.Chart) {
    Chart.defaults.color = 'rgba(255,255,255,0.6)';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.1)';
    const ctxM = document.getElementById("chart-months").getContext("2d");
    new Chart(ctxM, {
      type: 'bar',
      data: {
        labels: s.monthArr.map(m => m[0]),
        datasets: [{ label: 'Messages', data: s.monthArr.map(m => m[1]), backgroundColor: settings.accent, borderRadius: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
    const ctxH = document.getElementById("chart-hours").getContext("2d");
    new Chart(ctxH, {
      type: 'line',
      data: {
        labels: Array.from({length: 24}, (_, i) => i + ":00"),
        datasets: [{ label: 'Messages', data: s.hourCount, borderColor: settings.accent, backgroundColor: hexA(settings.accent, 0.2), fill: true, tension: 0.4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
    const ctxW = document.getElementById("chart-weekdays").getContext("2d");
    new Chart(ctxW, {
      type: 'bar',
      data: {
        labels: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        datasets: [{ label: 'Messages', data: s.weekdayCount, backgroundColor: settings.accent, borderRadius: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  }

  const tInput = v.querySelector("#trend-input");
  const tBtn = v.querySelector("#trend-btn");
  if (tInput && tBtn) {
    tBtn.onclick = () => updateTrendChart(tInput.value);
    tInput.onkeydown = (e) => { if (e.key === "Enter") updateTrendChart(tInput.value); };
    trendChart = null; // reset for new view render
    updateTrendChart("lol"); // default word
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
  input.type = "text"; input.value = settings.names[p.id] || ""; input.placeholder = "User " + p.id.slice(-4);
  input.addEventListener("input", () => {
    const val = input.value.trim();
    if (val) settings.names[p.id] = val; else delete settings.names[p.id];
    saveSettings();
    if (!PFPS[p.id]) av.textContent = initials(nameOf(p.id));
  });
  row.appendChild(input);
  main.appendChild(row);

  main.appendChild(el("div", "person-meta",
    fmtNum(p.count) + " messages · " + DT.format(p.first).split(",")[0] + ", " + zonedParts(p.first).y +
    " → " + DT.format(p.last).split(",")[0] + ", " + zonedParts(p.last).y +
    ' &nbsp; <span class="person-id">id ' + esc(p.id) + "</span>"));

  if (p.samples.length) {
    const sw = el("div", "samples");
    p.samples.forEach((s) => sw.appendChild(el("div", "sample", esc(s))));
    main.appendChild(sw);
  }

  // A few media this person shared — extra memory jogs for naming them.
  if (p.media && p.media.length) {
    const mw = el("div", "person-media");
    p.media.forEach((it) => {
      if (it.k === "vid") {
        const v = el("video", "person-media-thumb"); v.src = it.m; v.muted = true; v.preload = "metadata";
        mw.appendChild(v);
      } else {
        const img = el("img", "person-media-thumb"); img.src = it.m; img.loading = "lazy"; img.alt = "";
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
  PALETTE.forEach((col) => {
    const sw = el("div", "swatch"); sw.style.background = col; sw.style.color = col;
    if (colorOf(p.id).toLowerCase() === col.toLowerCase()) sw.classList.add("sel");
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

// P1-3: pfp/gc photo values reach the DOM as raw style="...url('...')" string
// interpolation (pfpHtml) or as a CSSOM background-image (applyPfp/updateBrand).
// Values written by the app itself (base64 data URLs, wizard-saved slug paths)
// are always one of these two shapes; Import Settings assigns settings.pfps/
// settings.gc verbatim from an arbitrary JSON file, so validate the shape
// before a value is trusted anywhere. Anything else collapses to "" (falsy),
// which every call site already treats as "no photo" (initials fallback).
const PHOTO_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i;
const PHOTO_PATH_RE = /^(?:personal_data|sample_media)\/[A-Za-z0-9._/-]+$/;
function sanitizePhoto(v) {
  if (typeof v !== "string") return "";
  return (PHOTO_RE.test(v) || PHOTO_PATH_RE.test(v)) ? v : "";
}

function renderSettings() {
  const v = document.getElementById("view-settings");
  v.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">Settings</div>
    <div class="page-sub">All preferences are saved in this browser.</div></div>
    <div class="page-body">

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Accent color</div><div class="set-desc">Stays black + blue; pick a shade or a custom color.</div></div>
          <div class="set-control"><div class="preset-swatches" id="set-accents"></div><input type="color" id="set-accent-custom" value="${esc(settings.accent)}"><button class="btn ghost sm" id="set-shuffle" title="Surprise me">🎲 Shuffle</button></div></div>
        <div class="set-row"><div><div class="set-label">Dark intensity</div><div class="set-desc">How black the background is.</div></div>
          <div class="set-control"><div class="seg" id="set-intensity">
            <button data-v="black">Pure black</button><button data-v="midnight">Midnight</button><button data-v="navy">Navy</button>
          </div></div></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Font size</div><div class="set-desc">${settings.fontSize}px</div></div>
          <div class="set-control"><input type="range" id="set-font" min="13" max="19" step="1" value="${settings.fontSize}"></div></div>
        <div class="set-row"><div><div class="set-label">Density</div><div class="set-desc">Spacing between messages.</div></div>
          <div class="set-control"><div class="seg" id="set-density">
            <button data-v="comfortable">Comfortable</button><button data-v="compact">Compact</button>
          </div></div></div>
        <div class="set-row"><div><div class="set-label">Show avatars</div></div>
          <div class="set-control"><label class="switch"><input type="checkbox" id="set-av" ${settings.avatars ? "checked" : ""}><span class="track"></span></label></div></div>
        <div class="set-row"><div><div class="set-label">Show timestamps</div></div>
          <div class="set-control"><label class="switch"><input type="checkbox" id="set-ts" ${settings.timestamps ? "checked" : ""}><span class="track"></span></label></div></div>
        <div class="set-row"><div><div class="set-label">Timezone</div><div class="set-desc">How timestamps are formatted.</div></div>
          <div class="set-control"><select id="set-tz" style="background:var(--bg-2);border:1px solid var(--line);color:var(--text);padding:8px;border-radius:8px;font-family:var(--font);font-size:14px;outline:0;cursor:pointer;">
            <option value="UTC" ${settings.timezone === "UTC" ? "selected" : ""}>UTC (Original Data)</option>
            <option value="local" ${settings.timezone === "local" ? "selected" : ""}>Browser Local Time</option>
            <option value="America/New_York" ${settings.timezone === "America/New_York" ? "selected" : ""}>US Eastern (EST/EDT)</option>
            <option value="America/Chicago" ${settings.timezone === "America/Chicago" ? "selected" : ""}>US Central (CST/CDT)</option>
            <option value="America/Denver" ${settings.timezone === "America/Denver" ? "selected" : ""}>US Mountain (MST/MDT)</option>
            <option value="America/Los_Angeles" ${settings.timezone === "America/Los_Angeles" ? "selected" : ""}>US Pacific (PST/PDT)</option>
            <option value="Europe/London" ${settings.timezone === "Europe/London" ? "selected" : ""}>British Time (GMT/BST)</option>
            <option value="Europe/Paris" ${settings.timezone === "Europe/Paris" ? "selected" : ""}>Central European (CET/CEST)</option>
            <option value="Australia/Sydney" ${settings.timezone === "Australia/Sydney" ? "selected" : ""}>Australian Eastern (AEST/AEDT)</option>
          </select></div></div>
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
        <div class="set-row"><div><div class="set-label">Reset customization</div><div class="set-desc">Clears names, colors, theme &amp; saved searches.</div></div>
          <div class="set-control"><button class="btn ghost" id="set-reset">Reset all</button></div></div>
      </div>

      <div class="set-group">
        <div class="set-row"><div><div class="set-label">Export settings</div><div class="set-desc">Download your names, colors, themes and saved searches.</div></div>
          <div class="set-control"><button class="btn ghost" id="set-export">Export JSON</button></div></div>
        <div class="set-row"><div><div class="set-label">Import settings</div><div class="set-desc">Restore settings from a previously saved JSON file.</div></div>
          <div class="set-control">
            <input type="file" id="set-import-file" accept=".json" style="display:none;">
            <button class="btn ghost" id="set-import">Import JSON</button>
          </div></div>
      </div>

    </div></div>`;

  // accents
  const ac = v.querySelector("#set-accents");
  ACCENTS.forEach((col) => {
    const p = el("div", "preset"); p.style.background = col;
    if (settings.accent.toLowerCase() === col.toLowerCase()) p.classList.add("sel");
    p.onclick = () => { settings.accent = col; saveSettings(); applyTheme(); renderSettings(); };
    ac.appendChild(p);
  });
  v.querySelector("#set-accent-custom").oninput = (e) => { settings.accent = e.target.value; saveSettings(); applyTheme(); };
  v.querySelector("#set-shuffle").onclick = () => shuffleTheme();

  segWire(v.querySelector("#set-intensity"), settings.intensity, (val) => { settings.intensity = val; saveSettings(); applyTheme(); });
  segWire(v.querySelector("#set-density"), settings.density, (val) => { settings.density = val; saveSettings(); applyTheme(); });

  const font = v.querySelector("#set-font");
  font.oninput = () => { settings.fontSize = +font.value; font.closest(".set-row").querySelector(".set-desc").textContent = settings.fontSize + "px"; saveSettings(); applyTheme(); };
  v.querySelector("#set-av").onchange = (e) => { settings.avatars = e.target.checked; saveSettings(); applyTheme(); };
  v.querySelector("#set-ts").onchange = (e) => { settings.timestamps = e.target.checked; saveSettings(); applyTheme(); };
  v.querySelector("#set-tz").onchange = (e) => {
    settings.timezone = e.target.value; saveSettings(); initDateFormatters();
    // Every zone-dependent derived cache must be dropped: stats, word/keyword
    // months, milestones, Hall of Fame years, threads, and each Wrapped year.
    STATS = null; WORDS = null; MILES = null; HOF = null; threadsCache = null;
    for (const k in wrappedCache) delete wrappedCache[k];
    buildSidebarSparkline();
    if (curView && curView !== "settings") setView(curView);
    toast("Timezone updated");
  };

  const gcl = v.querySelector("#set-gcs");
  visibleConvos().forEach((c) => {
    const entry = (settings.gc && settings.gc[c.id]) || {};
    const lgc = LOCAL_GC ? (LOCAL_GC[c.id] || (("name" in LOCAL_GC || "photo" in LOCAL_GC) ? LOCAL_GC : null)) : null;
    const effPhoto = sanitizePhoto(entry.photo || (lgc && lgc.photo) || settings.gcPhoto || "");
    const row = el("div", "gc-item");
    const av = el("div", "gc-av");
    if (effPhoto) av.style.backgroundImage = `url('${effPhoto}')`; else av.textContent = "💬";
    const mid = el("div", "gc-mid");
    const name = document.createElement("input");
    name.type = "text"; name.className = "gc-name-input";
    name.placeholder = convLabel(c); name.value = entry.name || "";
    name.oninput = () => {
      if (!settings.gc[c.id]) settings.gc[c.id] = {};
      const val = name.value.trim();
      if (val) settings.gc[c.id].name = val; else delete settings.gc[c.id].name;
      saveGc();
      if (CONV && c.id === CONV.id) updateBrand();
    };
    mid.appendChild(name);
    mid.appendChild(el("div", "gc-item-meta", esc(convLabel(c)) + " · " + fmtNum(c.count) + " messages"));
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.style.display = "none";
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
    const del = el("button", "icon-btn", "🗑"); del.onclick = () => { settings.saved.splice(idx, 1); saveSettings(); renderSettings(); };
    item.appendChild(run); item.appendChild(del); sl.appendChild(item);
  });

  v.querySelector("#set-reset").onclick = () => {
    if (!confirm("Reset all names, colors, theme and saved searches?")) return;
    settings = Object.assign({}, DEFAULTS, { names: {}, colors: {}, saved: [] });
    saveSettings(); applyTheme(); renderSettings(); toast("Customization reset");
  };

  v.querySelector("#set-export").onclick = () => {
    const data = JSON.stringify(buildExportPayload(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gca-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Settings exported");
  };

  const importFile = v.querySelector("#set-import-file");
  v.querySelector("#set-import").onclick = () => importFile.click();
  importFile.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported && (imported.names || imported.colors || imported.accent || imported.gc)) {
          settings = Object.assign({}, DEFAULTS, imported);
          settings.names = Object.assign({}, imported.names || {});
          settings.colors = Object.assign({}, imported.colors || {});
          // Untrusted file: validate every photo value's shape before it can ever
          // reach a style="...url('...')" sink (P1-3). Anything that isn't a
          // data: URL or a personal_data/sample_media-relative path is dropped.
          const importedPfps = (imported.pfps && typeof imported.pfps === "object") ? imported.pfps : {};
          settings.pfps = {};
          for (const uid in importedPfps) {
            const p = sanitizePhoto(importedPfps[uid]);
            if (p) settings.pfps[uid] = p;
          }
          const importedGc = (imported.gc && typeof imported.gc === "object") ? imported.gc : {};
          settings.gc = {};
          for (const cid in importedGc) {
            const entry = importedGc[cid] && typeof importedGc[cid] === "object" ? Object.assign({}, importedGc[cid]) : {};
            const p = sanitizePhoto(entry.photo);
            if (p) entry.photo = p; else delete entry.photo;
            settings.gc[cid] = entry;
          }
          settings.ignoredUsers = Array.isArray(imported.ignoredUsers) ? imported.ignoredUsers.map(String) : [];
          settings.ignoredGroups = Array.isArray(imported.ignoredGroups) ? imported.ignoredGroups.map(String) : [];
          settings.saved = Array.isArray(imported.saved) ? imported.saved : [];
          settings.pins = Array.isArray(imported.pins) ? imported.pins.slice() : [];
          saveSettings(); savePfps(); saveGc();   // bulky photos live under their own keys
          // rebuild the in-place PFPS map (a const reference used across the app)
          for (const k in PFPS) delete PFPS[k];
          Object.assign(PFPS, (typeof window !== "undefined" && window.LOCAL_PFPS) || {}, settings.pfps);
          // if the active conversation was just hidden by an imported ignoredGroups,
          // jump to a still-visible one so the viewer doesn't show a removed chat
          if (CONV && ignoredGroupIds().has(String(CONV.id))) {
            const vis = visibleConvos();
            if (vis[0]) activateConversation(vis[0].id, true);
          }
          applyTheme();
          renderConvPicker();
          if (typeof updateBrand === "function") updateBrand();
          renderSettings();
          toast("Settings imported successfully");
        } else {
          toast("Invalid settings file");
        }
      } catch (err) {
        toast("Error parsing settings file");
      }
    };
    reader.readAsText(file);
  };
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
function setView(name) {
  curView = name;
  try { localStorage.setItem("gca.lastView", name); } catch(e) {}
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  document.querySelectorAll(".nav-item").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  if (name === "search") { ensureSearch(); setTimeout(() => sEls.input && sEls.input.focus(), 0); }
  else if (name === "timeline") { if (!tlBuilt) openTimeline(0); }
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

function updateBrand() {
  const nameEv = EVENTS.filter((e) => e.type === "name");
  // LOCAL_GC is per-conversation { convId: { name, photo } }; older builds wrote a
  // single flat { name, photo } that applied to every group — support both.
  const lgc = LOCAL_GC ? (LOCAL_GC[CONV && CONV.id] || (("name" in LOCAL_GC || "photo" in LOCAL_GC) ? LOCAL_GC : null)) : null;
  // In-app per-group override (Settings → Group chats) wins over the wizard's
  // LOCAL_GC, which wins over the legacy flat gcName/gcPhoto.
  const sgc = (settings.gc && CONV) ? settings.gc[CONV.id] : null;
  const gcName = (sgc && sgc.name) || (lgc && lgc.name) || settings.gcName;
  const title = gcName || (CONV && CONV.title) || (nameEv.length ? nameEv[nameEv.length - 1].name : convLabel(CONV));
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
      if (!mark.textContent) mark.textContent = "💬";
    }
  }
  document.getElementById("brand-title").textContent = title || "Group Chat";
  document.getElementById("brand-sub").textContent = fmtNum(N) + " messages";
  document.getElementById("sidebar-foot").innerHTML =
    (N ? zonedParts(MSGS[0].t).y + "–" + zonedParts(MSGS[N - 1].t).y : "") +
    " · " + PARTS.length + " people<br>" + fmtNum(MSGS.filter((m) => m.m).length) + " photos & videos";
}

function renderConvPicker() {
  const host = document.getElementById("conv-picker");
  if (!host) return;
  const convos = visibleConvos();
  if (convos.length <= 1) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  const opt = (c) => `<option value="${esc(c.id)}"${CONV && c.id === CONV.id ? " selected" : ""}>${esc(convLabel(c))} · ${fmtNum(c.count)}</option>`;
  const body = convos.map(opt).join("");
  host.innerHTML = `<label class="conv-pick-label">Group chat (${convos.length})</label>
    <select id="conv-select" class="conv-select">${body}</select>`;
  host.querySelector("#conv-select").onchange = (e) => activateConversation(e.target.value, true);
}

function init() {
  applyTheme();
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

  // Decorative glyphs in nav items — hide from assistive tech so the label reads cleanly.
  document.querySelectorAll(".nav-ico").forEach((s) => s.setAttribute("aria-hidden", "true"));

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openCommandPalette(); return; }
    if (e.key === "Escape") {
      const cmdk = document.querySelector(".cmdk"); if (cmdk) { cmdk.remove(); restoreFocus(); return; }
      const ctx = document.querySelector(".ctx-modal"); if (ctx) { ctx.remove(); restoreFocus(); return; }
      const kb = document.querySelector(".kb-modal");
      if (kb) { kb.remove(); restoreFocus(); return; }
      const prof = document.querySelector(".profile-modal"); if (prof) { prof.remove(); restoreFocus(); return; }
      const lbs = document.querySelectorAll(".lightbox");
      if (lbs.length) { lbs.forEach((l) => l.remove()); restoreFocus(); }
      closePopovers();
    }
    if (curView === "wrapped" && !document.querySelector(".cmdk, .ctx-modal, .kb-modal, .lightbox, .profile-modal") && document.activeElement.tagName !== "INPUT") {
      if (e.key === "ArrowRight") { e.preventDefault(); wrappedGo(1); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); wrappedGo(-1); return; }
    }
    if (e.key === "/" && curView !== "search" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); setView("search"); }
    if (e.key === "?" && document.activeElement.tagName !== "INPUT" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleKeyboardHelp(); }
  });

  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;
  buildSidebarSparkline();
  showOnThisDayToast();
  const lastView = localStorage.getItem("gca.lastView");
  setView((lastView && ["search","timeline","stats","people","settings","capsule","gallery","pins","hof","wrapped","threads","battles","chains"].includes(lastView)) ? lastView : "search");
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
  ov.innerHTML = `
    <div class="onboard-card">
      <div class="onboard-title">Welcome to your Group Chat Archive 💬</div>
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
      <div class="onboard-note">The wizard needs the local server: run
        <code>node scripts/server.js</code> and open
        <code>localhost:8765/setup.html</code>.</div>
      <div class="onboard-actions">
        <a class="btn primary" href="setup.html">Open setup wizard</a>
        <button class="btn ghost" id="onboard-people">Go to People tab</button>
        <button class="btn ghost" id="onboard-dismiss">Maybe later</button>
      </div>
      <label class="onboard-dontshow"><input type="checkbox" id="onboard-never"> Don't show this again</label>
    </div>`;
  const close = () => {
    if (ov.querySelector("#onboard-never").checked) { try { localStorage.setItem("gca.onboarded", "1"); } catch (e) {} }
    ov.remove();
  };
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector("#onboard-people").onclick = () => { close(); setView("people"); };
  ov.querySelector("#onboard-dismiss").onclick = close;
  document.body.appendChild(ov);
}

/* ===========================================================================
   TIME CAPSULE VIEW
   ======================================================================== */
function renderCapsule() {
  const v = document.getElementById("view-capsule");
  v.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">Time Capsule</div>
    <div class="page-sub">On this day in history...</div></div>
    <div class="page-body scroll" id="capsule-body" style="height: calc(100vh - 120px); overflow-y: auto;"></div></div>`;
  const body = v.querySelector("#capsule-body");
  
  // "Today" and each message are compared in the configured zone, so "on this
  // day" means the same calendar day the timestamps are labelled with.
  const todayZ = zonedParts(Date.now());
  const tMonth = todayZ.mo;
  const tDate = todayZ.d;
  const tYear = todayZ.y;

  const matchesByYear = {};

  for (let i = 0; i < N; i++) {
    const z = zonedParts(MSGS[i].t);
    if (z.mo === tMonth && z.d === tDate) {
      const yr = z.y;
      if (yr === tYear) continue;
      if (!matchesByYear[yr]) matchesByYear[yr] = [];
      matchesByYear[yr].push(i);
    }
  }
  
  const years = Object.keys(matchesByYear).sort((a,b) => b - a);
  if (years.length === 0) {
    body.innerHTML = `<div class="empty"><div class="big">🕰️</div><div>No messages found on this day in past years.</div></div>`;
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
  // Every sender ignored (P1-4): nothing to gallery — show a panel, not an
  // empty grid that looks broken.
  if (!N) {
    v.innerHTML = '<div class="empty"><div class="big">🖼</div><div>No messages in this group — every sender is ignored.</div></div>';
    return;
  }
  if (!v.innerHTML) {
    v.innerHTML = `<div class="toolbar">
        <div class="result-meta">Media Gallery — All Photos & Videos</div>
      </div>
      <div class="scroll" id="gal-scroll"><div class="gallery" id="gal-list"></div></div>`;
    
    galEls = { scroll: v.querySelector("#gal-scroll"), list: v.querySelector("#gal-list") };
    
    const items = [];
    for (let i = 0; i < N; i++) {
      if (MSGS[i].m) items.push(i);
    }
    galleryState.items = items.reverse();
    
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
    frag.appendChild(galleryCell(i));
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
   SHARED STOPWORDS (word cloud, wrapped top word)
   ======================================================================== */
const STOPWORDS = new Set("the a an and or but to of in on at for with is are was were be been being am i you he she it we they them me my your our this that these those have has had do does did not no so if as up out get got go gonna just like dont didnt cant wont im youre theyre thats whats here there all any some more most then than too very can could would should will shall may might must about into over under again only also even still much many lol lmao lmaooo yeah yea nah ok okay haha hahaha bro man dude what when who whom how why which whose oh uh um yo idk imo tbh".split(/\s+/));

/* ===========================================================================
   THEME SHUFFLE (surprise me — stays black + blue)
   ======================================================================== */
function shuffleTheme() {
  const order = ["black", "midnight", "navy"];
  settings.accent = ACCENTS[Math.floor(Math.random() * ACCENTS.length)];
  settings.intensity = order[Math.floor(Math.random() * order.length)];
  saveSettings(); applyTheme();
  if (curView === "settings") renderSettings();
  toast("🎨 New theme — " + settings.intensity + " · " + settings.accent);
}

/* ===========================================================================
   SIDEBAR ACTIVITY SPARKLINE (monthly message volume)
   ======================================================================== */
function buildSidebarSparkline() {
  const foot = document.getElementById("sidebar-foot");
  if (!foot) return;
  const months = {};
  for (let i = 0; i < N; i++) {
    const ym = zonedParts(MSGS[i].t).key.slice(0, 7);   // "YYYY-MM" in the configured zone
    months[ym] = (months[ym] || 0) + 1;
  }
  const vals = Object.keys(months).sort().map((k) => months[k]);
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
  foot.insertAdjacentHTML("afterbegin", svg);
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
  const years = [...new Set(arr.map((x) => zonedParts(x.t).y))].sort((a, b) => b - a);
  HOF = { arr, years };
  return HOF;
}
function renderHallOfFame() {
  const v = document.getElementById("view-hof");
  const h = computeHOF();
  if (!hofYear || (hofYear !== "all" && h.years.indexOf(+hofYear) < 0)) hofYear = "all";
  const inYear = (x) => hofYear === "all" || zonedParts(x.t).y === +hofYear;
  const items = h.arr.filter(inYear);

  const yearChips = ['<button class="pill hof-yr' + (hofYear === "all" ? " active" : "") + '" data-yr="all">All time</button>']
    .concat(h.years.map((y) => '<button class="pill hof-yr' + (hofYear === String(y) ? " active" : "") + '" data-yr="' + y + '">' + y + "</button>")).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">🏆 Hall of Fame</div>
      <div class="page-sub">The most-reacted messages of all time — the legendary moments, ranked by reaction count.</div></div>
    <div class="page-body">
      <div class="hof-years">${yearChips}</div>
      ${items.length ? '<div class="hof-podium" id="hof-podium"></div>' : ''}
      <div class="section"><div class="section-h">Top reacted messages</div><div class="list" id="hof-list"></div></div>
      <div class="section" id="hof-media-sec" hidden><div class="section-h">Most-reacted media</div><div class="gallery" id="hof-media"></div></div>
    </div></div>`;

  v.querySelectorAll(".hof-yr").forEach((b) => { b.onclick = () => { hofYear = b.dataset.yr; renderHallOfFame(); }; });

  if (!items.length) {
    v.querySelector("#hof-list").appendChild(el("div", "empty", '<div class="big">🏆</div><div>No reacted messages in this period.</div>'));
    return;
  }

  // Podium — top 3
  const podium = v.querySelector("#hof-podium");
  const medals = ["🥇", "🥈", "🥉"];
  items.slice(0, 3).forEach((x, k) => {
    const m = MSGS[x.i];
    const card = el("div", "hof-card rank-" + (k + 1));
    const snippet = (m.x || "").trim() || (m.m ? "📷 media" : "—");
    card.innerHTML = `<div class="hof-medal">${medals[k]}</div>
      ${pfpHtml(m.s, "width:34px;height:34px;font-size:13px")}
      <div class="hof-meta">
        <div class="hof-name">${esc(nameOf(m.s))}</div>
        <div class="hof-date">${esc(DT.format(m.t))}</div>
      </div>
      <div class="hof-snip">${esc(snippet.slice(0, 140))}${snippet.length > 140 ? "…" : ""}</div>
      <div class="hof-rc">🔥 ${fmtNum(x.rc)} reaction${x.rc === 1 ? "" : "s"}</div>`;
    card.onclick = () => jumpTo(x.i);
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
    const badge = el("div", "hof-badge", "🔥 " + fmtNum(x.rc));
    node.appendChild(badge);
    frag.appendChild(node);
    shown++;
  }
  if (shown === 0) list.appendChild(el("div", "empty", '<div class="big">💬</div><div>The most-reacted items here are all media — see below.</div>'));
  list.appendChild(frag);

  // Media grid
  const mediaItems = items.filter((x) => x.media).slice(0, 24);
  if (mediaItems.length) {
    v.querySelector("#hof-media-sec").hidden = false;
    const grid = v.querySelector("#hof-media");
    mediaItems.forEach((x) => {
      const cell = galleryCell(x.i);
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
  const set = new Set();
  for (let i = 0; i < N; i++) set.add(zonedParts(MSGS[i].t).y);
  wrappedCache.__years = [...set].sort((a, b) => a - b);
  return wrappedCache.__years;
}
function computeWrapped(year) {
  if (wrappedCache[year]) return wrappedCache[year];
  const perPerson = {}, dayCount = {}, emojis = {}, words = {};
  let total = 0, media = 0, reacts = 0, chars = 0;
  let topMsg = { i: -1, rc: -1 };
  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    const zp = zonedParts(m.t);
    if (zp.y !== year) continue;
    total++;
    perPerson[m.s] = (perPerson[m.s] || 0) + 1;
    dayCount[zp.key] = (dayCount[zp.key] || 0) + 1;
    if (m.m) media++;
    const rc = m.r ? m.r.length : 0;
    reacts += rc;
    if (rc > topMsg.rc) topMsg = { i, rc };
    if (m.x) {
      chars += m.x.length;
      const ems = m.x.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu);
      if (ems) ems.forEach((e) => (emojis[e] = (emojis[e] || 0) + 1));
      const toks = m.x.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9']+/g, " ").split(" ");
      for (const t of toks) { if (t.length < 3 || t.length > 18 || STOPWORDS.has(t)) continue; words[t] = (words[t] || 0) + 1; }
    }
  }
  const people = Object.entries(perPerson).sort((a, b) => b[1] - a[1]);
  let busyDay = "", busyN = 0;
  for (const k in dayCount) if (dayCount[k] > busyN) { busyN = dayCount[k]; busyDay = k; }
  const topEmoji = Object.entries(emojis).sort((a, b) => b[1] - a[1])[0] || null;
  const topWords = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 5);
  wrappedCache[year] = {
    year, total, media, reacts, chars,
    people, activeDays: Object.keys(dayCount).length,
    busyDay, busyN, topEmoji, topWords, topMsg,
  };
  return wrappedCache[year];
}
function wrappedSlides(w) {
  const slides = [];
  slides.push({ kind: "intro", big: w.year, label: "Wrapped", sub: "A year in the group chat" });
  slides.push({ kind: "stat", emoji: "💬", big: fmtNum(w.total), label: "messages sent in " + w.year, sub: "across " + fmtNum(w.activeDays) + " active days" });
  if (w.people.length) {
    const [id, c] = w.people[0];
    slides.push({ kind: "person", id, big: fmtNum(c), label: "messages from " + nameOf(id), sub: nameOf(id) + " was the most active this year", podium: w.people.slice(0, 3) });
  }
  if (w.busyDay) slides.push({ kind: "stat", emoji: "🔥", big: fmtNum(w.busyN), label: "messages in a single day", sub: "the busiest day was " + DAY.format(dayKeyBoundInstant(w.busyDay)) });
  if (w.topWords.length) slides.push({ kind: "words", emoji: "🗣️", big: '"' + w.topWords[0][0] + '"', label: "the word of the year", sub: "used " + fmtNum(w.topWords[0][1]) + " times", list: w.topWords });
  if (w.topEmoji) slides.push({ kind: "stat", emoji: w.topEmoji[0], big: w.topEmoji[0], label: "the emoji of the year", sub: "sent " + fmtNum(w.topEmoji[1]) + " times", giant: true });
  slides.push({ kind: "stat", emoji: "📷", big: fmtNum(w.media), label: "photos & videos shared", sub: fmtNum(w.reacts) + " reactions given all year" });
  if (w.topMsg.i >= 0 && w.topMsg.rc > 0) slides.push({ kind: "star", i: w.topMsg.i, rc: w.topMsg.rc });
  slides.push({ kind: "outro", big: "🎁", label: "That was " + w.year, sub: "Tap a different year above to relive another one" });
  return slides;
}
function renderWrapped() {
  const v = document.getElementById("view-wrapped");
  const years = wrappedYears();
  if (!years.length) { v.innerHTML = '<div class="page"><div class="empty"><div class="big">🎁</div><div>No data to wrap.</div></div></div>'; return; }
  if (wrappedYear == null || years.indexOf(wrappedYear) < 0) wrappedYear = years[years.length - 1];

  const chips = years.map((y) => '<button class="pill wr-yr' + (y === wrappedYear ? " active" : "") + '" data-yr="' + y + '">' + y + "</button>").join("");
  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">🎁 Wrapped</div>
      <div class="page-sub">Your group chat, recapped year by year. Use the arrows (or ← →) to flip through.</div></div>
    <div class="page-body">
      <div class="wr-years">${chips}</div>
      <div class="wr-stage" id="wr-stage"></div>
      <div class="wr-controls">
        <button class="btn ghost" id="wr-prev">‹ Back</button>
        <div class="wr-dots" id="wr-dots"></div>
        <button class="btn" id="wr-next">Next ›</button>
      </div>
    </div></div>`;

  v.querySelectorAll(".wr-yr").forEach((b) => { b.onclick = () => { wrappedYear = +b.dataset.yr; wrappedSlide = 0; renderWrapped(); }; });
  v.querySelector("#wr-prev").onclick = () => wrappedGo(-1);
  v.querySelector("#wr-next").onclick = () => wrappedGo(1);
  drawWrappedSlide();
}
function wrappedGo(dir) {
  const w = computeWrapped(wrappedYear);
  const slides = wrappedSlides(w);
  wrappedSlide = Math.max(0, Math.min(slides.length - 1, wrappedSlide + dir));
  drawWrappedSlide();
}
function drawWrappedSlide() {
  const stage = document.getElementById("wr-stage");
  if (!stage) return;
  const w = computeWrapped(wrappedYear);
  const slides = wrappedSlides(w);
  wrappedSlide = Math.max(0, Math.min(slides.length - 1, wrappedSlide));
  const s = slides[wrappedSlide];

  let inner;
  if (s.kind === "intro" || s.kind === "outro") {
    inner = `<div class="wr-hero ${s.kind}"><div class="wr-big">${esc(String(s.big))}</div>
      <div class="wr-label">${esc(s.label)}</div><div class="wr-sub">${esc(s.sub)}</div></div>`;
  } else if (s.kind === "person") {
    const podium = s.podium.map(([id, c], k) => `<div class="wr-podium-row">
        <span class="wr-rank">${k + 1}</span>${pfpHtml(id, "width:28px;height:28px;font-size:11px")}
        <span class="wr-pname">${esc(nameOf(id))}</span><span class="wr-pcount">${fmtNum(c)}</span></div>`).join("");
    inner = `<div class="wr-hero">${pfpHtml(s.id, "width:72px;height:72px;font-size:26px;margin:0 auto 14px")}
      <div class="wr-big">${esc(String(s.big))}</div><div class="wr-label">${esc(s.label)}</div>
      <div class="wr-sub">${esc(s.sub)}</div><div class="wr-podium">${podium}</div></div>`;
  } else if (s.kind === "words") {
    const chips = s.list.map(([word, c], k) => `<span class="wr-wordchip${k === 0 ? " top" : ""}">${esc(word)} <b>${fmtNum(c)}</b></span>`).join("");
    inner = `<div class="wr-hero"><div class="wr-emoji">${s.emoji}</div><div class="wr-big">${esc(String(s.big))}</div>
      <div class="wr-label">${esc(s.label)}</div><div class="wr-sub">${esc(s.sub)}</div>
      <div class="wr-wordchips">${chips}</div></div>`;
  } else if (s.kind === "star") {
    inner = `<div class="wr-hero"><div class="wr-emoji">⭐</div>
      <div class="wr-label">Most-reacted message of ${w.year}</div>
      <div class="wr-sub">${fmtNum(s.rc)} reaction${s.rc === 1 ? "" : "s"}</div>
      <div class="wr-star" id="wr-star"></div></div>`;
    stage.className = "wr-stage";
    stage.innerHTML = inner;
    const host = stage.querySelector("#wr-star");
    if (host) host.appendChild(renderMsg(s.i, { clickable: true }));
    paintWrappedDots(slides.length);
    return;
  } else {
    inner = `<div class="wr-hero"><div class="wr-emoji${s.giant ? " giant" : ""}">${s.emoji}</div>
      <div class="wr-big">${esc(String(s.big))}</div><div class="wr-label">${esc(s.label)}</div>
      <div class="wr-sub">${esc(s.sub)}</div></div>`;
  }
  // re-trigger entrance animation
  stage.className = "wr-stage";
  void stage.offsetWidth;
  stage.innerHTML = inner;
  stage.classList.add("wr-anim");
  paintWrappedDots(slides.length);
}
function paintWrappedDots(n) {
  const dots = document.getElementById("wr-dots");
  if (!dots) return;
  dots.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const d = el("span", "wr-dot" + (i === wrappedSlide ? " on" : ""));
    d.onclick = () => { wrappedSlide = i; drawWrappedSlide(); };
    dots.appendChild(d);
  }
}

/* ---- Keyboard shortcuts modal ------------------------------------------- */
function toggleKeyboardHelp() {
  const existing = document.querySelector(".kb-modal");
  if (existing) { existing.remove(); restoreFocus(); return; }
  const modal = el("div", "kb-modal");
  modal.innerHTML = `
    <div class="kb-content">
      <div class="kb-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="kb-close">✕</button>
      </div>
      <div class="kb-body">
        <div class="kb-row"><kbd>Ctrl</kbd> <kbd>K</kbd><span>Command palette (jump anywhere)</span></div>
        <div class="kb-row"><kbd>/</kbd><span>Focus search</span></div>
        <div class="kb-row"><kbd>?</kbd><span>Show this help</span></div>
        <div class="kb-row"><kbd>Esc</kbd><span>Close palette / modal / lightbox / popover</span></div>
        <div class="kb-row"><kbd>←</kbd> <kbd>→</kbd><span>Navigate lightbox</span></div>
        <div class="kb-row"><kbd>Scroll</kbd><span>Zoom image in lightbox</span></div>
        <div class="kb-row"><kbd>★</kbd><span>Hover a message → bookmark, quote, or peek context</span></div>
      </div>
      <div class="kb-footer">Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</div>
    </div>`;
  const closeKb = () => { modal.remove(); restoreFocus(); };
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
  if (existing) existing.remove();
  
  if (!STATS) computeStats();
  const s = STATS;
  
  const p = PARTS.find(x => x.id === id);
  if (!p) return;

  const modal = el("div", "profile-modal");
  
  const badges = [];
  const addBadge = (winStat, icon, text) => { if (winStat && winStat.id === id) badges.push({ icon, text }); };
  addBadge(s.owlWinner, "🦉", "Late Night Owl");
  addBadge(s.reactsWinner, "⭐", "Reaction Magnet");
  addBadge(s.emojiWinner, "😂", "Emoji Enthusiast");
  addBadge(s.mediaWinner, "📷", "Media Hog");
  addBadge(s.yapperWinner, "🗣️", "The Yapper");
  addBadge(s.swearWinner, "🤬", "The Sailor");
  addBadge(s.starterWinner, "🚀", "Thread Starter");
  addBadge(s.killerWinner, "💀", "Thread Killer");
  addBadge(s.scholarWinner, "📚", "The Scholar");
  addBadge(s.crowdPleaserWinner, "👏", "Crowd Pleaser");

  let badgesHtml = badges.map(b => `<div class="profile-badge"><i>${b.icon}</i> ${b.text}</div>`).join("");
  
  modal.innerHTML = `
    <div class="profile-card">
      <div class="profile-cover">
        ${pfpHtml(id, "border:4px solid var(--bg-1)")}
        <button class="profile-card-close">✕</button>
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
            <div class="profile-stat-val">${s.yapperStats[id] ? s.yapperStats[id].toFixed(1) : "0"}</div>
            <div class="profile-stat-lbl">Words/Msg</div>
          </div>
          <div class="profile-stat-item">
            <div class="profile-stat-val">${s.scholarStats[id] ? fmtNum(s.scholarStats[id]) : "0"}</div>
            <div class="profile-stat-lbl">Vocab Size</div>
          </div>
        </div>
        
        ${badgesHtml ? `<div class="profile-badges">${badgesHtml}</div>` : ""}
      </div>
    </div>
  `;
  
  const closeProfile = () => { modal.remove(); restoreFocus(); };
  modal.addEventListener("click", (e) => { if (e.target === modal) closeProfile(); });
  modal.querySelector(".profile-card-close").onclick = closeProfile;

  const avInner = modal.querySelector(".av");
  if (avInner) { avInner.classList.remove("av-clickable"); avInner.style.cursor = "default"; }

  document.body.appendChild(modal);
  applyDialog(modal, "Profile — " + nameOf(id), { initial: ".profile-card-close" });
}

/* ===========================================================================
   PINNED / BOOKMARKED MESSAGES VIEW
   ======================================================================== */
function renderPins() {
  const v = document.getElementById("view-pins");
  const ids = settings.pins.slice();
  // Resolve to current indices (skip any pins whose message isn't loaded)
  const idxs = ids.map((id) => ID2IDX.has(id) ? ID2IDX.get(id) : -1).filter((x) => x >= 0);
  // newest pinned first (by pin order reversed) keeps most-recent action on top
  idxs.reverse();

  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">Pinned</div>
      <div class="page-sub">${idxs.length ? fmtNum(idxs.length) + ' bookmarked message' + (idxs.length === 1 ? '' : 's') + ' · saved in this browser' : 'Bookmark any message with the ★ button to keep it here.'}</div>
    </div>
    <div class="page-body">
      ${idxs.length ? '<div class="toolbar" style="padding:0 0 12px;"><button class="pill" id="pins-export">↓ Export</button> <button class="pill danger" id="pins-clear">✕ Clear all</button></div>' : ''}
      <div class="list" id="pins-list"></div>
    </div></div>`;

  const list = v.querySelector("#pins-list");
  if (!idxs.length) {
    list.appendChild(el("div", "empty", '<div class="big">★</div><div>No bookmarks yet.</div><div class="hint">Hover any message and tap the ☆ to pin it here.</div>'));
    return;
  }
  const frag = document.createDocumentFragment();
  idxs.forEach((i) => frag.appendChild(renderMsg(i, { clickable: true })));
  list.appendChild(frag);

  const exp = v.querySelector("#pins-export");
  if (exp) exp.onclick = () => {
    const lines = idxs.map((i) => { const m = MSGS[i]; return DT.format(m.t) + " | " + nameOf(m.s) + ": " + (m.x || "[media]"); });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "pinned-messages-" + new Date().toISOString().slice(0,10) + ".txt"; a.click();
    URL.revokeObjectURL(url); toast("Exported " + fmtNum(idxs.length) + " bookmarks");
  };
  const clr = v.querySelector("#pins-clear");
  if (clr) clr.onclick = () => { if (!confirm("Remove all bookmarks?")) return; settings.pins = []; saveSettings(); renderPins(); toast("Cleared bookmarks"); };
}

/* ===========================================================================
   CONTEXT PEEK — surrounding messages without leaving the current view
   ======================================================================== */
function openContextPeek(center) {
  document.querySelectorAll(".ctx-modal").forEach((m) => m.remove());
  const RADIUS = 5;
  const lo = Math.max(0, center - RADIUS), hi = Math.min(N - 1, center + RADIUS);
  const modal = el("div", "ctx-modal");
  const card = el("div", "ctx-card");
  const head = el("div", "ctx-head");
  head.innerHTML = '<div class="ctx-title">Conversation context</div>';
  const closeCtx = () => { modal.remove(); restoreFocus(); };
  const close = el("button", "kb-close", "✕"); close.onclick = closeCtx;
  head.appendChild(close);
  card.appendChild(head);

  const bodyEl = el("div", "ctx-body");
  let prevDay = null, prevSender = null, prevT = 0;
  for (let i = lo; i <= hi; i++) {
    const dk = dayKey(MSGS[i].t);
    if (dk !== prevDay) { bodyEl.appendChild(el("div", "daysep", esc(DAY.format(MSGS[i].t)))); prevDay = dk; prevSender = null; prevT = 0; }
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
  applyDialog(modal, "Conversation context", { initial: ".kb-close" });
  const c = bodyEl.querySelector(".ctx-center");
  if (c) c.scrollIntoView({ block: "center" });
}

/* ===========================================================================
   QUOTE CARD — render a message to a shareable PNG (offline, canvas)
   ======================================================================== */
function exportQuoteCard(i) {
  const m = MSGS[i];
  const text = (m.x || "").trim();
  if (!text) { toast("Nothing to quote"); return; }
  const cs = getComputedStyle(document.documentElement);
  const cv = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const bg = cv("--bg-1", "#0a0e17");
  const accent = settings.accent || "#3b82f6";
  const txtCol = cv("--text", "#e8edf7"), dim = cv("--text-faint", "#5d6a8c");
  const pColor = colorOf(m.s);

  const W = 720, PAD = 48, AV = 64, contentX = PAD + AV + 22, contentW = W - contentX - PAD;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const FONT = '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';

  // Word-wrap the body text at 26px
  ctx.font = '400 26px ' + FONT;
  const words = text.replace(/\s+/g, " ").split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > contentW && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 12);
  if (lines.length > 12) shown[11] = shown[11].replace(/.{0,2}$/, "…");

  const lineH = 38, headY = PAD + 6;
  const bodyTop = headY + 64;
  const H = Math.max(bodyTop + shown.length * lineH + 64, PAD + AV + 96);

  canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);

  // Card background + accent edge
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, 6, H);

  // Avatar (color disc with initials)
  const ax = PAD + AV / 2, ay = headY + AV / 2;
  ctx.beginPath(); ctx.arc(ax, ay, AV / 2, 0, Math.PI * 2);
  ctx.fillStyle = pColor; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = '700 26px ' + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(initials(nameOf(m.s)), ax, ay + 1);

  // Name + timestamp
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = pColor; ctx.font = '700 27px ' + FONT;
  ctx.fillText(nameOf(m.s), contentX, headY + 26);
  ctx.fillStyle = dim; ctx.font = '400 17px ' + FONT;
  ctx.fillText(DT.format(m.t), contentX, headY + 50);

  // Body
  ctx.fillStyle = txtCol; ctx.font = '400 26px ' + FONT;
  shown.forEach((ln, k) => ctx.fillText(ln, contentX, bodyTop + 26 + k * lineH));

  // Footer watermark
  ctx.fillStyle = dim; ctx.font = '500 15px ' + FONT;
  const brand = (document.getElementById("brand-title") || {}).textContent || "Group Chat Archive";
  ctx.fillText("— " + brand, contentX, H - 26);

  canvas.toBlob((blob) => {
    if (!blob) { toast("Could not render image"); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "quote-" + m.i + ".png"; a.click();
    URL.revokeObjectURL(url); toast("Saved quote image");
  }, "image/png");
}

/* ===========================================================================
   JUMP TO DATE
   ======================================================================== */
function jumpToDate(dateStr) {
  const idx = indexForDate(dateStr);
  if (idx < 0) { toast("Invalid date"); return; }
  jumpTo(idx);
  toast("Jumped to " + dateStr);
}

/* ===========================================================================
   COMMAND PALETTE (Ctrl/Cmd+K)
   ======================================================================== */
function buildCommands() {
  const cmds = [];
  const views = [
    ["search", "⌕", "Search messages"], ["timeline", "≡", "Open Timeline"],
    ["gallery", "🖼", "Media Gallery"], ["hof", "🏆", "Hall of Fame (most reacted)"],
    ["pins", "★", "Pinned messages"], ["capsule", "⏳", "Time Capsule (on this day)"],
    ["wrapped", "🎁", "Wrapped (year in review)"],
    ["threads", "🧵", "Conversation Threads"],
    ["battles", "⚔", "Word Battles (head-to-head)"],
    ["chains", "⛓", "Reply Chains (longest exchanges)"],
    ["stats", "▤", "Stats & overview"],
    ["people", "◉", "People"], ["settings", "⚙", "Settings"],
  ];
  views.forEach(([v, ico, label]) => cmds.push({ ico, label, hint: "View", run: () => setView(v) }));
  cmds.push({ ico: "🎲", label: "Random quote", hint: "Action", run: () => jumpTo(Math.floor(Math.random() * N)) });
  cmds.push({ ico: "⌨", label: "Keyboard shortcuts", hint: "Help", run: () => toggleKeyboardHelp() });
  cmds.push({ ico: "🎨", label: "Cycle accent color", hint: "Theme", run: () => {
    const i = (ACCENTS.indexOf(settings.accent) + 1) % ACCENTS.length;
    settings.accent = ACCENTS[i]; saveSettings(); applyTheme(); toast("Accent: " + settings.accent);
  }});
  cmds.push({ ico: "🌓", label: "Cycle dark intensity", hint: "Theme", run: () => {
    const order = ["black", "midnight", "navy"]; const i = (order.indexOf(settings.intensity) + 1) % order.length;
    settings.intensity = order[i]; saveSettings(); applyTheme(); toast("Intensity: " + settings.intensity);
  }});
  cmds.push({ ico: "🎲", label: "Shuffle theme (surprise me)", hint: "Theme", run: () => shuffleTheme() });
  // People → jump to their first message
  PARTS.forEach((p) => cmds.push({ ico: "👤", label: "Go to " + nameOf(p.id) + "'s first message", hint: "Person", run: () => jumpTo(indexForTime(p.first)) }));
  // Saved searches
  (settings.saved || []).forEach((s) => cmds.push({ ico: "★", label: "Search: " + s.name, hint: "Saved", run: () => { setView("search"); applySaved(s); } }));
  return cmds;
}
function openCommandPalette() {
  document.querySelectorAll(".cmdk").forEach((m) => m.remove());
  const all = buildCommands();
  const modal = el("div", "cmdk");
  modal.innerHTML = `<div class="cmdk-card">
      <input class="cmdk-input" type="text" aria-label="Command, person, or date" placeholder="Type a command, person, or date (YYYY-MM-DD)…" spellcheck="false" autocomplete="off">
      <div class="cmdk-list"></div>
      <div class="cmdk-foot"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>Esc</kbd> close</div>
    </div>`;
  const input = modal.querySelector(".cmdk-input");
  const listEl = modal.querySelector(".cmdk-list");
  let filtered = all, sel = 0;

  function dateCmd(q) {
    const iso = q.match(/^\s*(\d{4}-\d{2}-\d{2})\s*$/);
    const us = q.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
    let ds = null;
    if (iso) ds = iso[1];
    else if (us) ds = us[3] + "-" + String(us[1]).padStart(2, "0") + "-" + String(us[2]).padStart(2, "0");
    if (!ds) return null;
    return { ico: "📅", label: "Jump to " + ds, hint: "Date", run: () => jumpToDate(ds) };
  }
  function refresh() {
    const q = input.value.trim().toLowerCase();
    const dc = dateCmd(input.value);
    let base = all;
    if (q) base = all.filter((c) => c.label.toLowerCase().includes(q));
    filtered = dc ? [dc].concat(base) : base;
    filtered = filtered.slice(0, 50);
    sel = 0; draw();
  }
  function draw() {
    listEl.innerHTML = "";
    if (!filtered.length) { listEl.appendChild(el("div", "cmdk-empty", "No matches")); return; }
    filtered.forEach((c, k) => {
      const row = el("div", "cmdk-row" + (k === sel ? " sel" : ""));
      row.innerHTML = '<span class="cmdk-ico">' + c.ico + '</span><span class="cmdk-label">' + esc(c.label) + '</span><span class="cmdk-hint">' + esc(c.hint) + '</span>';
      row.onmouseenter = () => { sel = k; highlight(); };
      row.onclick = () => choose(k);
      listEl.appendChild(row);
    });
  }
  function highlight() { listEl.querySelectorAll(".cmdk-row").forEach((r, k) => r.classList.toggle("sel", k === sel)); }
  function choose(k) { const c = filtered[k]; modal.remove(); if (c) c.run(); }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); highlight(); ensureVisible(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); highlight(); ensureVisible(); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered.length) choose(sel); }
  });
  function ensureVisible() { const r = listEl.querySelectorAll(".cmdk-row")[sel]; if (r) r.scrollIntoView({ block: "nearest" }); }

  modal.addEventListener("click", (e) => { if (e.target === modal) { modal.remove(); restoreFocus(); } });
  document.body.appendChild(modal);
  refresh();
  // applyDialog captures the opener (for focus restore) before focusing the input.
  applyDialog(modal, "Command palette", { initial: ".cmdk-input" });
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
  const samples = [];
  for (let i = 0; i < N && samples.length < 20; i++) {
    const z = zonedParts(MSGS[i].t);
    if (z.mo === tMonth && z.d === tDate && z.y !== tYear) {
      samples.push(i);
    }
  }
  if (samples.length === 0) return;
  const pick = samples[Math.floor(Math.random() * samples.length)];
  const m = MSGS[pick];
  const yr = zonedParts(m.t).y;
  const ago = tYear - yr;
  const snippet = (m.x || "").trim().slice(0, 60) || "[media]";
  const otdToast = el("div", "otd-toast");
  otdToast.innerHTML = `<div class="otd-header">📅 On This Day — ${ago} year${ago > 1 ? "s" : ""} ago</div>
    <div class="otd-body"><span class="otd-name" style="color:${colorOf(m.s)}">${esc(nameOf(m.s))}</span>: ${esc(snippet)}${snippet.length >= 60 ? "…" : ""}</div>
    <div class="otd-action">Tap to open Time Capsule</div>`;
  otdToast.onclick = () => { otdToast.remove(); setView("capsule"); };
  document.body.appendChild(otdToast);
  setTimeout(() => { otdToast.classList.add("otd-exit"); setTimeout(() => otdToast.remove(), 400); }, 7000);
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

  let filtered = threads;
  if (threadFilter !== "all") {
    filtered = threads.filter(t => {
      const yr = zonedParts(t.startT).y;
      return String(yr) === threadFilter;
    });
  }

  if (threadSort === "biggest") filtered.sort((a, b) => b.count - a.count);
  else if (threadSort === "longest") filtered.sort((a, b) => b.duration - a.duration);
  else if (threadSort === "newest") filtered.sort((a, b) => b.startT - a.startT);
  else if (threadSort === "oldest") filtered.sort((a, b) => a.startT - b.startT);
  else if (threadSort === "liveliest") filtered.sort((a, b) => b.people.length - a.people.length);

  const years = [...new Set(threads.map(t => zonedParts(t.startT).y))].sort((a, b) => b - a);
  const yearChips = ['<button class="pill thr-yr' + (threadFilter === "all" ? " active" : "") + '" data-yr="all">All</button>']
    .concat(years.map(y => '<button class="pill thr-yr' + (threadFilter === String(y) ? " active" : "") + '" data-yr="' + y + '">' + y + '</button>')).join("");

  const sortOpts = [
    ["biggest", "Most messages"], ["longest", "Longest duration"],
    ["newest", "Newest"], ["oldest", "Oldest"], ["liveliest", "Most people"]
  ].map(([val, label]) => `<option value="${val}"${threadSort === val ? " selected" : ""}>${label}</option>`).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
      <div class="page-title">🧵 Conversation Threads</div>
      <div class="page-sub">Activity bursts detected: ${fmtNum(threads.length)} threads with 8+ messages, separated by 1-hour gaps. Browse the conversations that brought the group alive.</div></div>
    <div class="page-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px;">
        <div class="thr-years">${yearChips}</div>
        <span class="spacer"></span>
        <label class="pill sortpill">↕ <select id="thr-sort">${sortOpts}</select></label>
      </div>
      <div class="thr-grid" id="thr-grid"></div>
      <div class="result-meta" style="margin-top:14px;">${fmtNum(filtered.length)} threads shown</div>
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
        <span class="thr-stat">⏱ ${durStr}</span>
        <span class="thr-stat">👥 ${t.people.length}</span>
      </div>
      <div class="thr-preview">${preview ? esc(preview) + (preview.length >= 80 ? "…" : "") : "<i>media thread</i>"}</div>
      <div class="thr-people">${avs}${extra}</div>`;
    card.onclick = () => jumpTo(t.startIdx);
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

  if (!battleP1 && PARTS.length >= 2) { battleP1 = PARTS[0].id; battleP2 = PARTS[1].id; }

  const pOpts = PARTS.map(p =>
    `<option value="${esc(p.id)}">${esc(nameOf(p.id))} (${fmtNum(p.count)})</option>`
  ).join("");

  v.innerHTML = `<div class="page"><div class="page-head">
    <div class="page-title">⚔ Word Battles</div>
    <div class="page-sub">Compare word usage head-to-head between two people. Who says "lmao" more? Who's the real "bruh" user?</div></div>
  <div class="page-body">
    <div class="battle-selectors">
      <div class="battle-picker">
        ${battleP1 ? pfpHtml(battleP1, "width:40px;height:40px;font-size:15px") : ""}
        <select id="battle-p1">${pOpts}</select>
      </div>
      <div class="battle-vs">VS</div>
      <div class="battle-picker">
        ${battleP2 ? pfpHtml(battleP2, "width:40px;height:40px;font-size:15px") : ""}
        <select id="battle-p2">${pOpts}</select>
      </div>
    </div>
    <div class="battle-custom" style="margin:16px 0;">
      <input type="text" id="battle-word" placeholder="Type a word to compare..." class="person-name-input" style="max-width:260px">
      <button class="btn" id="battle-go">Compare</button>
    </div>
    <div id="battle-results"></div>
  </div></div>`;

  const sel1 = v.querySelector("#battle-p1");
  const sel2 = v.querySelector("#battle-p2");
  sel1.value = battleP1;
  sel2.value = battleP2;
  sel1.onchange = () => { battleP1 = sel1.value; renderBattles(); };
  sel2.onchange = () => { battleP2 = sel2.value; renderBattles(); };

  v.querySelector("#battle-go").onclick = () => {
    const word = v.querySelector("#battle-word").value.trim();
    if (word) addBattleRow(word);
  };
  v.querySelector("#battle-word").onkeydown = (e) => {
    if (e.key === "Enter") { const w = e.target.value.trim(); if (w) addBattleRow(w); }
  };

  drawBattleResults();
}

function drawBattleResults() {
  const container = document.getElementById("battle-results");
  if (!container || !battleP1 || !battleP2) return;

  const counts1 = {}, counts2 = {};
  for (let i = 0; i < N; i++) {
    const m = MSGS[i];
    if (!m.x) continue;
    const toks = m.x.toLowerCase().split(/\s+/);
    if (m.s === battleP1) toks.forEach(t => { if (t.length >= 2) counts1[t] = (counts1[t] || 0) + 1; });
    if (m.s === battleP2) toks.forEach(t => { if (t.length >= 2) counts2[t] = (counts2[t] || 0) + 1; });
  }

  const battleWords = ["lol", "lmao", "bruh", "nah", "bro", "damn", "like", "yeah", "fuck", "man", "shit", "good", "love", "dead", "fire", "real", "nice", "wait", "facts", "honestly", "literally", "actually", "think", "know", "gonna"];

  let html = '<div class="battle-rows">';
  battleWords.forEach(word => {
    const c1 = counts1[word] || 0;
    const c2 = counts2[word] || 0;
    if (c1 === 0 && c2 === 0) return;
    const max = Math.max(c1, c2, 1);
    const w1 = (c1 / max * 100).toFixed(0);
    const w2 = (c2 / max * 100).toFixed(0);
    const winner = c1 > c2 ? "left" : c2 > c1 ? "right" : "tie";

    html += `<div class="battle-row">
      <div class="battle-count ${winner === 'left' ? 'battle-winner' : ''}">${fmtNum(c1)}</div>
      <div class="battle-bar-left"><div class="battle-fill-left" style="width:${w1}%"></div></div>
      <div class="battle-word">${esc(word)}</div>
      <div class="battle-bar-right"><div class="battle-fill-right" style="width:${w2}%"></div></div>
      <div class="battle-count ${winner === 'right' ? 'battle-winner' : ''}">${fmtNum(c2)}</div>
    </div>`;
  });
  html += '</div>';

  let wins1 = 0, wins2 = 0;
  battleWords.forEach(w => {
    const c1 = counts1[w] || 0, c2 = counts2[w] || 0;
    if (c1 > c2) wins1++;
    else if (c2 > c1) wins2++;
  });
  html += `<div class="battle-summary">
    <span style="color:${colorOf(battleP1)};font-weight:700">${esc(nameOf(battleP1))}: ${wins1} wins</span>
    <span style="color:var(--text-faint)">•</span>
    <span style="color:${colorOf(battleP2)};font-weight:700">${esc(nameOf(battleP2))}: ${wins2} wins</span>
  </div>`;

  container.innerHTML = html;
}

function addBattleRow(word) {
  const container = document.getElementById("battle-results");
  if (!container) return;
  const rows = container.querySelector(".battle-rows");
  if (!rows) return;

  let c1 = 0, c2 = 0;
  for (let i = 0; i < N; i++) {
    if (!MSGS[i].x) continue;
    const has = MSGS[i].x.toLowerCase().includes(word.toLowerCase());
    if (has && MSGS[i].s === battleP1) c1++;
    if (has && MSGS[i].s === battleP2) c2++;
  }

  const max = Math.max(c1, c2, 1);
  const w1 = (c1 / max * 100).toFixed(0);
  const w2 = (c2 / max * 100).toFixed(0);
  const winner = c1 > c2 ? "left" : c2 > c1 ? "right" : "tie";

  const row = el("div", "battle-row battle-added");
  row.innerHTML = `
    <div class="battle-count ${winner === 'left' ? 'battle-winner' : ''}">${fmtNum(c1)}</div>
    <div class="battle-bar-left"><div class="battle-fill-left" style="width:${w1}%"></div></div>
    <div class="battle-word">${esc(word)}</div>
    <div class="battle-bar-right"><div class="battle-fill-right" style="width:${w2}%"></div></div>
    <div class="battle-count ${winner === 'right' ? 'battle-winner' : ''}">${fmtNum(c2)}</div>`;
  rows.insertBefore(row, rows.firstChild);
  document.getElementById("battle-word").value = "";
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
    // Find next message by different person within 10 min
    while (j < N && (MSGS[j].s === a || MSGS[j].t - MSGS[j-1].t > 600000)) {
      if (MSGS[j].t - MSGS[j-1].t > 600000) { i = j; break; }
      j++;
    }
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
          <span>⏱ ${durStr}</span>
          <span>${esc(DT.format(c.startT))}</span>
        </div>
        <div class="chain-preview">${preview}</div>
      </div>
    </div>`;
  });

  v.innerHTML = `<div class="page"><div class="page-head">
    <div class="page-title">⛓ Reply Chains</div>
    <div class="page-sub">The longest back-and-forth exchanges in the chat. Found ${fmtNum(chains.length)} chains with 6+ volleys.</div></div>
  <div class="page-body"><div class="chain-list">${rows || '<div class="empty"><div class="big">⛓</div><div>No long reply chains found.</div></div>'}</div></div></div>`;

  v.querySelectorAll(".chain-card").forEach(card => {
    card.style.cursor = "pointer";
    card.onclick = () => jumpTo(parseInt(card.dataset.idx));
  });
}


/* ---- Boot (all module state is declared by now) -------------------------- */
activateConversation(pickInitialConvId(), false);
if (!N) {
  document.getElementById("boot").innerHTML = '<div class="boot-card"><div class="boot-title">No messages found</div><div class="boot-sub">Run <code>npm start</code> to set up your export (or <code>node scripts/build.js</code> / <code>node scripts/make_sample.js</code> for the demo)</div></div>';
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

})();
