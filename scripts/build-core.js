/*
 * build-core.js — the pure archive-assembly logic, with NO filesystem I/O.
 *
 * scripts/build.js handles all reading/writing (config, source files, media
 * folder, output data.js) and hands the parsed inputs to assembleConversations()
 * here. Keeping the transformation pure makes the most complex logic in the
 * project unit-testable without ever touching a real personal_data/ folder.
 *
 * See tests/build-core.test.js.
 */

// X_LINK (the Twitter/X link matcher) is shared with the viewer + wizard — one
// source, required here so the build and the app can't disagree. See src/shared-core.js.
const { X_LINK } = require("../src/shared-core.js");

const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VID = new Set(["mp4", "mov", "webm", "m4v"]);
const kindOf = (p) => {
  const e = String(p).split(".").pop().toLowerCase();
  return IMG.has(e) ? "img" : VID.has(e) ? "vid" : "file";
};

// NaN (not 0 = 1970) for a missing or unparseable time — the accumulator skips
// and counts those instead of storing a NaN/null timestamp (SP-21).
const toMs = (iso) => (iso ? Date.parse(iso) : NaN);

// a 1:1 DM id looks like "{userA}-{userB}"; a group id is a single numeric id
const isGroupId = (id) => !/^\d+-\d+$/.test(String(id));

/* ---- normalization ------------------------------------------------------- */
function rawToRec(mc) {
  const rec = { i: mc.id, s: mc.senderId, t: toMs(mc.createdAt), x: mc.text || "" };
  if (mc.urls && mc.urls.length) rec.u = mc.urls.map((u) => ({ s: u.url, e: u.expanded, d: u.display }));
  if (mc.reactions && mc.reactions.length) {
    rec.r = mc.reactions.map((r) => {
      const rr = { k: r.reactionKey, s: r.senderId };
      // Custom-emoji reactions (reactionKey "emoji") carry the actual glyph in a
      // separate field so it isn't lost to the generic REACT.emoji placeholder
      // (P2-1). ASSUMPTION: field name `emojiReaction` is taken from X's
      // documented export schema and has NOT been verified against a real
      // reaction object's keys (PROJECT HARD RULE forbids touching real
      // personal_data/exports) — flag for human verification. `r.emoji` is a
      // defensive fallback in case a differently-shaped export uses that name.
      if (r.reactionKey === "emoji") {
        const g = r.emojiReaction || r.emoji;
        if (g) rr.e = String(g);
      }
      return rr;
    });
  }
  return rec;
}
function toEvent(m) {
  if (m.conversationNameUpdate) { const e = m.conversationNameUpdate; return { t: toMs(e.createdAt), type: "name", s: e.initiatingUserId, name: e.name }; }
  if (m.participantsJoin) { const e = m.participantsJoin; return { t: toMs(e.createdAt), type: "join", s: e.initiatingUserId, ids: e.userIds || [] }; }
  if (m.participantsLeave) { const e = m.participantsLeave; return { t: toMs(e.createdAt), type: "leave", ids: e.userIds || [] }; }
  if (m.joinConversation) { const e = m.joinConversation; return { t: toMs(e.createdAt), type: "create", s: e.initiatingUserId }; }
  return null;
}
function eventKey(e) { return [e.type, e.t, e.name || "", (e.ids || []).join(","), e.s || ""].join("|"); }

/* ---- per-conversation accumulator ---------------------------------------- */
function makeConvo(id) {
  return { id, type: isGroupId(id) ? "group" : "dm", msgMap: new Map(), eventMap: new Map(), headerParts: new Set(), headerIds: new Set() };
}

/**
 * Incremental form of assembleConversations (SP-10): the streaming build folds
 * one message at a time as the scanner emits it, so no whole export array is
 * ever held. assembleConversations() below is the same thing for already-parsed
 * arrays (and what the unit tests drive).
 *
 * @param {object}   opts
 * @param {string[]} opts.ignoredUsers   user ids to drop from messages + roster.
 * @param {string[]} opts.ignoredGroups  conversation ids to drop entirely.
 */
function createAccumulator(opts) {
  opts = opts || {};
  const IGNORED = new Set((Array.isArray(opts.ignoredUsers) ? opts.ignoredUsers : []).map(String));
  // whole group chats the user removed in the wizard — excluded entirely (their
  // messages aren't assembled and their media is never referenced in the output)
  const IGNORED_GROUPS = new Set((Array.isArray(opts.ignoredGroups) ? opts.ignoredGroups : []).map(String));

  const convos = new Map();
  const getConvo = (id) => {
    let c = convos.get(id);
    if (!c) { c = makeConvo(id); convos.set(id, c); }
    return c;
  };
  let prevCount = 0;
  const warnings = { badTime: 0, missingBodies: 0 };

  // 1) baseline = previously built data (so history is never lost)
  function addPrev(prev) {
    if (!prev) return;
    const prevConvos = Array.isArray(prev.conversations)
      ? prev.conversations
      : (prev.conversationId ? [{ id: prev.conversationId, type: isGroupId(prev.conversationId) ? "group" : "dm", msgs: prev.msgs || [], events: prev.events || [] }] : []);
    prevConvos.forEach((pc) => {
      const c = getConvo(pc.id);
      if (pc.type) c.type = pc.type;
      (pc.msgs || []).forEach((m) => c.msgMap.set(m.i, m));
      (pc.events || []).forEach((e) => c.eventMap.set(eventKey(e), e));
      // SP-21: people known only from an earlier build's headers (lurkers,
      // joiners) stay on the roster even when the newer export has no headers.
      (pc.participants || []).forEach((id) => c.headerParts.add(id));
      prevCount += (pc.msgs || []).length;
    });
  }

  // 2) one entry of an export's messages[] (full message bodies)
  function addMessage(convId, m) {
    if (!m || typeof m !== "object") return;
    const c = getConvo(convId);
    if (m.messageCreate) {
      const r = rawToRec(m.messageCreate);
      if (!r.i) return;
      if (!Number.isFinite(r.t)) { warnings.badTime++; return; }   // SP-21: skip + warn
      c.msgMap.set(r.i, r);
    } else {
      const e = toEvent(m);
      if (!e) return;
      if (!Number.isFinite(e.t)) { warnings.badTime++; return; }
      c.eventMap.set(eventKey(e), e);
    }
  }

  // 2c) one entry of the group headers (metadata-only): no message bodies, so it
  // never adds messages — only completes the participant roster + join/leave/name events.
  function addHeader(convId, m) {
    if (!m || typeof m !== "object") return;
    const c = getConvo(convId);
    if (m.messageCreate) {
      const mc = m.messageCreate;
      if (mc.id) c.headerIds.add(String(mc.id));   // SP-2: to spot bodies missing from the messages file(s)
      if (mc.senderId) c.headerParts.add(mc.senderId);
      if (mc.recipientId) c.headerParts.add(mc.recipientId);
    } else {
      const e = toEvent(m);
      if (e && !Number.isFinite(e.t)) { warnings.badTime++; return; }
      if (e) {
        c.eventMap.set(eventKey(e), e);
        if (e.s) c.headerParts.add(e.s);
        (e.ids || []).forEach((id) => c.headerParts.add(id));
      }
    }
  }

  // 3) resolve local media + assemble final conversation index
  function finish(mediaIndex) {
    mediaIndex = mediaIndex || {};
    const conversations = [];
    let totalMsgs = 0, totalMedia = 0, groupsSeen = 0;
    for (const c of convos.values()) {
      if (c.type === "group" && c.msgMap.size) groupsSeen++;
      if (IGNORED_GROUPS.has(String(c.id))) continue;   // removed group chat — skip wholesale
      let withMedia = 0;
      const msgVals = [...c.msgMap.values()].filter((m) => !IGNORED.has(String(m.s)));
      for (const rec of msgVals) {
        // SP-20: a message can have several files; the first stays m/k (what
        // every view already reads), the rest go to mx: [{ m, k }, ...].
        const mp = mediaIndex[rec.i];
        const list = Array.isArray(mp) ? mp : (mp ? [mp] : []);
        if (list.length) {
          rec.m = list[0]; rec.k = kindOf(list[0]);
          if (list.length > 1) rec.mx = list.slice(1).map((p) => ({ m: p, k: kindOf(p) }));
          else delete rec.mx;
          withMedia++;
        } else if (rec.m) withMedia++;
      }
      const msgs = msgVals.sort((a, b) => a.t - b.t || (a.i < b.i ? -1 : 1));
      const events = [...c.eventMap.values()].sort((a, b) => a.t - b.t);
      if (!msgs.length || c.type !== "group") continue;   // group chats only; drop empty + 1:1 DMs
      for (const hid of c.headerIds) if (!c.msgMap.has(hid)) warnings.missingBodies++;

      const headerParts = [...(c.headerParts || [])].filter((id) => !IGNORED.has(String(id)));
      const participants = [...new Set([...msgs.map((m) => m.s), ...headerParts])];
      const nameEv = events.filter((e) => e.type === "name");
      const title = nameEv.length ? nameEv[nameEv.length - 1].name
        : (c.type === "group" ? "Group " + String(c.id).slice(-4) : null);

      conversations.push({ id: c.id, type: c.type, title, participants, count: msgs.length, msgs, events });
      totalMsgs += msgs.length;
      totalMedia += withMedia;
    }

    // biggest conversation first, so the UI opens on the most active chat
    conversations.sort((a, b) => b.count - a.count);

    return { conversations, totalMsgs, totalMedia, prevCount, groupsSeen, warnings };
  }

  return { addPrev, addMessage, addHeader, finish };
}

/**
 * Fold parsed inputs into the final conversation index.
 *
 * @param {object}   opts
 * @param {object|null} opts.prev        previously built CHAT_DATA (new multi-conv
 *                                       shape or legacy single-conv), or null.
 * @param {Array[]}  opts.exportDatas    parsed arrays from direct-messages-group.js files.
 * @param {Array[]}  opts.headerDatas    parsed arrays from -headers.js files (metadata only).
 * @param {object}   opts.mediaIndex     { messageId -> root-relative media path }.
 * @param {string[]} opts.ignoredUsers   user ids to drop from messages + roster.
 * @param {string[]} opts.ignoredGroups  conversation ids to drop entirely.
 * @returns {{conversations: object[], totalMsgs: number, totalMedia: number, prevCount: number, groupsSeen: number}}
 */
function assembleConversations(opts) {
  opts = opts || {};
  const acc = createAccumulator(opts);
  acc.addPrev(opts.prev || null);
  for (const data of (opts.exportDatas || [])) {
    (data || []).forEach((d) => {
      const conv = d && d.dmConversation; if (!conv || !conv.conversationId) return;
      (conv.messages || []).forEach((m) => acc.addMessage(conv.conversationId, m));
    });
  }
  for (const data of (opts.headerDatas || [])) {
    (data || []).forEach((d) => {
      const conv = d && d.dmConversation; if (!conv || !conv.conversationId) return;
      (conv.messages || []).forEach((m) => acc.addHeader(conv.conversationId, m));
    });
  }
  return acc.finish(opts.mediaIndex || {});
}

/**
 * SP-2: X splits a large data file into "<name>.js", "<name>-part1.js", ...
 * (the documented convention for tweets-partN.js; the exact DM spelling is
 * unconfirmed, so "-partN", "_partN" and ".partN", zero-padded or not, are
 * all accepted). Given a folder listing and the file the user picked, return
 * that file's whole family in part order — or just the file itself when its
 * name isn't one of the known export names (a renamed file has no family).
 */
const PART_FAMILIES = [
  /^(direct-messages-group)(?:[-_.]part(\d+))?\.js$/i,
  /^(direct-messages?-group-headers)(?:[-_.]part(\d+))?\.js$/i,
];
function exportPartFiles(names, chosen) {
  const fam = (n) => {
    for (let fi = 0; fi < PART_FAMILIES.length; fi++) {
      const m = PART_FAMILIES[fi].exec(String(n));
      if (m) return { fi, part: m[2] != null ? Number(m[2]) : 0 };
    }
    return null;
  };
  const want = fam(chosen);
  if (!want) return [chosen];
  const out = names.map((n) => ({ n: String(n), f: fam(n) })).filter((x) => x.f && x.f.fi === want.fi);
  if (!out.some((x) => x.n === chosen)) out.push({ n: chosen, f: want });
  return out.sort((a, b) => a.f.part - b.f.part || (a.n < b.n ? -1 : 1)).map((x) => x.n);
}

/**
 * Index a media folder's file names by message id. X names group-DM media
 * "<messageId>-<mediaId>.<ext>"; a message may own several files (SP-20), so
 * each id maps to ALL of its paths, sorted for a stable order.
 * @param {string[]} names   file names (no directories) in the media folder.
 * @param {string}   relDir  the folder's path as the app should load it.
 * @returns {Object<string, string[]>}
 */
function indexMediaFiles(names, relDir) {
  const idx = {};
  const prefix = relDir ? String(relDir).replace(/\/+$/, "") + "/" : "";
  for (const f of [...names].map(String).sort()) {
    const dash = f.indexOf("-");
    if (dash <= 0) continue;
    const id = f.slice(0, dash);
    (idx[id] || (idx[id] = [])).push(prefix + f);
  }
  return idx;
}

/**
 * Glue between createExportScanner and an accumulator for ONE file: routes each
 * streamed message to its conversation (holding any that arrive before their
 * conversationId) and counts what the file held, for the build's sanity checks.
 * @param {object} acc     createAccumulator() result.
 * @param {"messages"|"headers"} which
 */
function createExportSink(acc, which) {
  const add = which === "headers" ? acc.addHeader : acc.addMessage;
  const ids = [];
  const pending = new Map();
  const stats = { conversations: 0, groupConversations: 0, dmConversations: 0, messages: 0, withText: 0, events: 0, orphaned: 0 };
  function onConversationId(ci, id) {
    if (id == null || id === "") return;
    const cid = String(id);
    ids[ci] = cid;
    stats.conversations++;
    if (isGroupId(cid)) stats.groupConversations++; else stats.dmConversations++;
    const p = pending.get(ci);
    if (p) { pending.delete(ci); p.forEach((m) => add(cid, m)); }
  }
  function onMessage(ci, m) {
    if (m && m.messageCreate) {
      stats.messages++;
      if (Object.prototype.hasOwnProperty.call(m.messageCreate, "text")) stats.withText++;
    } else stats.events++;
    const cid = ids[ci];
    if (cid != null) add(cid, m);
    else { let p = pending.get(ci); if (!p) { p = []; pending.set(ci, p); } p.push(m); }
  }
  function finish() {
    for (const p of pending.values()) stats.orphaned += p.length;   // a conversation with no id
    pending.clear();
    return stats;
  }
  return { handlers: { onConversationId, onMessage }, stats, finish };
}

// What to tell the user when a file's window.YTD global says it's the wrong
// file for the slot it was picked for. `expected` is "messages" or "headers";
// returns null when the file is (or may be) the right kind.
function wrongKindMessage(info, expected, label) {
  const k = info && info.kind;
  const name = "\u201c" + label + "\u201d";
  if (!k || k === expected || k === "unknown") return null;
  if (k === "empty") return name + " is empty (0 bytes). Re-extract it from your Twitter/X archive and try again.";
  if (k === "dm") return name + " is your 1:1 direct messages file (direct-messages.js), not your group chats. Pick direct-messages-group.js instead.";
  if (k === "dm-headers") return name + " is the 1:1 direct message headers file (direct-message-headers.js), not a group chat file. Pick direct-messages-group.js and direct-message-group-headers.js.";
  if (k === "headers") return name + " is the group headers file (direct-message-group-headers.js), not the messages file. Pick direct-messages-group.js as the messages file.";
  if (k === "messages") return name + " is the group messages file (direct-messages-group.js), not the headers file. Pick direct-message-group-headers.js as the headers file.";
  return name + " is the \u201c" + info.global + "\u201d part of your archive (like account.js), not a group chat file. Pick " +
    (expected === "headers" ? "direct-message-group-headers.js." : "direct-messages-group.js.");
}

/* ---- wizard participant roster ------------------------------------------- */
// X_LINK is required from src/shared-core.js at the top of this file.

/**
 * Build the setup wizard's participant list from already-built CHAT_DATA:
 * per-person message count, a few link-free sample messages, and up to 6 shared
 * media items (memory jogs for naming). Pass a `groupId` to scope to a single
 * conversation; omit (or pass a falsy value) to merge everyone across all groups.
 *
 * @param {object} data        built CHAT_DATA ({ conversations: [...] }).
 * @param {string} [groupId]   conversation id to scope to; falsy = all groups.
 * @returns {Array<{id, count, samples: string[], media: Array}>}
 */
function collectParticipants(data, groupId) {
  const convs = (data && data.conversations) || [];
  const scoped = groupId != null && groupId !== "";
  const map = new Map();
  const entry = (id) => {
    let p = map.get(id);
    if (!p) { p = { id, count: 0, samples: [], _seen: new Set(), media: [] }; map.set(id, p); }
    return p;
  };
  for (const c of convs) {
    if (scoped && String(c.id) !== String(groupId)) continue;
    // SP-13: everyone on the roster gets a card, even with no messages (a
    // lurker, or someone known only from the headers file) — plus when they
    // joined / left, as a memory jog for naming them.
    for (const id of (c.participants || [])) entry(String(id));
    for (const e of (c.events || [])) {
      if (e.type !== "join" && e.type !== "leave") continue;
      for (const raw of (e.ids || [])) {
        const p = entry(String(raw));
        if (e.type === "join" && (p.joined == null || e.t < p.joined)) p.joined = e.t;
        if (e.type === "leave" && (p.left == null || e.t > p.left)) p.left = e.t;
      }
    }
    for (const m of (c.msgs || [])) {
      const p = entry(m.s);
      p.count++;
      const t = (m.x || "").trim();
      if (t.length > 14 && !/^https?:/.test(t) && !X_LINK.test(t) && p.samples.length < 40) {
        const k = t.toLowerCase();
        if (!p._seen.has(k)) { p._seen.add(k); p.samples.push(t); }
      }
      if (m.m && p.media.length < 6) p.media.push({ m: m.m, k: m.k || kindOf(m.m) });
      if (Array.isArray(m.mx)) for (const x of m.mx) { if (x && x.m && p.media.length < 6) p.media.push({ m: x.m, k: x.k || kindOf(x.m) }); }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .map((p) => {
      const out = { id: p.id, count: p.count, samples: p.samples.sort((a, b) => b.length - a.length).slice(0, 10), media: p.media };
      if (p.joined != null) out.joined = p.joined;
      if (p.left != null) out.left = p.left;
      return out;
    });
}

/* ---- export identification ------------------------------------------------ */
// Every X archive data file is a script assigning one global:
//   window.YTD.<global>.part<N> = [ ... ]
// The global names the file's content, so it tells a group messages file from
// its headers, the 1:1 DMs, account.js, etc. without trusting the filename.
// A UTF-8 BOM (some unzip tools / editors add one) is tolerated everywhere.
const YTD_HEAD = /^\uFEFF?\s*window\.YTD\.([A-Za-z0-9_]+)(?:\.part(\d+))?\s*=/;
const KIND_OF_GLOBAL = {
  direct_messages_group: "messages",
  direct_message_group_headers: "headers",
  direct_messages_group_headers: "headers",   // plural spelling some tools use
  direct_messages: "dm",
  direct_message_headers: "dm-headers",
  direct_messages_headers: "dm-headers",
};
/**
 * Identify an export file from its first few hundred characters.
 * @returns {{kind: "messages"|"headers"|"dm"|"dm-headers"|"other"|"unknown"|"empty", global: string|null, part: number|null}}
 *   "unknown" = no window.YTD prefix (maybe plain JSON); "empty" = nothing but whitespace/BOM.
 */
function identifyExport(head) {
  const s = String(head == null ? "" : head);
  if (/^\uFEFF?\s*$/.test(s)) return { kind: "empty", global: null, part: null };
  const m = YTD_HEAD.exec(s);
  if (!m) return { kind: "unknown", global: null, part: null };
  return { kind: KIND_OF_GLOBAL[m[1]] || "other", global: m[1], part: m[2] != null ? Number(m[2]) : null };
}

/* ---- streaming export scanner (SP-10) ------------------------------------- */
// A whole-file readFileSync + JSON.parse needs ~5-6x the export size in RAM and
// cannot read a file over V8's ~512 MB string limit at all (ERR_STRING_TOO_LONG).
// This scanner is fed the file as text chunks and only ever materialises ONE
// message at a time: it walks the fixed export shape
//   [ { "dmConversation": { "conversationId": "...", "messages": [ <msg>, ... ] } }, ... ]
// and JSON.parses each <msg> (and each conversationId) on its own. Everything
// else (unknown keys, odd values) is skipped without being kept. Memory is
// bounded by the largest single message, not the file or the conversation.
class ExportScanError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = "ExportScanError";
    this.code = "EXPORT_SCAN";
    this.pos = pos;
  }
}
const M_HEAD = 0, M_STRUCT = 1, M_VALUE = 2, M_KEY = 3, M_DONE = 4;
const S_VAL_OR_END = 0, S_VAL = 1, S_COMMA_OR_END = 2, S_KEY_OR_END = 3, S_KEY = 4, S_COLON = 5;
const V_STR = 0, V_CONT = 1, V_BARE = 2;
const HEAD_MAX = 4096;
const HEAD_OK = /^\uFEFF?\s*(?:window\.YTD\.([A-Za-z0-9_]+)(?:\.part(\d+))?\s*=\s*)?$/;

/**
 * The streaming engine behind both scanners: it navigates only the containers
 * `spec.child` asks for, JSON.parses only the values it asks to capture (one at
 * a time), and skips everything else without keeping it.
 *
 * spec.rootChar  "[" or "{": the top-level container after the optional prefix
 * spec.headOk    regex the text before rootChar must match
 * spec.headInfo(m)          what end() returns, from that match
 * spec.notThis   message for text that isn't this kind of file
 * spec.what      "…It may be damaged or not <what>"
 * spec.child(parentRole, key, charCode) -> { role, nav: "obj"|"arr"|null, cap: bool, bad?: string }
 * spec.onOpen(role) / spec.onClose(role) / spec.onValue(role, key, value)
 */
function createStreamScanner(spec) {
  const onOpen = spec.onOpen || (() => {});
  const onClose = spec.onClose || (() => {});
  const onValue = spec.onValue || (() => {});
  const STR_RE = /["\\]/g, CONT_RE = /["{}[\]]/g, BARE_END = /[,\]}\s]/g;

  let base = 0;                 // characters consumed before the current chunk
  let mode = M_HEAD, head = "";
  let info = null;
  const stack = [];             // navigated containers: { arr, role, st, key }
  // value mode (a captured or skipped value)
  let vKind = V_STR, vDepth = 0, vInStr = false, vEsc = false, vCap = false, vRole = null, vKey = null, vParts = null, vStart = 0, vPos = 0;
  // key mode
  let kParts = null, kStart = 0, kEsc = false;

  const at = (pos) => " (at character " + pos.toLocaleString("en-US") + ")";
  function fail(msg, pos) { throw new ExportScanError(msg + at(pos), pos); }
  function unreadable(why, pos) { fail("The file couldn't be read: " + why + ". It may be damaged or not " + spec.what, pos); }

  function close(i) {
    onClose(stack.pop().role);
    if (!stack.length) mode = M_DONE;
    return i + 1;
  }
  function startValue(s, i, parent, key) {
    const c = s.charCodeAt(i);
    parent.st = S_COMMA_OR_END;   // what the parent expects once this value is done
    const ch = spec.child(parent.role, key, c);
    if (ch.bad) unreadable(ch.bad, base + i);
    const role = ch.role;
    if (ch.nav === "obj" && c === 123) { stack.push({ arr: false, role, st: S_KEY_OR_END, key: null }); onOpen(role); return i + 1; }
    if (ch.nav === "arr" && c === 91) { stack.push({ arr: true, role, st: S_VAL_OR_END, key: null }); onOpen(role); return i + 1; }
    mode = M_VALUE;
    vCap = !!ch.cap;
    vRole = role; vKey = key; vParts = vCap ? [] : null; vStart = i; vPos = base + i; vEsc = false;
    if (c === 34) { vKind = V_STR; vInStr = true; return i + 1; }
    if (c === 123 || c === 91) { vKind = V_CONT; vDepth = 1; vInStr = false; return i + 1; }
    if (c === 125 || c === 93 || c === 44 || c === 58) unreadable("a value is missing", base + i);
    vKind = V_BARE;
    return i + 1;
  }
  function finishValue(s, end) {
    mode = M_STRUCT;
    if (!vCap) return end;
    vParts.push(s.slice(vStart, end));
    const txt = vParts.length === 1 ? vParts[0] : vParts.join("");
    vParts = null;
    let val;
    try { val = JSON.parse(txt); }
    catch (e) { unreadable("a message is malformed", vPos); }
    onValue(vRole, vKey, val);
    return end;
  }
  function struct(s, i) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) return i + 1;
    const f = stack[stack.length - 1];
    if (f.arr) {
      if (f.st === S_COMMA_OR_END) {
        if (c === 44) { f.st = S_VAL; return i + 1; }
        if (c === 93) return close(i);
        return unreadable("expected \",\" or \"]\"", base + i);
      }
      if (c === 93 && f.st === S_VAL_OR_END) return close(i);
      return startValue(s, i, f, null);
    }
    switch (f.st) {
      case S_KEY_OR_END:
        if (c === 125) return close(i);
      // falls through
      case S_KEY:
        if (c === 34) { mode = M_KEY; kParts = []; kStart = i + 1; kEsc = false; return i + 1; }
        return unreadable("expected a field name", base + i);
      case S_COLON:
        if (c === 58) { f.st = S_VAL; return i + 1; }
        return unreadable("expected \":\"", base + i);
      case S_VAL:
        return startValue(s, i, f, f.key);
      default:   // S_COMMA_OR_END
        if (c === 44) { f.st = S_KEY; return i + 1; }
        if (c === 125) return close(i);
        return unreadable("expected \",\" or \"}\"", base + i);
    }
  }
  function value(s, i) {
    const n = s.length;
    if (vKind === V_BARE) {
      BARE_END.lastIndex = i;
      const m = BARE_END.exec(s);
      if (m) return finishValue(s, m.index);   // the terminator belongs to the parent
      return n;   // continues in the next chunk (push() saves the captured tail)
    }
    while (i < n) {
      if (vInStr) {
        if (vEsc) { vEsc = false; i++; continue; }
        STR_RE.lastIndex = i;
        const m = STR_RE.exec(s);
        if (!m) break;
        if (s.charCodeAt(m.index) === 92) {
          if (m.index + 1 < n) i = m.index + 2; else { vEsc = true; break; }
          continue;
        }
        vInStr = false; i = m.index + 1;
        if (vKind === V_STR) return finishValue(s, i);
        continue;
      }
      CONT_RE.lastIndex = i;
      const m = CONT_RE.exec(s);
      if (!m) break;
      const c = s.charCodeAt(m.index);
      i = m.index + 1;
      if (c === 34) vInStr = true;
      else if (c === 123 || c === 91) vDepth++;
      else if (--vDepth === 0) return finishValue(s, i);
    }
    return n;
  }
  function key(s, i) {
    const n = s.length;
    while (i < n) {
      if (kEsc) { kEsc = false; i++; continue; }
      STR_RE.lastIndex = i;
      const m = STR_RE.exec(s);
      if (!m) break;
      if (s.charCodeAt(m.index) === 92) {
        if (m.index + 1 < n) i = m.index + 2; else { kEsc = true; break; }
        continue;
      }
      kParts.push(s.slice(kStart, m.index));
      const raw = kParts.join("");
      kParts = null;
      let k = raw;
      if (raw.indexOf("\\") !== -1) { try { k = JSON.parse("\"" + raw + "\""); } catch (e) { unreadable("a field name is malformed", base + m.index); } }
      const f = stack[stack.length - 1];
      f.key = k; f.st = S_COLON; mode = M_STRUCT;
      return m.index + 1;
    }
    return n;
  }
  function done(s, i) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9 || c === 59) return i + 1;
    return fail("There is unexpected content after the end of the export data", base + i);
  }

  function push(chunk) {
    const s = String(chunk);
    let i = 0;
    const n = s.length;
    if (mode === M_HEAD) {
      const b = s.indexOf(spec.rootChar);
      if (b === -1) {
        head += s;
        // a real prefix is a few dozen characters; don't buffer a huge non-export
        if (head.length > HEAD_MAX) fail(spec.notThis, 0);
        base += n;
        return;
      }
      head += s.slice(0, b);
      const m = spec.headOk.exec(head);
      if (!m) fail(spec.notThis, 0);
      info = spec.headInfo(m);
      head = "";
      const arr = spec.rootChar === "[";
      stack.push({ arr, role: "root", st: arr ? S_VAL_OR_END : S_KEY_OR_END, key: null });
      mode = M_STRUCT;
      i = b + 1;
    }
    while (i < n) {
      if (mode === M_STRUCT) i = struct(s, i);
      else if (mode === M_VALUE) i = value(s, i);
      else if (mode === M_KEY) i = key(s, i);
      else i = done(s, i);
    }
    // A value or key still open at the chunk's end continues in the next one:
    // keep its text so far, and restart its slice at 0 in the next chunk.
    if (mode === M_VALUE) { if (vCap && vStart < n) vParts.push(s.slice(vStart)); vStart = 0; }
    else if (mode === M_KEY) { if (kStart < n) kParts.push(s.slice(kStart)); kStart = 0; }
    base += n;
  }
  function end() {
    if (mode === M_HEAD) {
      if (/^\uFEFF?\s*$/.test(head)) fail("The file is empty", 0);
      fail(spec.notThis, 0);
    }
    if (mode !== M_DONE) fail("The file ends early — it looks truncated or incompletely copied", base);
    return info;
  }
  return { push, end };
}
/**
 * An X export: [ { "dmConversation": { "conversationId": …, "messages": [ <msg>, … ] } }, … ]
 * @param {{onConversationId?: (convIndex:number, id:any)=>void, onMessage?: (convIndex:number, msg:any)=>void}} handlers
 * @returns {{push(text:string):void, end():{global:string|null, part:number|null}}}
 */
function createExportScanner(handlers) {
  handlers = handlers || {};
  const onConvId = handlers.onConversationId || (() => {});
  const onMsg = handlers.onMessage || (() => {});
  let convIndex = -1;
  return createStreamScanner({
    rootChar: "[",
    headOk: HEAD_OK,
    headInfo: (m) => ({ global: m[1] || null, part: m[2] != null ? Number(m[2]) : null }),
    notThis: "This file isn't a Twitter/X export data file",
    what: "a Twitter/X export",
    child(pr, key) {
      if (pr === "root") { convIndex++; return { role: "conv", nav: "obj" }; }
      if (pr === "conv" && key === "dmConversation") return { role: "dmc", nav: "obj" };
      if (pr === "dmc" && key === "messages") return { role: "msgs", nav: "arr" };
      if (pr === "dmc" && key === "conversationId") return { role: "convId", cap: true };
      if (pr === "msgs") return { role: "msg", cap: true };
      return { role: null };
    },
    onValue(role, key, val) {
      if (role === "msg") onMsg(convIndex, val);
      else onConvId(convIndex, val);
    },
  });
}

/* ---- previous-archive scanner (fix round 1) ------------------------------- */
// data.js is written by archiveChunks, so its shape is known:
//   window.CHAT_DATA = { <meta…>, "conversations": [ { id, type, …, "msgs": [ <msg>, … ], "events": […] }, … ] };
// It is the accumulated history and can outgrow V8's ~512 MB string limit, so
// it is streamed like an export: each message is parsed on its own, each other
// conversation field as one value, and onConversation gets one conversation at
// a time. Root keys other than "conversations" (generatedAt, ignoredUsers, …,
// or an old single-conversation archive's conversationId/msgs/events) are
// returned as `meta` by end().
const ARCHIVE_HEAD_OK = /^\uFEFF?\s*(?:window\.CHAT_DATA\s*=\s*)?$/;
/**
 * @param {{onConversation?: (conv:object)=>void}} handlers
 * @returns {{push(text:string):void, end():{meta:object, conversations:number}}}
 */
function createArchiveScanner(handlers) {
  handlers = handlers || {};
  const onConv = handlers.onConversation || (() => {});
  const meta = {};
  let conv = null, count = 0, sawList = false;
  const sc = createStreamScanner({
    rootChar: "{",
    headOk: ARCHIVE_HEAD_OK,
    headInfo: () => ({}),
    notThis: "This file isn't a Group Chat Archive data.js",
    what: "a Group Chat Archive data.js",
    child(pr, key, c) {
      if (pr === "root") {
        if (key !== "conversations") return { role: "meta", cap: true };
        return c === 91 ? { role: "convs", nav: "arr" } : { bad: "\"conversations\" isn't a list" };
      }
      if (pr === "convs") return c === 123 ? { role: "conv", nav: "obj" } : { bad: "a conversation isn't an object" };
      if (pr === "conv") {
        if (key !== "msgs") return { role: "field", cap: true };
        return c === 91 ? { role: "msgs", nav: "arr" } : { bad: "a conversation's messages aren't a list" };
      }
      if (pr === "msgs") return c === 123 ? { role: "msg", cap: true } : { bad: "a message isn't an object" };
      return { role: null };
    },
    onOpen(role) {
      if (role === "convs") sawList = true;
      else if (role === "conv") conv = { msgs: [] };
    },
    onClose(role) {
      if (role !== "conv") return;
      const c = conv;
      conv = null;
      count++;
      onConv(c);
    },
    onValue(role, key, val) {
      if (role === "msg") conv.msgs.push(val);
      else if (role === "field") conv[key] = val;
      else if (role === "meta") meta[key] = val;
    },
  });
  return {
    push: sc.push,
    end() {
      sc.end();
      if (!sawList && meta.conversationId == null) throw new ExportScanError("The file has no conversations list", 0);
      return { meta, conversations: count };
    },
  };
}

// The plain sentence for a previous data.js that couldn't be read, by cause —
// or null when the error isn't one of these (the caller reports it as
// unexpected). Only real damage is called damaged, and deleting is never
// suggested without a backup copy first: this file IS the history (messages
// that may no longer be in any export).
function prevArchiveProblem(e) {
  const where = "Your existing archive (personal_data/data.js)";
  const code = e && e.code;
  if (e instanceof ExportScanError) {
    return where + " couldn't be read — it looks damaged (" + String(e.message).replace(/\.$/, "") + "), perhaps by a crash or a full disk. " +
      "The build stopped so the history in it isn't silently replaced. First make a backup copy of data.js. Then restore an older copy of it, " +
      "or delete it (or use Start over) to rebuild from this export only.";
  }
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return where + " couldn't be opened: another program is holding it, or access was denied (antivirus, OneDrive, an editor?). " +
      "Close that program, or move the archive out of a protected folder, and try again. Nothing was changed.";
  }
  if (code === "EISDIR") return where + " is a folder, not a file. Move it aside and try again. Nothing was changed.";
  if (code === "ERR_STRING_TOO_LONG") return where + " has a single entry too large to read. Nothing was changed; please report this.";
  if (e instanceof RangeError && /memory|allocation/i.test(e.message || "")) {
    return where + " is too large for the memory available to the build. Close other programs and try again. Nothing was changed.";
  }
  return null;
}

/* ---- archive writer (SP-10) ----------------------------------------------- */
// Yields the built data.js text piece by piece — byte-identical to
//   "window.CHAT_DATA = " + JSON.stringify({ ...meta, conversations }) + ";\n"
// but without ever holding the whole (possibly 100s of MB) string at once:
// each conversation's msgs are stringified `batch` messages at a time.
function* archiveChunks(meta, conversations, batch) {
  const B = Math.max(1, batch || 2000);
  const J = JSON.stringify;
  let headTxt = J(Object.assign({}, meta, { conversations: [] }));
  headTxt = headTxt.slice(0, headTxt.length - "[]}".length);   // `{..."conversations":`
  yield "window.CHAT_DATA = " + headTxt + "[";
  for (let ci = 0; ci < conversations.length; ci++) {
    const c = conversations[ci];
    let out = (ci ? "," : "") + "{";
    let first = true;
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (v === undefined || typeof v === "function") continue;
      out += (first ? "" : ",") + J(k) + ":";
      first = false;
      if (k === "msgs" && Array.isArray(v)) {
        yield out + "[";
        for (let j = 0; j < v.length; j += B) yield (j ? "," : "") + v.slice(j, j + B).map((m) => J(m)).join(",");
        out = "]";
      } else {
        out += J(v);
      }
    }
    yield out + "}";
  }
  yield "]};\n";
}

module.exports = {
  assembleConversations, createAccumulator, createExportSink, wrongKindMessage, indexMediaFiles, exportPartFiles, collectParticipants, rawToRec, toEvent, eventKey, isGroupId, kindOf,
  identifyExport, createExportScanner, createArchiveScanner, prevArchiveProblem, ExportScanError, archiveChunks,
};
