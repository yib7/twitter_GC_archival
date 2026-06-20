/*
 * build.js — builds personal_data/data.js from the setup wizard's config.
 *
 * Wizard-driven only: it reads personal_data/config.json (written by setup.html
 * / scripts/server.js) for the exact source file(s) + media folder, parses the
 * group export (direct-messages-group.js), folds EVERY group dmConversation into
 * a per-conversation index, and writes personal_data/data.js.
 *
 *  - When config.headersJs is set, the group `-headers` file
 *    (direct-message-group-headers.js) is folded in too: it has no message
 *    bodies, so it never adds empty messages, but it completes the participant
 *    roster (people who never sent a surviving message) plus join/leave/name events.
 *  - Merge-aware: reads the previous data.js as a baseline, so re-running the
 *    wizard with a newer export accumulates history instead of losing it.
 *  - Dedupes messages by id, re-sorts chronologically, resolves local media by
 *    the {messageId}-… filename convention. Group chats only — 1:1 DMs are skipped.
 *
 * All transformation lives in build-core.js (pure, unit-tested); this file is the
 * filesystem shell around it. Set GCA_PERSONAL to point at a different
 * personal_data/ folder (used by tests to avoid touching real data).
 *
 * Not meant to be run by hand — use the setup wizard (setup.html).
 */

const fs = require("fs");
const path = require("path");
const { assembleConversations } = require("./build-core.js");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const PERSONAL = process.env.GCA_PERSONAL ? path.resolve(process.env.GCA_PERSONAL) : path.join(here, "personal_data");
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
const ignoredUsers = (Array.isArray(config.ignoredUsers) ? config.ignoredUsers : []).map(String);
const ignoredGroups = (Array.isArray(config.ignoredGroups) ? config.ignoredGroups : []).map(String);

/* ---- config-driven sources ----------------------------------------------- */
function findExports() {
  // exactly the source file(s) the wizard pointed us at
  return (Array.isArray(config.sourceJs) ? config.sourceJs : [])
    .map(resolveHere).filter((f) => fs.existsSync(f));
}
function findHeaders() {
  if (config.headersJs) {
    const f = resolveHere(config.headersJs);
    return fs.existsSync(f) ? [f] : [];
  }
  return [];
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

// parse a YTD export file (window.YTD.<part> = [...]) into its JSON array
function parseExport(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^window\.YTD\.[^=]*=\s*/, "").replace(/;\s*$/, "");
    return JSON.parse(raw);
  } catch (e) { log("  ! parse error, skipped:", path.relative(here, file)); return null; }
}
function loadPrev() {
  if (!fs.existsSync(OUT)) return null;
  try {
    const s = fs.readFileSync(OUT, "utf8").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
    return JSON.parse(s);
  } catch (e) { log("(existing data.js unreadable — rebuilding from source only)"); return null; }
}

/* ========================================================================= */
log("Building archive (merge mode, multi-conversation)…");

const prev = loadPrev();

const exportFiles = findExports();
log("Export files found:", exportFiles.length, exportFiles.map((f) => path.relative(here, f)).join(", ") || "(none)");
const exportDatas = exportFiles.map(parseExport).filter(Boolean);

const headerFiles = findHeaders();
log("Header files found:", headerFiles.length, headerFiles.map((f) => path.relative(here, f)).join(", ") || "(none)");
const headerDatas = headerFiles.map(parseExport).filter(Boolean);

const mediaDirs = findMediaDirs();
log("Media folders:", mediaDirs.map((d) => path.relative(here, d)).join(", ") || "(none)");
const mediaIndex = buildMediaIndex(mediaDirs);

const { conversations, totalMsgs, totalMedia, prevCount } =
  assembleConversations({ prev, exportDatas, headerDatas, mediaIndex, ignoredUsers, ignoredGroups });

if (prev) log("Baseline from data.js:", prevCount, "messages.");

// write
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, "window.CHAT_DATA = " + JSON.stringify({
  generatedAt: new Date().toISOString(),
  ignoredUsers,
  ignoredGroups,
  conversations,
}) + ";\n");

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
log("---");
log("Group conversations:", conversations.length);
log("Total messages:", totalMsgs, prev ? "(" + (totalMsgs - prevCount >= 0 ? "+" : "") + (totalMsgs - prevCount) + " since last build)" : "");
log("With media:", totalMedia);
conversations.slice(0, 12).forEach((c) =>
  log("  ·", String(c.id).slice(-8).padStart(8), fmtN(c.count).padStart(8), c.title || "(group)"));
log("Wrote data.js (" + mb + " MB). Open index.html to view.");
function fmtN(n) { return n.toLocaleString("en-US"); }
