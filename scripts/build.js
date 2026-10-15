/*
 * build.js — builds personal_data/data.js from the setup wizard's config.
 *
 * Wizard-driven only: it reads personal_data/config.json (written by setup.html
 * / scripts/server.js) for the exact source file(s) + media folder, streams the
 * group export (direct-messages-group.js and any -partN files), folds EVERY
 * group dmConversation into a per-conversation index, and writes
 * personal_data/data.js.
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
 * Fails loudly (SP-1): a missing, empty, truncated, unparseable or wrong file,
 * or an export with no group chats, prints ONE plain-language line
 *   BUILD ERROR: <what went wrong and what to do>
 * on stderr and exits non-zero without touching data.js. The setup server shows
 * that line to the user; nothing else (no stack traces) is meant for them.
 *
 * All transformation lives in build-core.js (pure, unit-tested); the streaming
 * file reader is fs-io.js; this file is the filesystem shell around them. Set
 * GCA_PERSONAL to point at a different personal_data/ folder (used by tests to
 * avoid touching real data).
 *
 * Not meant to be run by hand — use the setup wizard (setup.html).
 */

const fs = require("fs");
const path = require("path");
const core = require("./build-core.js");
const { scanExportFile, readExportHead, writeChunksAtomic } = require("./fs-io.js");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const PERSONAL = process.env.GCA_PERSONAL ? path.resolve(process.env.GCA_PERSONAL) : path.join(here, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");
const OUT = path.join(PERSONAL, "data.js");
const log = (...a) => console.log(...a);

// A user-facing failure: its message is the whole story, shown as-is.
class BuildError extends Error {}
function fail(msg) { throw new BuildError(msg); }

// The build is driven entirely by personal_data/config.json (written by the
// setup wizard). No config → nothing to build; point the user at the wizard.
function loadConfig() {
  if (!fs.existsSync(CONFIG)) fail("No setup found (personal_data/config.json is missing). Run the setup wizard first: node scripts/server.js, then open http://localhost:8765/setup.html");
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "")); }
  catch (e) { fail("The setup file personal_data/config.json is damaged. Use Start over in the setup wizard."); }
}
const resolveHere = (p) => (path.isAbsolute(p) ? p : path.join(here, p));
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

/* ---- config-driven sources ----------------------------------------------- */
function findMediaDirs(config) {
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

// Stream one export file into the accumulator, after checking it is the kind
// of file this slot expects ("messages" or "headers").
function ingest(acc, file, which) {
  const label = path.basename(file);
  const role = which === "headers" ? "headers file" : "messages file";
  if (!fs.existsSync(file)) fail("The " + role + " \u201c" + label + "\u201d is missing (" + file + "). Run the setup wizard again and pick your export files.");
  if (!fs.statSync(file).isFile()) fail("The " + role + " \u201c" + label + "\u201d is a folder, not a file. Pick the .js file itself.");
  const wrong = core.wrongKindMessage(core.identifyExport(readExportHead(file)), which, label);
  if (wrong) fail(wrong);
  const sink = core.createExportSink(acc, which);
  try { scanExportFile(file, sink.handlers); }
  catch (e) {
    if (e instanceof core.ExportScanError) fail("\u201c" + label + "\u201d: " + e.message + ".");
    throw e;
  }
  const stats = sink.finish();
  // SP-8: a headers file picked as the messages file parses fine but every
  // messageCreate lacks `text` — the build would "succeed" with blank messages.
  if (which !== "headers" && stats.messages > 0 && stats.withText === 0) {
    fail("\u201c" + label + "\u201d looks like the group headers file: its messages have no text. Pick direct-messages-group.js as the messages file and direct-message-group-headers.js as the headers file.");
  }
  return stats;
}

function loadPrev() {
  if (!fs.existsSync(OUT)) return null;
  try {
    const s = fs.readFileSync(OUT, "utf8").replace(/^\uFEFF/, "").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
    return JSON.parse(s);
  } catch (e) {
    // SP-9: this file IS the accumulated history (messages that may no longer
    // be in any export). Rebuilding without it would silently drop them, so
    // stop and let the user decide.
    fail("Your existing archive (personal_data/data.js) couldn't be read — it may have been damaged by a crash or a full disk. " +
      "The build stopped so the history in it isn't silently replaced. Restore data.js from a backup, or delete it (or use Start over) to rebuild from this export only.");
  }
}

function writeArchive(meta, conversations) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // SP-9: temp file + rename, so a crash mid-write can't leave a truncated data.js
  writeChunksAtomic(OUT, core.archiveChunks(meta, conversations));
}

/* ========================================================================= */
function main() {
  const config = loadConfig();
  const ignoredUsers = (Array.isArray(config.ignoredUsers) ? config.ignoredUsers : []).map(String);
  const ignoredGroups = (Array.isArray(config.ignoredGroups) ? config.ignoredGroups : []).map(String);

  log("Building archive (merge mode, multi-conversation)…");
  const exportFiles = asList(config.sourceJs).map(resolveHere);
  const headerFiles = asList(config.headersJs).map(resolveHere);
  if (!exportFiles.length) fail("No messages file is set up. Run the setup wizard and pick direct-messages-group.js.");

  const acc = core.createAccumulator({ ignoredUsers, ignoredGroups });
  const prev = loadPrev();
  acc.addPrev(prev);

  log("Export files:", exportFiles.length, exportFiles.map((f) => path.basename(f)).join(", "));
  const seen = { dm: 0 };
  for (const f of exportFiles) {
    const st = ingest(acc, f, "messages");
    seen.dm += st.dmConversations;
    log("  ·", path.basename(f) + ":", st.messages, "messages in", st.conversations, "conversation(s)");
  }
  log("Header files:", headerFiles.length, headerFiles.map((f) => path.basename(f)).join(", ") || "(none)");
  for (const f of headerFiles) ingest(acc, f, "headers");

  const mediaDirs = findMediaDirs(config);
  log("Media folders:", mediaDirs.map((d) => path.relative(here, d)).join(", ") || "(none)");
  const mediaIndex = buildMediaIndex(mediaDirs);

  const { conversations, totalMsgs, totalMedia, prevCount, groupsSeen } = acc.finish(mediaIndex);
  if (!groupsSeen) {
    const names = exportFiles.map((f) => "\u201c" + path.basename(f) + "\u201d").join(", ");
    fail("No group chats were found in " + names + (seen.dm ? " — it only has 1:1 conversations" : "") +
      ". Make sure you picked direct-messages-group.js from the data folder of your Twitter/X archive.");
  }
  if (prev) log("Baseline from data.js:", prevCount, "messages.");

  writeArchive({ generatedAt: new Date().toISOString(), ignoredUsers, ignoredGroups }, conversations);

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
  log("---");
  log("Group conversations:", conversations.length);
  log("Total messages:", totalMsgs, prev ? "(" + (totalMsgs - prevCount >= 0 ? "+" : "") + (totalMsgs - prevCount) + " since last build)" : "");
  log("With media:", totalMedia);
  conversations.slice(0, 12).forEach((c) =>
    log("  ·", String(c.id).slice(-8).padStart(8), fmtN(c.count).padStart(8), c.title || "(group)"));
  log("Wrote data.js (" + mb + " MB). Open index.html to view.");
}
function fmtN(n) { return n.toLocaleString("en-US"); }

// Plain-language text for the failures a user can actually hit; anything else
// is reported as unexpected, still without a stack trace (GCA_DEBUG=1 adds it).
function describeFailure(e) {
  if (e instanceof BuildError) return e.message;
  const code = e && e.code;
  if (code === "ERR_STRING_TOO_LONG") return "A file is too large to read in one piece. Please report this — the build should stream it.";
  if (code === "ENOSPC") return "The disk is full. Free up some space and try again.";
  if (code === "EACCES" || code === "EPERM") return "Permission denied while reading or writing " + (e.path ? "\u201c" + e.path + "\u201d" : "a file") + ". Close any program using it (or move the archive out of a protected folder) and try again.";
  if (code === "EBUSY") return "A file is locked by another program (antivirus or a sync app?). Wait a moment and try again.";
  if (e instanceof RangeError && /memory|allocation/i.test(e.message)) return "The build ran out of memory. Close other programs and try again.";
  return "The build failed unexpectedly: " + String(e && e.message || e);
}

if (require.main === module) {
  try { main(); }
  catch (e) {
    console.error("BUILD ERROR: " + describeFailure(e));
    if (process.env.GCA_DEBUG && !(e instanceof BuildError)) console.error(e && e.stack);
    process.exit(2);
  }
}
