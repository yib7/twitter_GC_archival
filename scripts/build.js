/*
 * build.js — builds/updates data.js by MERGING all available exports.
 *
 * Multi-conversation: parses BOTH Twitter/X export files —
 *   - direct-messages.js        (1:1 DM conversations, full content)
 *   - direct-messages-group.js  (group DM conversations, full content)
 * — and emits an index of EVERY conversation it finds, instead of a single
 * hard-coded one. The `-headers` files (direct-message-headers.js /
 * direct-message-group-headers.js) are metadata-only and redundant when the
 * full files are present, so they are ignored.
 *
 *  - Preserves previously-built history (reads the existing data.js as a baseline).
 *  - Reads exports in the project root PLUS any dropped into ./exports/.
 *  - Dedupes messages by id, re-sorts chronologically, and resolves local media
 *    from ./direct_messages_media/ and ./direct_messages_group_media/
 *    (and any media folder under ./exports/).
 *
 * Run it any time you add a new export:   node build.js
 */

const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const OUT = path.join(here, "data.js");
const log = (...a) => console.log(...a);
const toMs = (iso) => (iso ? Date.parse(iso) : 0);

const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VID = new Set(["mp4", "mov", "webm", "m4v"]);
const kindOf = (p) => { const e = p.split(".").pop().toLowerCase(); return IMG.has(e) ? "img" : VID.has(e) ? "vid" : "file"; };

// a 1:1 DM id looks like "{userA}-{userB}"; a group id is a single numeric id
const isGroupId = (id) => !/^\d+-\d+$/.test(String(id));

/* ---- file discovery ------------------------------------------------------ */
function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, cb); else cb(full);
  }
}
// match direct-messages-group.js (+ dated copies) only — this build is
// group-chats only; the 1:1 direct-messages.js and *-headers.js are ignored.
const isExportFile = (name) =>
  /^direct-messages-group(-.*)?\.js$/i.test(name) && !/headers/i.test(name);

function findExports() {
  const out = [];
  for (const f of fs.readdirSync(here)) if (isExportFile(f)) out.push(path.join(here, f));
  const exDir = path.join(here, "exports");
  if (fs.existsSync(exDir)) walk(exDir, (f) => { if (isExportFile(path.basename(f))) out.push(f); });
  return out;
}
function findMediaDirs() {
  const dirs = [];
  const main = path.join(here, "direct_messages_group_media");
  if (fs.existsSync(main)) dirs.push(main);
  const exDir = path.join(here, "exports");
  if (fs.existsSync(exDir)) {
    (function walkDirs(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const full = path.join(dir, e.name);
          if (e.name === "direct_messages_group_media") dirs.push(full);
          walkDirs(full);
        }
      }
    })(exDir);
  }
  return dirs;
}
function buildMediaIndex(dirs) {
  const idx = {}, files = {};   // idx: messageId->path (official) ; files: basename->path (scraped)
  for (const d of dirs) {
    const rel = path.relative(here, d).split(path.sep).join("/");
    for (const f of fs.readdirSync(d)) {
      if (!files[f]) files[f] = rel + "/" + f;
      const dash = f.indexOf("-");
      if (dash <= 0) continue;
      const id = f.slice(0, dash);
      if (!idx[id]) idx[id] = rel + "/" + f;
    }
  }
  return { idx, files };
}

// live XChat scrapes (exports/gc-scrape-*.json) + optional sender map
function findScrapes() {
  const out = [];
  const exDir = path.join(here, "exports");
  if (fs.existsSync(exDir)) walk(exDir, (f) => { if (/\.json$/i.test(f) && /scrape/i.test(path.basename(f))) out.push(f); });
  return out;
}
function loadSenderMap() {
  const f = path.join(here, "exports", "sender-map.json");
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return {}; }
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
  } catch (e) { log("(existing data.js unreadable — rebuilding from exports only)"); return null; }
}

/* ---- per-conversation accumulator ---------------------------------------- */
const convos = new Map();  // convId -> { id, type, msgMap, eventMap }
function getConvo(id) {
  let c = convos.get(id);
  if (!c) { c = { id, type: isGroupId(id) ? "group" : "dm", msgMap: new Map(), eventMap: new Map() }; convos.set(id, c); }
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

// media index (shared by official + scraped resolution)
const mediaDirs = findMediaDirs();
log("Media folders:", mediaDirs.map((d) => path.relative(here, d)).join(", ") || "(none)");
const { idx: mediaIdx, files: mediaFiles } = buildMediaIndex(mediaDirs);

// 2b) merge live XChat scrapes — these belong to the largest group conversation
const senderMap = loadSenderMap();
const scrapeFiles = findScrapes();
if (scrapeFiles.length) {
  log("Scrape files:", scrapeFiles.length, scrapeFiles.map((f) => path.relative(here, f)).join(", "));
  // pick the biggest group conversation as the scrape target
  let target = null, best = -1;
  for (const c of convos.values()) if (c.type === "group" && c.msgMap.size > best) { best = c.msgMap.size; target = c; }
  let scrapedNew = 0;
  for (const file of scrapeFiles) {
    let payload; try { payload = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { log("  ! scrape parse error:", path.relative(here, file)); continue; }
    const c = target || getConvo(payload.conversationId || "scraped");
    for (const r of (payload.records || [])) {
      if (!r.id || (!r.text && !r.mediaFile)) continue;
      let s = r.senderId || "x:unknown";
      if (senderMap[s]) s = senderMap[s];
      const t = r.createdAt ? Date.parse(r.createdAt) : (r.capturedAt || 0);
      const rec = { i: r.id, s, t, x: r.text || "", src: "xchat" };
      if (r.mediaFile && mediaFiles[r.mediaFile]) { rec.m = mediaFiles[r.mediaFile]; rec.k = kindOf(r.mediaFile); }
      if (!c.msgMap.has(r.id)) scrapedNew++;
      c.msgMap.set(r.id, rec);
    }
  }
  log("Scraped messages merged:", scrapedNew, "new.");
}

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

  const participants = [...new Set(msgs.map((m) => m.s))];
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
