/*
 * build.js — builds personal_data/data.js from the setup wizard's config.
 *
 * Wizard-driven only: it reads personal_data/config.json (written by setup.html
 * / scripts/server.js) for the exact source file(s) + media folder, parses the
 * group export (direct-messages-group.js), folds EVERY group dmConversation into
 * a per-conversation index, and writes personal_data/data.js.
 *
 *  - When config.headersJs is set, the group `-headers` file
 *    (direct-messages-group-headers.js) is folded in too: it has no message
 *    bodies, so it never adds empty messages, but it completes the participant
 *    roster (people who never sent a surviving message) plus join/leave/name events.
 *  - Merge-aware: reads the previous data.js as a baseline, so re-running the
 *    wizard with a newer export accumulates history instead of losing it.
 *  - Dedupes messages by id, re-sorts chronologically, resolves local media by
 *    the {messageId}-… filename convention. Group chats only — 1:1 DMs are skipped.
 *
 * Not meant to be run by hand — use the setup wizard (setup.html).
 */

const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const PERSONAL = path.join(here, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");

// The build is driven entirely by personal_data/config.json (written by the
// setup wizard). No config → nothing to build; point the user at the wizard.
function loadConfig() {
  if (!fs.existsSync(CONFIG)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); }
  catch (e) { return null; }
}
const config = loadConfig();
if (!config) {
  console.error("No personal_data/config.json found — run the setup wizard first:");
  console.error("  node scripts/server.js   then open   http://localhost:8765/setup.html");
  process.exit(1);
}
const OUT = path.join(PERSONAL, "data.js");
const resolveHere = (p) => (path.isAbsolute(p) ? p : path.join(here, p));
const log = (...a) => console.log(...a);
const toMs = (iso) => (iso ? Date.parse(iso) : 0);

const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VID = new Set(["mp4", "mov", "webm", "m4v"]);
const kindOf = (p) => { const e = p.split(".").pop().toLowerCase(); return IMG.has(e) ? "img" : VID.has(e) ? "vid" : "file"; };

// a 1:1 DM id looks like "{userA}-{userB}"; a group id is a single numeric id
const isGroupId = (id) => !/^\d+-\d+$/.test(String(id));

/* ---- config-driven sources ----------------------------------------------- */
function findExports() {
  // exactly the source file(s) the wizard pointed us at
  return (Array.isArray(config.sourceJs) ? config.sourceJs : [])
    .map(resolveHere).filter((f) => fs.existsSync(f));
}
function findMediaDirs() {
  // the wizard copies media into personal_data/media/ and stores that path.
  // Media paths are emitted relative to the project root, so the app (served
  // from the root) resolves them regardless of where data.js lives.
  if (!config.mediaDir) return [];
  const d = resolveHere(config.mediaDir);
  return fs.existsSync(d) ? [d] : [];
}
function buildMediaIndex(dirs) {
  const idx = {};   // messageId -> root-relative path
  for (const d of dirs) {
    const rel = path.relative(here, d).split(path.sep).join("/");
    for (const f of fs.readdirSync(d)) {
      const dash = f.indexOf("-");
      if (dash <= 0) continue;
      const id = f.slice(0, dash);
      if (!idx[id]) idx[id] = rel + "/" + f;
    }
  }
  return idx;
}

/* ---- normalization ------------------------------------------------------- */
function rawToRec(mc) {
  const rec = { i: mc.id, s: mc.senderId, t: toMs(mc.createdAt), x: mc.text || "" };
  if (mc.urls && mc.urls.length) rec.u = mc.urls.map((u) => ({ s: u.url, e: u.expanded, d: u.display }));
  if (mc.reactions && mc.reactions.length) rec.r = mc.reactions.map((r) => ({ k: r.reactionKey, s: r.senderId }));
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

function loadPrev() {
  if (!fs.existsSync(OUT)) return null;
  try {
    const s = fs.readFileSync(OUT, "utf8").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
    return JSON.parse(s);
  } catch (e) { log("(existing data.js unreadable — rebuilding from source only)"); return null; }
}

/* ---- per-conversation accumulator ---------------------------------------- */
const convos = new Map();  // convId -> { id, type, msgMap, eventMap }
function getConvo(id) {
  let c = convos.get(id);
  if (!c) { c = { id, type: isGroupId(id) ? "group" : "dm", msgMap: new Map(), eventMap: new Map(), headerParts: new Set() }; convos.set(id, c); }
  return c;
}

/* ========================================================================= */
log("Building archive (merge mode, multi-conversation)…");

let prevCount = 0;

// 1) baseline = previously built data.js (so history is never lost)
const prev = loadPrev();
if (prev) {
  // support both the new multi-conversation shape and the legacy single-conv shape
  const prevConvos = Array.isArray(prev.conversations)
    ? prev.conversations
    : (prev.conversationId ? [{ id: prev.conversationId, type: isGroupId(prev.conversationId) ? "group" : "dm", msgs: prev.msgs || [], events: prev.events || [] }] : []);
  prevConvos.forEach((pc) => {
    const c = getConvo(pc.id);
    if (pc.type) c.type = pc.type;
    (pc.msgs || []).forEach((m) => c.msgMap.set(m.i, m));
    (pc.events || []).forEach((e) => c.eventMap.set(eventKey(e), e));
    prevCount += (pc.msgs || []).length;
  });
  log("Baseline from data.js:", prevCount, "messages across", prevConvos.length, "conversation(s).");
}

// 2) parse every export and fold EVERY conversation in
const exportFiles = findExports();
log("Export files found:", exportFiles.length, exportFiles.map((f) => path.relative(here, f)).join(", ") || "(none)");
for (const file of exportFiles) {
  let data;
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^window\.YTD\.[^=]*=\s*/, "").replace(/;\s*$/, "");
    data = JSON.parse(raw);
  } catch (e) { log("  ! parse error, skipped:", path.relative(here, file)); continue; }
  data.forEach((d) => {
    const conv = d.dmConversation; if (!conv || !conv.conversationId) return;
    const c = getConvo(conv.conversationId);
    (conv.messages || []).forEach((m) => {
      if (m.messageCreate) { const r = rawToRec(m.messageCreate); if (r.i) c.msgMap.set(r.i, r); }
      else { const e = toEvent(m); if (e) c.eventMap.set(eventKey(e), e); }
    });
  });
}

// 2c) fold the group headers file (metadata-only). It has no message bodies, so
// it never contributes messages — it only completes the participant roster
// (people who never sent a surviving message) and any join/leave/name events.
function findHeaders() {
  if (config && config.headersJs) {
    const f = resolveHere(config.headersJs);
    return fs.existsSync(f) ? [f] : [];
  }
  return [];
}
const headerFiles = findHeaders();
log("Header files found:", headerFiles.length, headerFiles.map((f) => path.relative(here, f)).join(", ") || "(none)");
for (const file of headerFiles) {
  let data;
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^window\.YTD\.[^=]*=\s*/, "").replace(/;\s*$/, "");
    data = JSON.parse(raw);
  } catch (e) { log("  ! headers parse error, skipped:", path.relative(here, file)); continue; }
  data.forEach((d) => {
    const conv = d.dmConversation; if (!conv || !conv.conversationId) return;
    const c = getConvo(conv.conversationId);
    (conv.messages || []).forEach((m) => {
      if (m.messageCreate) {
        const mc = m.messageCreate;
        if (mc.senderId) c.headerParts.add(mc.senderId);
        if (mc.recipientId) c.headerParts.add(mc.recipientId);
      } else {
        const e = toEvent(m);
        if (e) {
          c.eventMap.set(eventKey(e), e);
          if (e.s) c.headerParts.add(e.s);
          (e.ids || []).forEach((id) => c.headerParts.add(id));
        }
      }
    });
  });
}

// media index
const mediaDirs = findMediaDirs();
log("Media folders:", mediaDirs.map((d) => path.relative(here, d)).join(", ") || "(none)");
const mediaIdx = buildMediaIndex(mediaDirs);

// 3) resolve local media + assemble final conversation index
const conversations = [];
let totalMsgs = 0, totalMedia = 0;
for (const c of convos.values()) {
  let withMedia = 0;
  for (const rec of c.msgMap.values()) {
    const mp = mediaIdx[rec.i];
    if (mp) { rec.m = mp; rec.k = kindOf(mp); withMedia++; }
    else if (rec.m) withMedia++;
  }
  const msgs = [...c.msgMap.values()].sort((a, b) => a.t - b.t || (a.i < b.i ? -1 : 1));
  const events = [...c.eventMap.values()].sort((a, b) => a.t - b.t);
  if (!msgs.length || c.type !== "group") continue;   // group chats only; drop empty + 1:1 DMs

  const participants = [...new Set([...msgs.map((m) => m.s), ...(c.headerParts || [])])];
  const nameEv = events.filter((e) => e.type === "name");
  const title = nameEv.length ? nameEv[nameEv.length - 1].name
    : (c.type === "group" ? "Group " + String(c.id).slice(-4) : null);

  conversations.push({ id: c.id, type: c.type, title, participants, count: msgs.length, msgs, events });
  totalMsgs += msgs.length;
  totalMedia += withMedia;
}

// biggest conversation first, so the UI opens on the most active chat
conversations.sort((a, b) => b.count - a.count);

// 4) write
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, "window.CHAT_DATA = " + JSON.stringify({ generatedAt: new Date().toISOString(), conversations }) + ";\n");

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
log("---");
log("Group conversations:", conversations.length);
log("Total messages:", totalMsgs, prev ? "(" + (totalMsgs - prevCount >= 0 ? "+" : "") + (totalMsgs - prevCount) + " since last build)" : "");
log("With media:", totalMedia);
conversations.slice(0, 12).forEach((c) =>
  log("  ·", String(c.id).slice(-8).padStart(8), fmtN(c.count).padStart(8), c.title || "(group)"));
log("Wrote data.js (" + mb + " MB). Open index.html to view.");
function fmtN(n) { return n.toLocaleString("en-US"); }
