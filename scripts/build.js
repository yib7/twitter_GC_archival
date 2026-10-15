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
 *  - Merge-aware: streams the previous data.js in as a baseline, so re-running
 *    the wizard with a newer export accumulates history instead of losing it.
 *  - Dedupes messages by id, re-sorts chronologically, resolves local media by
 *    the {messageId}-… filename convention. Group chats only — 1:1 DMs are skipped.
 *
 * Fails loudly: a missing, empty, truncated, unparseable or wrong file,
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
const { scanExportFile, scanArchiveFile, readExportHead, writeChunksAtomic, replaceFile, TMP_RE } = require("./fs-io.js");

const here = path.join(__dirname, "..");   // project root (this script lives in scripts/)
const PERSONAL = process.env.GCA_PERSONAL ? path.resolve(process.env.GCA_PERSONAL) : path.join(here, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");
const OUT = path.join(PERSONAL, "data.js");
const BAK = OUT + ".bak";
// messages left out because their group chat or person
// is removed. A merge re-points config at the newer export (and the older
// copies are pruned), so the archive itself must keep what it removed, or
// un-removing could only bring back what the newest export still has.
// Same format as data.js; never served (not under an allowlisted prefix).
const QUAR = path.join(PERSONAL, ".removed", "messages.js");
const log = (...a) => console.log(...a);
// Test-only: stop the build at a named point, as a crash would.
const crashPoint = (name) => { if (process.env.GCA_TEST_BUILD_CRASH === name) fail("Simulated crash (" + name + ")."); };

// Set once the new data.js is in place. A failure after that exits with
// code 3 instead of 2: the archive already holds the new messages, so the
// server keeps the copies they point at instead of rolling them back.
let archiveWritten = false;

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
  const idx = {};   // messageId -> [root-relative paths] (all of them)
  for (const d of dirs) {
    const rel = path.relative(here, d).split(path.sep).join("/");
    const names = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    const part = core.indexMediaFiles(names, rel);
    for (const id of Object.keys(part)) idx[id] = (idx[id] || []).concat(part[id]);
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
  try { scanExportFile(file, sink.handlers, scanOpts()); }
  catch (e) {
    if (e instanceof core.ExportScanError) fail("\u201c" + label + "\u201d: " + e.message + ".");
    throw e;
  }
  const stats = sink.finish();
  // a headers file picked as the messages file parses fine but every
  // messageCreate lacks `text` — the build would "succeed" with blank messages.
  if (which !== "headers" && stats.messages > 0 && stats.withText === 0) {
    fail("\u201c" + label + "\u201d looks like the group headers file: its messages have no text. Pick direct-messages-group.js as the messages file and direct-message-group-headers.js as the headers file.");
  }
  return stats;
}

// The previous data.js is the baseline (the accumulated history). It is
// streamed into the accumulator one conversation at a time, so it may be any
// size (no ~512 MB ceiling). Returns null when there is none.
function loadPrev(acc) {
  if (!fs.existsSync(OUT)) {
    // no data.js, but its backup or an unfinished save is right next to
    // it (a crash mid-swap, or data.js deleted by hand): the history is in
    // there. Building from this export alone would replace it, so stop.
    const left = leftoversOf(OUT);
    if (left.length) {
      fail("Your archive (personal_data/data.js) is missing, but " + left.map((f) => "“" + f + "”").join(", ") +
        " is next to where it should be, and may hold your archive's history. The build stopped so that history isn't replaced by this export alone. " +
        "To keep it, make a copy of that file and rename it to data.js, then build again. To start fresh from this export instead, use Start over (it erases the leftovers).");
    }
    return null;
  }
  try {
    return scanArchiveFile(OUT, { onConversation: (c) => acc.addPrev({ conversations: [c] }) }, scanOpts());
  } catch (e) {
    // never rebuild over history that couldn't be read. Each cause gets
    // its own sentence; only real damage is called damaged.
    const msg = core.prevArchiveProblem(e);
    if (msg) fail(msg);
    throw e;
  }
}
// the quarantined removed messages, streamed in under
// the baseline (a message the archive has always wins). true when there is one.
function loadQuarantine(acc) {
  if (!fs.existsSync(QUAR)) return false;
  try {
    scanArchiveFile(QUAR, { onConversation: (c) => acc.addPrev({ conversations: [c] }, { quarantine: true }) }, scanOpts());
    return true;
  } catch (e) {
    fail("The messages of removed people and group chats (personal_data/.removed/messages.js) couldn't be read, so the build stopped instead of losing them. " +
      "Close any program using that file and try again; Start over erases it.");
  }
}
// Write the quarantine (atomically), or remove it when nothing is left in it.
// While anything is removed it stays, even empty — its
// presence says this archive's removals have been set aside (an archive with
// removals and no quarantine predates it; see sourceAndBuild in server.js).
function writeQuarantine(convs, keepEmpty) {
  if (!convs.length && !keepEmpty) { if (fs.existsSync(QUAR)) fs.rmSync(QUAR, { force: true }); return; }
  fs.mkdirSync(path.dirname(QUAR), { recursive: true });
  writeChunksAtomic(QUAR, core.archiveChunks({ generatedAt: new Date().toISOString(), removedMessages: true }, convs));
}

// data.js.bak, data.js.<pid>.<hex>.tmp (a write or swap cut short) and
// data.js.bak.<pid>.<hex>.tmp next to `file`, newest first.
function leftoversOf(file) {
  const dir = path.dirname(file), base = path.basename(file);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter((n) => n === base + ".bak" || (n.startsWith(base + ".") && TMP_RE.test(n)))
    .map((n) => { let t = 0; try { t = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { /* gone */ } return { n, t }; })
    .sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : 1))
    .map((x) => x.n);
}
// Read size for the streaming readers; GCA_SCAN_CHUNK (bytes) lets tests force
// tiny reads through the whole build.
function scanOpts() {
  const n = Number(process.env.GCA_SCAN_CHUNK);
  return n > 0 ? { chunkSize: n } : undefined;
}

// Keep ONE backup, data.js.bak = the archive as it was
// before the last successful build. The old data.js is hard-linked (no copy,
// no extra disk) to a temp name before the new one replaces it, and that link
// becomes data.js.bak only once the new data.js is safely in place; a failed
// build leaves the previous data.js.bak alone. (A disk without hard links
// gets a copy.) data.js itself is never moved or missing.
function writeArchive(meta, conversations) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let bakTmp = null;
  if (fs.existsSync(OUT)) {
    bakTmp = BAK + "." + process.pid + "." + require("crypto").randomBytes(4).toString("hex") + ".tmp";
    try { fs.linkSync(OUT, bakTmp); }
    catch (e) {
      try { fs.copyFileSync(OUT, bakTmp); }
      catch (e2) { log("Warning: couldn't keep a backup of the previous data.js (" + (e2.code || e2.message) + ")."); bakTmp = null; }
    }
  }
  try {
    // temp file + rename, so a crash mid-write can't leave a truncated data.js
    writeChunksAtomic(OUT, core.archiveChunks(meta, conversations));
  } catch (e) {
    if (bakTmp) try { fs.unlinkSync(bakTmp); } catch (e2) { /* gone */ }
    throw e;
  }
  if (bakTmp) {
    try { replaceFile(bakTmp, BAK); }
    catch (e) { try { fs.unlinkSync(bakTmp); } catch (e2) { /* gone */ } log("Warning: couldn't update data.js.bak (" + (e.code || e.message) + ")."); }
  }
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
  const hadQuarantine = loadQuarantine(acc);
  const prev = loadPrev(acc);
  // an old single-conversation archive keeps its messages at the root
  if (prev && prev.meta.conversationId != null) acc.addPrev(prev.meta);

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

  const { conversations, totalMsgs, totalMedia, prevCount, groupsSeen, warnings, removed, restored } = acc.finish(mediaIndex);
  if (!groupsSeen) {
    const names = exportFiles.map((f) => "\u201c" + path.basename(f) + "\u201d").join(", ");
    fail("No group chats were found in " + names + (seen.dm ? " — it only has 1:1 conversations" : "") +
      ". Make sure you picked direct-messages-group.js from the data folder of your Twitter/X archive.");
  }
  if (prev) log("Baseline from data.js:", prevCount, "messages.");
  if (warnings.missingBodies) log("Warning: " + warnings.missingBodies + " message(s) listed in the headers file have no message text in the messages file(s). " +
    "If your archive's data folder has direct-messages-group-part1.js (-partN) files, make sure they sit next to direct-messages-group.js.");
  if (warnings.badTime) log("Warning: " + warnings.badTime + " message(s)/event(s) had a missing or unreadable date and were skipped.");

  // quarantine first as a superset (still removed +
  // coming back), then data.js, then narrow the quarantine to what is still
  // removed. Cut off anywhere, every message is in data.js or the quarantine.
  const anyRemoved = removed.length > 0, anyBack = restored.length > 0;
  const anyIgnored = ignoredUsers.length > 0 || ignoredGroups.length > 0;
  if (anyRemoved || anyBack || hadQuarantine || anyIgnored) writeQuarantine(core.mergeQuarantine(removed, restored), anyIgnored);
  crashPoint("after-quarantine");
  writeArchive({ generatedAt: new Date().toISOString(), ignoredUsers, ignoredGroups }, conversations);
  archiveWritten = true;
  crashPoint("after-archive");
  if (anyBack) writeQuarantine(removed, anyIgnored);
  if (anyRemoved) log("Kept out (removed people / group chats):", removed.reduce((n, c) => n + c.count, 0), "message(s), in personal_data/.removed/messages.js.");

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
  if (e && e.userMessage) return e.userMessage;   // fs-io: a file held by another program
  const code = e && e.code;
  if (code === "ERR_STRING_TOO_LONG") return "A file has a single entry too large to read. Please report this.";
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
    process.exit(archiveWritten ? 3 : 2);
  }
}
