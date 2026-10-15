/*
 * server.js — optional local web server for the Group Chat Archive.
 *
 * Daily use does NOT need this: just double-click index.html. Use the server
 * when your browser blocks local videos/images over file://, OR to run the
 * one-time setup wizard (it needs Node to write config + copy media):
 *
 *   node scripts/server.js
 *   → open  http://localhost:8765            (the app)
 *   → open  http://localhost:8765/setup.html (first-run setup wizard)
 *
 * The wizard talks to three small JSON endpoints, all Node built-ins only:
 *   POST /api/source    point at the archive folder (archiveRoot), or at group
 *                       .js + headers .js + media → write config, copy
 *                       sources + media, build
 *   GET  /api/parts     participants + link-free sample messages + shared media
 *   POST /api/identity  names / pfps / GC photo / "this is you" → write local.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const { createParticipantCollector, exportPartFiles, identifyExport, wrongKindMessage } = require("./build-core.js");
const { locateExport, writeFileAtomic, readExportHead, scanExportFile, readArchiveSummary, foldArchive, readArchiveMeta, TMP_RE } = require("./fs-io.js");
const { createRemovalCounter, createOwnersCollector, createReferencedNames, createMessageCounter, safeSegment, diskSpaceProblem, sameIdSet, normalizeUserPath, pathNotFoundHint, isPickerRequestAllowed, buildNodeArgs, buildFailureMessage, friendlyError, MEDIA_FILE_RE, mediaFolderProblem, dialogFilter, pfpFileName, isInsidePersonal, openerCommand, makeLiveness, mergeNames, isServablePath, OPTIONAL_OVERRIDES, isAllowedHost, isAllowedOrigin } = require("./server-core.js");

const ROOT = path.resolve(__dirname, "..");     // project root (this script lives in scripts/)
// GCA_PERSONAL mirrors build.js's env override: point identity storage at a
// throwaway directory so tests can exercise real save/reload persistence
// without ever touching the real personal_data/. Unset in normal use.
const PERSONAL = process.env.GCA_PERSONAL ? path.resolve(process.env.GCA_PERSONAL) : path.join(ROOT, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");
// `let`, not `const`: GCA_PORT=0 asks the OS for a free ephemeral port (used by
// tests so no fixed port can ever collide with a real server — see QA-1). The
// listen() callback below reassigns this to the port actually bound, BEFORE
// anything else (the startup message, the Host-allowlist check) reads it.
let PORT = process.env.GCA_PORT ? Number(process.env.GCA_PORT) : 8765;
const HOST = "127.0.0.1";
// QA-2/SP-16: when set (Playwright's own webServer sets this — see
// playwright.config.js), skip the legacy ROOT/data.js + ROOT/names.local.js
// fallbacks entirely, so a spawned test server can NEVER read or serve a
// leftover root-level file even if one happens to exist on disk.
const NO_ROOT_FALLBACK = !!process.env.GCA_NO_ROOT_FALLBACK;

// When launched via the double-click launcher (`--open`), shut the server down
// once the browser is closed — so users aren't left with a stray command window.
// Served pages ping GET /api/ping?c=<page id> and send a goodbye beacon
// (POST /api/bye?c=<page id>) when they close; see makeLiveness (SP-6) for why
// a quiet heartbeat alone is never taken as "closed".
// GCA_AUTO_EXIT=1 turns the same behaviour on without opening a browser (tests).
const AUTO_EXIT = process.argv.includes("--open") || process.env.GCA_AUTO_EXIT === "1";
// Fix round 1 (#6): ~20 s of grace after the last goodbye, so the next page
// (a reload, the wizard's "Open your archive", a slow-loading big archive)
// has time to say hello.
const live = makeLiveness({ graceMs: 20000, idleMs: 30 * 60 * 1000 });
let idleWatch = null;
const clientIdOf = (qs) => { const m = /(?:^|&)c=([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(qs || ""); return m ? m[1] : "anon"; };
function notePing(id) {
  live.ping(id);
  if (AUTO_EXIT && !idleWatch) {   // arm the watchdog once the browser first connects
    idleWatch = setInterval(() => {
      if (live.shouldExit()) {
        console.log("Browser closed — shutting down.");
        process.exit(0);
      }
    }, 1000);
  }
}
// Bracket a synchronous, event-loop-freezing call (a native picker, the build) so
// the auto-exit watchdog can't mistake that frozen stretch — during which the
// browser's heartbeats can't be received — for the browser having closed.
function duringBlocking(fn) {
  live.enter();
  try { return fn(); }
  finally { live.leave(); }
}
const MAX_JSON_BODY = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

/* ---- small helpers ------------------------------------------------------- */
function httpError(code, message) {
  const err = new Error(message);
  err.statusCode = code;
  return err;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;   // already rejected — keep draining so the socket
      size += c.length;       // isn't reset mid-upload, but stop buffering.
      if (size > MAX_JSON_BODY) {
        tooLarge = true;
        chunks.length = 0;    // free what we'd buffered so far — bounded memory
        // NOTE: no req.destroy() here — destroying the request stream destroys
        // the underlying socket (per Node's http docs) before the 413 response
        // below has a chance to be written, so a real client sees a mid-upload
        // connection reset instead of a clean 413. Reject now (readBody's
        // caller sends the 413) and keep the connection open, silently
        // draining the rest of the oversized body, so the response actually
        // reaches the client. Bounded memory is still guaranteed: nothing past
        // the cap is ever pushed onto `chunks`.
        //
        // Review fix: draining is only meant to last long enough for the 413
        // to reach the client — a slow/unbounded/never-ending body (a stalled
        // upload, or deliberately, a slowloris-style client that just never
        // sends 'end') would otherwise keep this connection — and its socket —
        // open forever, even though the response was fully sent ages ago.
        // res's "finish" event fires only once the 413 has actually been
        // flushed to the client (unlike destroying req synchronously here,
        // which is the exact bug the note above describes), so closing the
        // connection there is safe and bounds the connection's lifetime too.
        //
        // SP2 carry-over: destroying on "finish" itself was still too early
        // on Linux/macOS — "finish" means handed to the kernel, not read by
        // the peer, and closing a socket that still has unread request bytes
        // makes the kernel send a RST, which can discard the 413 before the
        // client reads it. So: advertise `Connection: close` (Node then
        // half-closes gracefully with a FIN once the 413 is flushed) and only
        // hard-destroy after a short grace period, which still bounds a
        // never-ending upload's lifetime.
        if (res) {
          if (!res.headersSent) res.setHeader("Connection", "close");
          res.once("finish", () => {
            const t = setTimeout(() => req.destroy(), 1000);
            if (t.unref) t.unref();
          });
        }
        reject(httpError(413, "This save is too large to send in one go. Use smaller photos, or save a few at a time."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;   // already rejected; nothing left to parse
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(httpError(400, "Invalid JSON request body.")); }
    });
    req.on("error", reject);
  });
}
function loadConfig() {
  if (!fs.existsSync(CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { return {}; }
}
// SP-9: every file the wizard writes goes through a temp file + rename, so a
// crash or a full disk mid-write never leaves a truncated config/local.js.
function saveConfig(cfg) {
  fs.mkdirSync(PERSONAL, { recursive: true });
  writeFileAtomic(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}
// data URL ("data:image/png;base64,....") → { buf, ext }
// `whose` ("Ann's photo", "the group photo for Crew") names the photo in the
// 413 so the user knows which one to replace (SP-12).
function decodeDataUrl(url, whose) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "img";
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw httpError(413, (whose ? whose.charAt(0).toUpperCase() + whose.slice(1) + " is" : "An uploaded image is") +
      " larger than 10 MB. Choose a smaller photo (photos picked in the wizard are shrunk automatically).");
  }
  return { buf, ext };
}
// SP-7: copies only the top-level files of srcDir that are named like X's
// message media ("<messageId>-<name>.<image/video ext>", MEDIA_FILE_RE).
// Subfolders, symlinks and anything else are left behind and counted as
// `unmatched`, so a mis-picked folder can never drag other private files
// (1:1 DMs, account.js, other media) into the servable personal_data/media/.
// X's group media folder is flat, so there are no same-name clashes to resolve.
// `skipExisting` (SP-14 restore) copies only files destDir doesn't have yet.
// `journal` (fix round 1, #9) records each copy so a failed build can undo it.
function copyMediaFlat(srcDir, destDir, opts) {
  const skipExisting = !!(opts && opts.skipExisting);
  const journal = (opts && opts.journal) || null;
  const skip = (opts && opts.skip) || null;   // names not to copy (e.g. still quarantined)
  const ids = (opts && opts.ids) || null;     // only media of these message ids (fix round 1, #7)
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0, unmatched = 0;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.isFile() && MEDIA_FILE_RE.test(e.name) && (!ids || ids.has(e.name.split("-")[0]))) {
      const dest = path.join(destDir, e.name);
      if (skip && skip.has(e.name)) continue;
      if (skipExisting && fs.existsSync(dest)) continue;
      if (journal) journal.copy(path.join(srcDir, e.name), dest);
      else fs.copyFileSync(path.join(srcDir, e.name), dest);
      copied++;
    } else unmatched++;
  }
  return { copied, unmatched };
}
// Fix round 1 (#9): a new source is copied over the previous one (source/ and
// media/) BEFORE its build runs, so a failed build used to leave the previous
// copies overwritten. Every copy goes through this journal instead: a file it
// would replace is first moved into `backupDir` (a rename, so no extra space),
// and a new file is noted. rollback() deletes the new files and moves the
// replaced ones back; commit() drops the backups. Media and source names are
// flat (no folders), so one backup folder per destination never clashes.
function copyJournal(backupDir) {
  const created = [], saved = [];
  return {
    copy(src, dest) {
      if (fs.existsSync(dest)) {
        fs.mkdirSync(backupDir, { recursive: true });
        const kept = path.join(backupDir, path.basename(dest));
        fs.renameSync(dest, kept);
        saved.push([kept, dest]);
      } else created.push(dest);
      fs.copyFileSync(src, dest);
    },
    rollback() {
      const problems = [];
      for (const f of created) { try { fs.rmSync(f, { force: true }); } catch (e) { problems.push(f); } }
      for (const [kept, dest] of saved) {
        try { fs.rmSync(dest, { force: true }); fs.renameSync(kept, dest); } catch (e) { problems.push(dest); }
      }
      // Anything that couldn't be put back stays in backupDir rather than lost.
      if (!problems.length) fs.rmSync(backupDir, { recursive: true, force: true });
      return problems;
    },
    commit() { fs.rmSync(backupDir, { recursive: true, force: true }); },
  };
}
const PREV_DIR_RE = /^(?:source|media)\.prev-\d+-[0-9a-f]+$/;
const prevDirName = (name) => name + ".prev-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
// SP7 (SP6 review #3): a server killed mid-build leaves its backup folders
// behind. Once a later build has committed, source/ and media/ are consistent
// again and those old copies are just stale private data — remove them.
function clearStaleBackups() {
  let names;
  try { names = fs.readdirSync(PERSONAL); } catch (e) { return; }
  for (const n of names) {
    if (!PREV_DIR_RE.test(n)) continue;
    const p = path.join(PERSONAL, n);
    if (!isInsidePersonal(p, PERSONAL)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { console.error("Couldn't remove " + n + ": " + (e && e.message)); }
  }
}

// SP-7: the folder the user picked → the group media folder to copy from.
// Picking the archive (or its data/ folder) uses its direct_messages_group_media
// inside; a folder that is clearly something else is refused with a reason.
function resolveMediaDir(abs, typed) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { error: "Media folder not found: " + typed + ". " + pathNotFoundHint(process.platform, "direct_messages_group_media") + "." }; }
  if (!st.isDirectory()) return { error: "The media folder you chose is a file, not a folder: " + typed + ". Pick the direct_messages_group_media folder." };
  for (const rel of ["direct_messages_group_media", path.join("data", "direct_messages_group_media")]) {
    const child = path.join(abs, rel);
    try { if (fs.statSync(child).isDirectory()) return { dir: child, descended: rel }; } catch (e) { /* not here */ }
  }
  let names;
  try { names = fs.readdirSync(abs); } catch (e) { return { error: friendlyError(e) }; }
  const problem = mediaFolderProblem(path.basename(abs), names);
  return problem ? { error: problem } : { dir: abs };
}
// Open a native Windows file/folder picker and return the chosen absolute path.
// `which` ("group" | "headers") only tailors the file dialog's title + filter —
// the values are constant strings we control, so there's no injection risk.
// Returns "" on cancel, null when unsupported (not Windows), or { error } when
// PowerShell couldn't show the dialog (e.g. Constrained Language Mode blocks
// Add-Type) — SP-23: so a Windows user isn't told it "only works on Windows".
function nativePick(kind, which) {
  if (process.platform !== "win32") return null;
  // Tests set this so a picker request can never open a real, blocking dialog.
  if (process.env.GCA_NO_NATIVE_PICKER === "1") return null;
  let ps;
  if (kind === "folder") {
    // Use the SAME modern file dialog as the .js pickers (FolderBrowserDialog is
    // the old tree-view style, which looks inconsistent). The user opens any file
    // inside their media folder and we return that file's parent directory.
    // SP7: for=root picks the unzipped archive folder the same way.
    const title = which === "root"
      ? "Open ANY file in your unzipped Twitter/X archive folder (e.g. Your archive.html)"
      : "Open ANY file inside your direct_messages_group_media folder";
    ps = "Add-Type -AssemblyName System.Windows.Forms;$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title='" + title + "';$d.Filter='All files (*.*)|*.*';$d.Multiselect=$false;if($d.ShowDialog($o) -eq 'OK'){[Console]::Out.Write([System.IO.Path]::GetDirectoryName($d.FileName))};$o.Dispose()";
  } else {
    const headers = which === "headers";
    const title = headers ? "Select direct-message-group-headers.js" : "Select direct-messages-group.js";
    const filter = dialogFilter(which);
    ps = "Add-Type -AssemblyName System.Windows.Forms;$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Filter='" + filter + "';$d.Multiselect=$false;$d.Title='" + title + "';if($d.ShowDialog($o) -eq 'OK'){[Console]::Out.Write($d.FileName)};$o.Dispose()";
  }
  try {
    return duringBlocking(() => execFileSync("powershell.exe", ["-STA", "-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true })).trim();
  } catch (e) {
    console.error("The native file dialog failed: " + String(e && (e.stderr || e.message) || e).split(/\r?\n/)[0]);
    return { error: "The Windows file browser couldn't be opened on this PC." };
  }
}
// The picker routes' reply: { path, supported } plus `error` when it failed.
function pickReply(p) {
  if (p && typeof p === "object") return { path: "", supported: true, error: p.error };
  return { path: p == null ? "" : p, supported: p !== null };
}

/* ---- fix round 1 (#3): the removed-media quarantine ---------------------- */
// personal_data/.removed/<group|person|other>/<id>/<file>: media of removed
// group chats / people, kept so un-removing can restore it. Never served (it
// isn't under an allowlisted prefix); Start over erases it.
const REMOVED = path.join(PERSONAL, ".removed");
// name -> { kind, id, file } for every quarantined file.
function listQuarantine() {
  const out = new Map();
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; } };
  for (const kind of dirs(REMOVED)) {
    for (const id of dirs(path.join(REMOVED, kind))) {
      const dir = path.join(REMOVED, kind, id);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) out.set(e.name, { kind, id, file: path.join(dir, e.name) });
      }
    }
  }
  return out;
}
// Move a file within personal_data/ (same disk: a rename). Never deletes the
// source unless it is now at `dest`; false (and the file left where it was) on
// any failure. An identical file already at `dest` just retires the source.
function moveFile(src, dest) {
  if (!isInsidePersonal(src, PERSONAL) || !isInsidePersonal(dest, PERSONAL)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && path.dirname(dest) !== REMOVED && !dest.startsWith(REMOVED + path.sep)) {
      // restoring over a file already back in media/: keep that one
      fs.rmSync(src, { force: true });
      return true;
    }
    fs.renameSync(src, dest);
    return true;
  } catch (e) {
    console.error("Couldn't move " + path.basename(src) + ": " + (e && e.message));
    return false;
  }
}

// The built archive. SP7 (SP6 review #2): it is never loaded whole — the
// server's default heap would have to hold every message body. It is streamed
// instead, either as a summary (no message is even parsed) or through small
// collectors that see one message at a time (see server-core.js).
function builtArchiveFiles() {
  const candidates = NO_ROOT_FALLBACK
    ? [path.join(PERSONAL, "data.js")]
    : [path.join(PERSONAL, "data.js"), path.join(ROOT, "data.js")];
  return candidates.filter((f) => fs.existsSync(f));
}
// { meta, conversations: [{ id, type, title, participants, count }] } or null.
// A BOM or an old single-conversation archive is accepted.
function readSummary() {
  for (const f of builtArchiveFiles()) {
    try { return readArchiveSummary(f); } catch (e) { /* try next */ }
  }
  return null;
}
// Fold collectors made by make() over the built archive; null when none reads.
function foldBuilt(make) {
  for (const f of builtArchiveFiles()) {
    const cols = make();
    try { foldArchive(f, cols); return cols; } catch (e) { /* try next */ }
  }
  return null;
}
const groupsOf = (sum) => (sum && sum.conversations || []).map((c) => ({ id: c.id, title: c.title, count: c.count }));

/* ---- endpoint: point at source + build ----------------------------------- */
const absOfInput = (p) => path.resolve(path.isAbsolute(p) ? p : path.join(ROOT, p));
const userPathOf = (v) => normalizeUserPath(v, { platform: process.platform, home: os.homedir() });
// What the user pointed at → the export files to read, or { status, error }.
// Nothing is written. Two ways in:
//   archiveRoot              SP7: the unzipped archive folder (or its data/
//                            folder, or any file in it). data/manifest.js says
//                            where everything is; a file-name scan is the
//                            fallback. Paths never leave the picked folder.
//   groupJs + headersJs + mediaDir   the three pieces picked one by one.
// → { groupFiles, headerFiles, mediaAbs (or null), mediaDescended, swapped,
//     via: "manifest" | "scan" | "files", notes: [{ code, … }] }
function resolveSource(body) {
  const rootIn = userPathOf(body.archiveRoot);
  if (rootIn) return resolveArchiveRoot(rootIn);
  // All three pieces of the group export are required.
  // SP-15: accept paths as pasted ("quoted", ~/..., My\ Archive)
  const groupJs = userPathOf(body.groupJs);
  const headersJs = userPathOf(body.headersJs);
  const mediaDirIn = userPathOf(body.mediaDir);
  if (!groupJs) return { status: 400, error: "Choose your direct-messages-group.js file." };
  if (!headersJs) return { status: 400, error: "Choose your direct-message-group-headers.js file." };
  if (!mediaDirIn) return { status: 400, error: "Choose your direct_messages_group_media folder." };

  let groupAbs = absOfInput(groupJs), headersAbs = absOfInput(headersJs);
  // SP-1 / SP-17: check what was picked BEFORE copying anything, so a wrong,
  // empty or missing file gets one plain sentence and nothing is half-written.
  const fileProblem = (abs, typed, role, expectName) => {
    let st;
    try { st = fs.statSync(abs); } catch (e) { return role + " not found: " + typed + ". " + pathNotFoundHint(process.platform, expectName) + "."; }
    if (st.isDirectory()) return "The " + role.toLowerCase() + " you chose is a folder, not a file: " + typed + ". Pick the .js file inside it.";
    if (!st.isFile()) return "The " + role.toLowerCase() + " you chose isn't a regular file: " + typed;
    return null;
  };
  const groupBad = fileProblem(groupAbs, groupJs, "Messages file", "direct-messages-group.js");
  if (groupBad) return { status: 400, error: groupBad };
  const headersBad = fileProblem(headersAbs, headersJs, "Headers file", "direct-message-group-headers.js");
  if (headersBad) return { status: 400, error: headersBad };
  // SP-8: each file names itself (window.YTD.<name>), so two files picked the
  // wrong way round are simply swapped back; any other mix-up is refused.
  let groupKind = identifyExport(readExportHead(groupAbs)), headersKind = identifyExport(readExportHead(headersAbs));
  let swapped = false;
  if (groupKind.kind === "headers" && headersKind.kind === "messages") {
    [groupAbs, headersAbs] = [headersAbs, groupAbs];
    [groupKind, headersKind] = [headersKind, groupKind];
    swapped = true;
  }
  const wrong = wrongKindMessage(groupKind, "messages", path.basename(groupAbs)) || wrongKindMessage(headersKind, "headers", path.basename(headersAbs));
  if (wrong) return { status: 400, error: wrong };
  // SP-7: only the group media folder — never the whole data/ folder (1:1 DMs,
  // account details …), which would become servable under personal_data/media/.
  const mediaPick = resolveMediaDir(absOfInput(mediaDirIn), mediaDirIn);
  if (mediaPick.error) return { status: 400, error: mediaPick.error };
  // SP-2: X splits big files into <name>.js, <name>-part1.js, …; picking any
  // one of them brings its whole family (in part order), so messages in
  // part1+ are never silently left behind.
  return {
    groupFiles: partSiblings(groupAbs), headerFiles: partSiblings(headersAbs),
    mediaAbs: mediaPick.dir, mediaDescended: mediaPick.descended || null,
    swapped, via: "files", notes: [],
  };
}
// SP7: the archive folder → its group files, checked by what they say they
// are (window.YTD.<name>) rather than what the manifest or their names claim.
function resolveArchiveRoot(rootIn) {
  const loc = locateExport(absOfInput(rootIn));
  if (loc.error) return { status: 400, error: loc.error };
  const notes = loc.notes.slice();
  const messages = [], headers = [], skipped = [];
  let swapped = false;
  const seen = new Set();
  const sort = (f, listedAs) => {
    if (seen.has(f)) return;
    seen.add(f);
    const k = identifyExport(readExportHead(f)).kind;
    const as = k === "messages" || k === "headers" ? k : k === "unknown" ? listedAs : null;
    if (as === "messages") messages.push(f);
    else if (as === "headers") headers.push(f);
    else skipped.push({ file: path.basename(f), kind: k });
    if (as && as !== listedAs) swapped = true;
  };
  for (const f of loc.messages) sort(f, "messages");
  for (const f of loc.headers) sort(f, "headers");
  if (skipped.length) notes.push({ code: "skipped-files", files: skipped });
  if (!messages.length) {
    return { status: 400, error: "The group chat files in “" + path.basename(loc.picked) + "” are empty or aren't group chats" +
      (skipped.length ? " (" + skipped.map((s) => s.file).join(", ") + ")" : "") + ". Re-extract your Twitter/X archive and try again." };
  }
  if (!headers.length) notes.push({ code: "no-headers" });
  if (!loc.mediaDir) notes.push({ code: "no-media" });
  return {
    groupFiles: messages, headerFiles: headers,
    mediaAbs: loc.mediaDir, mediaDescended: null,
    swapped, via: loc.via, notes, picked: loc.picked,
  };
}
function apiSource(body, res) {
  const src = resolveSource(body);
  if (src.error) return sendJSON(res, src.status || 400, { error: src.error });
  const { groupFiles, headerFiles, mediaAbs, swapped } = src;

  const cfg = loadConfig();
  const cfgBefore = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG) : null;

  const cfgNow = loadConfig();
  // Fix round 1 (#7): "<digits>-<name>.jpg" is also how phones and cameras name
  // pictures (20230301-IMG_0001.jpg), so the name alone can't tell a Pictures
  // folder from the group media. Only files whose number is a message id in
  // this export are copied, and a folder where none are is refused.
  // SP7: only the media of messages the archive keeps is copied — a removed
  // group's or person's media would otherwise sit, unreferenced but servable,
  // in media/ (the camera-roll check below still looks at every message).
  let ids = null, keepIds = null;
  try {
    const got = duringBlocking(() => exportMessageIds(groupFiles, cfgNow.ignoredGroups, cfgNow.ignoredUsers));
    ids = got.all; keepIds = got.keep;
  } catch (e) { /* unreadable: the build below says so plainly */ }
  if (ids && mediaAbs) {
    let candidates = 0, matching = 0;
    try {
      for (const e of fs.readdirSync(mediaAbs, { withFileTypes: true })) {
        if (!e.isFile() || !MEDIA_FILE_RE.test(e.name)) continue;
        candidates++;
        if (ids.has(e.name.split("-")[0])) matching++;
      }
    } catch (e) { /* unreadable: the copy reports it */ }
    if (candidates && !matching) {
      return sendJSON(res, 400, { error: "None of the " + candidates.toLocaleString("en-US") + " picture and video files in “" + path.basename(mediaAbs) +
        "” belong to messages in this export, so it doesn't look like its group media folder. Pick the direct_messages_group_media folder from the same Twitter/X archive." });
    }
  }

  // SP-23: make sure the copy (and the build's output) fits before starting it
  const spaceErr = diskSpaceProblem(copyBytesNeeded(groupFiles.concat(headerFiles), mediaAbs), freeBytesAt(PERSONAL));
  if (spaceErr) return sendJSON(res, 507, { error: spaceErr });

  // Copy every source into personal_data/source/ so ALL private data lives under
  // personal_data/ (the export is just as private as the messages).
  const srcDir = path.join(PERSONAL, "source");
  const mediaDestDir = path.join(PERSONAL, "media");
  fs.mkdirSync(srcDir, { recursive: true });
  // Fix round 1 (#9): every copy is journaled so a failed build puts back the
  // previous source/ and media/ files, not just config.json.
  const srcJournal = copyJournal(path.join(PERSONAL, prevDirName("source")));
  const mediaJournal = copyJournal(path.join(PERSONAL, prevDirName("media")));
  const undo = () => {
    const left = srcJournal.rollback().concat(mediaJournal.rollback());
    try {
      if (cfgBefore) writeFileAtomic(CONFIG, cfgBefore);
      else fs.rmSync(CONFIG, { force: true });
    } catch (err) { left.push(CONFIG); }
    if (left.length) console.error("[setup] couldn't put back " + left.length + " file(s) after a failed build; the previous copies are in personal_data/*.prev-*");
  };
  let media;
  try {
    // Store absolute destinations (not "personal_data/…"-relative-to-ROOT) so this
    // works whether PERSONAL is the real ROOT/personal_data or a GCA_PERSONAL
    // override (tests) — build.js's own path resolution already accepts absolute
    // paths as-is, so no change needed there.
    const copyInto = (abs) => {
      const dest = path.join(srcDir, path.basename(abs));
      if (path.resolve(abs) !== path.resolve(dest)) srcJournal.copy(abs, dest);
      return dest;
    };
    cfg.sourceJs = groupFiles.map(copyInto);   // message bodies (build parses these)
    const headerDests = headerFiles.map(copyInto);
    cfg.headersJs = headerDests.length === 1 ? headerDests[0] : headerDests;  // metadata only (roster + events)

    // media is required → always copied. Thousands of files can take a while to
    // copy synchronously, so bracket it in duringBlocking like the build below —
    // otherwise the auto-exit watchdog could mistake the frozen event loop for
    // the browser having closed.
    // SP7: an archive picked by its folder may have no group media folder
    // (none was sent); the media already copied in stays.
    media = mediaAbs
      ? duringBlocking(() => copyMediaFlat(mediaAbs, mediaDestDir, { ids: keepIds || new Set(), journal: mediaJournal }))
      : { copied: 0, unmatched: 0 };
    fs.mkdirSync(mediaDestDir, { recursive: true });
    cfg.mediaDir = mediaDestDir;
    // SP-14: remembered so media pruned for a removed group / person can be
    // restored from the export if they're un-removed later.
    if (mediaAbs) cfg.mediaSourceDir = mediaAbs;
    saveConfig(cfg);
  } catch (e) { undo(); throw e; }   // a copy failed part-way (disk full, unreadable file …)

  // run the build (it reads personal_data/config.json and writes personal_data/data.js)
  const built = runBuild();
  if (!built.ok) {
    // A failed build wrote no data.js; put config.json, source/ and media/ back
    // the way they were so the wizard isn't left pointing at the file that just failed.
    undo();
    return sendJSON(res, 422, { error: built.error, log: built.log });
  }
  srcJournal.commit(); mediaJournal.commit();
  clearStaleBackups();
  const buildLog = built.log;

  const groups = groupsOf(readSummary());
  const totalMsgs = groups.reduce((s, g) => s + (g.count || 0), 0);
  sendJSON(res, 200, { ok: true, swapped, mediaCopied: media.copied, mediaUnmatched: media.unmatched, mediaDescended: src.mediaDescended, via: src.via, notes: src.notes, groups, totalMsgs, partFiles: groupFiles.length, headerPartFiles: headerFiles.length, log: buildLog });
}
// Runs scripts/build.js (it reads personal_data/config.json and writes
// personal_data/data.js). → { ok: true, log } or { ok: false, error, log }.
// SP-1 / SP-17: the user gets build.js's one-sentence BUILD ERROR (never a raw
// stack trace); the full stderr goes to this server's console only. The log is
// shown in the wizard, so ask for plain text (an inherited FORCE_COLOR would
// wrap every number in ANSI colour codes). SP-10: heap sized to the machine.
function runBuild() {
  const buildEnv = Object.assign({}, process.env, { NO_COLOR: "1" });
  delete buildEnv.FORCE_COLOR;
  // eslint-disable-next-line no-control-regex -- matching ESC is the point
  const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  try {
    const out = duringBlocking(() => execFileSync(process.execPath, buildNodeArgs(path.join(__dirname, "build.js"), os.totalmem()),
      { cwd: ROOT, env: buildEnv, stdio: ["ignore", "pipe", "pipe"] }));
    return { ok: true, log: plain(out).trim() };
  } catch (e) {
    const stderr = e.stderr ? plain(e.stderr) : String(e.message || e);
    console.error("Build failed:\n" + stderr.trim());
    const error = buildFailureMessage(stderr);
    const log = ((e.stdout ? plain(e.stdout).trim() : "") + "\nBUILD ERROR: " + error).trim();
    return { ok: false, error, log };
  }
}
// SP-23: bytes the wizard is about to write — each export file copied plus
// about as much again for data.js, every media file that will be copied, and
// a margin.
function copyBytesNeeded(exportFiles, mediaDir) {
  let n = 64 * 1048576;
  for (const f of exportFiles) { try { n += 2 * fs.statSync(f).size; } catch (e) { /* gone: the build will say */ } }
  try {
    for (const e of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (e.isFile() && MEDIA_FILE_RE.test(e.name)) { try { n += fs.statSync(path.join(mediaDir, e.name)).size; } catch (err) { /* skip */ } }
    }
  } catch (e) { /* unreadable: the copy will report it */ }
  return n;
}
// Free bytes on the disk holding `dir` (its nearest existing parent); NaN when
// unknown. GCA_TEST_FREE_BYTES lets the tests pretend the disk is full.
function freeBytesAt(dir) {
  if (process.env.GCA_TEST_FREE_BYTES) return Number(process.env.GCA_TEST_FREE_BYTES);
  if (typeof fs.statfsSync !== "function") return NaN;
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { const st = fs.statfsSync(d); return Number(st.bavail) * Number(st.bsize); } catch (e) { return NaN; }
}
// The message ids in these export files: `all` of them, and `keep` — those
// the archive keeps (not in a removed group, not from a removed person).
// Streamed, one message at a time.
function exportMessageIds(files, ignoredGroups, ignoredUsers) {
  const G = new Set((Array.isArray(ignoredGroups) ? ignoredGroups : []).map(String));
  const U = new Set((Array.isArray(ignoredUsers) ? ignoredUsers : []).map(String));
  const all = new Set(), keep = new Set();
  for (const f of files) {
    const convOf = [];
    scanExportFile(f, {
      onConversationId: (ci, id) => { convOf[ci] = String(id); },
      onMessage: (ci, m) => {
        const mc = m && m.messageCreate;
        if (!mc || mc.id == null) return;
        const id = String(mc.id);
        all.add(id);
        if ((convOf[ci] != null && G.has(convOf[ci])) || U.has(String(mc.senderId))) return;
        keep.add(id);
      },
    });
  }
  return { all, keep };
}
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
// The chosen export file plus its -partN siblings in the same folder (SP-2).
function partSiblings(abs) {
  const dir = path.dirname(abs);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return [abs]; }
  return exportPartFiles(names, path.basename(abs))
    .map((n) => path.join(dir, n))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

/* ---- endpoint: participants for the naming step -------------------------- */
// `group` (optional) scopes the roster to one conversation so the wizard names
// one group chat at a time, instead of merging everyone across all groups.
function apiParts(res, group) {
  const cols = duringBlocking(() => foldBuilt(() => [createParticipantCollector(group)]));
  if (!cols) return sendJSON(res, 400, { error: "No built data yet — complete step 1 first." });
  sendJSON(res, 200, { parts: cols[0].result() });
}

/* ---- endpoint: save names / pfps / GC photo / "this is you" --------------- */
function apiIdentity(body, res) {
  fs.mkdirSync(path.join(PERSONAL, "pfps"), { recursive: true });
  const cfg = loadConfig();
  // Fix round 1 (#5): what the archive was actually BUILT without comes from
  // data.js's own metadata (build.js records ignoredUsers/ignoredGroups), not
  // config.json — config is saved before the rebuild runs, so after a failed
  // rebuild it would claim the removal had already been applied and the next
  // save would never retry. (An older data.js without them: fall back to config.)
  const builtMeta = readArchiveMeta(path.join(PERSONAL, "data.js"));
  const ignoredBefore = builtMeta && Array.isArray(builtMeta.ignoredUsers) && Array.isArray(builtMeta.ignoredGroups)
    ? { users: builtMeta.ignoredUsers, groups: builtMeta.ignoredGroups }
    : { users: cfg.ignoredUsers, groups: cfg.ignoredGroups };
  // Carry forward names from a previous save (like pfps/me/gc already do) —
  // otherwise reopening the wizard and saving with names untyped/unloaded
  // wipes out every name assigned in an earlier run.
  const names = mergeNames(cfg.names, body.names);
  const pfpPaths = {};
  const pfps = body.pfps && typeof body.pfps === "object" ? body.pfps : {};
  const gcIn = body.gc && typeof body.gc === "object" ? body.gc : {};
  const gcPrev = cfg.gc || {};

  // SP-12: decode and size-check EVERY photo before writing anything, so one
  // over-size photo can't leave earlier ones orphaned on disk or half a save
  // applied. The 413 names whose photo it was.
  const pfpData = {}, gcData = {};
  for (const id of Object.keys(pfps)) {
    pfpData[id] = decodeDataUrl(pfps[id], (names[id] ? names[id] + "’s" : "the") + " photo" + (names[id] ? "" : " for User " + String(id).slice(-4)));
  }
  for (const cid of Object.keys(gcIn)) {
    if (cid === "__proto__") continue;
    const entry = gcIn[cid] || {};
    const gname = entry.name != null ? String(entry.name) : ((gcPrev[cid] && gcPrev[cid].name) || "");
    gcData[cid] = decodeDataUrl(entry.photo, "the group photo" + (gname ? " for " + gname : ""));
  }

  // Reserve filenames already on disk (from a previous save) so a fresh upload
  // with the same name doesn't clobber them — person AND group photos (SP-19).
  const taken = new Set();
  const reserve = (p) => { const bn = String(p || "").split("/").pop(); if (bn) taken.add(bn); };
  if (cfg.pfps) for (const id of Object.keys(cfg.pfps)) reserve(cfg.pfps[id]);
  for (const cid of Object.keys(gcPrev)) reserve(gcPrev[cid] && gcPrev[cid].photo);

  // participant pfps (data URLs → files). Named people get <name>_pfp.<ext>;
  // unnamed people keep their opaque id, so the file is easy to relocate later.
  const pfpsDir = path.join(PERSONAL, "pfps");
  for (const id of Object.keys(pfps)) {
    const d = pfpData[id];
    if (!d) continue;
    const base = pfpFileName(names[id], id, d.ext, taken);
    taken.add(base);
    const fname = "pfps/" + base;
    // Defense in depth: pfpFileName already sanitizes the (untrusted) id, but
    // never write unless the resolved path is strictly inside personal_data/pfps/.
    const dest = path.join(PERSONAL, fname);
    if (!isInsidePersonal(dest, pfpsDir)) continue;
    writeFileAtomic(dest, d.buf);
    pfpPaths[id] = "personal_data/" + fname;
  }
  // carry forward pfps saved in a previous run that weren't re-uploaded
  if (cfg.pfps) for (const id of Object.keys(cfg.pfps)) if (!pfpPaths[id]) pfpPaths[id] = cfg.pfps[id];

  // per-group name + photo: { convId: { name, photo } }. Each group keeps its own.
  // photo may be a fresh data URL (→ saved to a per-group file) or an existing
  // personal_data/ path to carry forward. Previous groups not re-submitted are kept.
  const gcOut = Object.assign({}, gcPrev);
  for (const cid of Object.keys(gcIn)) {
    // SECURITY: cid is an attacker-controllable JSON key on the unauthenticated,
    // local POST /api/identity (body.gc). "__proto__" is special-cased on plain
    // objects — `gcOut[cid] = {...}` below would otherwise invoke the inherited
    // accessor setter and repoint gcOut's own [[Prototype]] instead of adding a
    // "__proto__" entry (classic prototype-pollution shape). Skip it outright.
    if (cid === "__proto__") continue;
    const entry = gcIn[cid] || {};
    const name = entry.name != null ? String(entry.name) : ((gcOut[cid] && gcOut[cid].name) || "");
    let photo = (gcOut[cid] && gcOut[cid].photo) || "";
    const d = gcData[cid];
    if (d) {
      // Named group → group_<groupname>_pfp.<ext>; unnamed → gc-<cid>.<ext>.
      // The group_ prefix keeps a group and a person of the same name apart (SP-19).
      const base = pfpFileName(name ? "group " + name : "", "gc-" + cid, d.ext, taken);
      taken.add(base);
      const fname = "pfps/" + base;
      // Defense in depth: cid is untrusted; only write inside personal_data/pfps/.
      const dest = path.join(PERSONAL, fname);
      if (isInsidePersonal(dest, pfpsDir)) {
        writeFileAtomic(dest, d.buf);
        photo = "personal_data/" + fname;
      }
    } else if (typeof entry.photo === "string" && entry.photo && !entry.photo.startsWith("data:")) {
      photo = entry.photo;
    }
    gcOut[cid] = { name, photo };
  }

  // SP-18: me "" clears it; me missing / null means "unchanged".
  const me = body.me === "" ? null : body.me ? String(body.me) : (cfg.me || null);

  // participants the user deleted in the wizard (LOCAL_IGNORED_USERS hides them
  // in the app now; cfg.ignoredUsers drops them from a future merge-aware build).
  const ignoredUsers = Array.isArray(body.ignoredUsers)
    ? body.ignoredUsers.map(String)
    : (Array.isArray(cfg.ignoredUsers) ? cfg.ignoredUsers : []);

  // whole group chats the user removed (LOCAL_IGNORED_GROUPS hides them in the
  // app now; cfg.ignoredGroups drops them from a future merge-aware build).
  const ignoredGroups = Array.isArray(body.ignoredGroups)
    ? body.ignoredGroups.map(String)
    : (Array.isArray(cfg.ignoredGroups) ? cfg.ignoredGroups : []);

  // persist into config (so a later rebuild keeps identity) …
  cfg.me = me; cfg.gc = gcOut; cfg.names = names; cfg.pfps = pfpPaths;
  cfg.ignoredUsers = ignoredUsers;
  cfg.ignoredGroups = ignoredGroups;
  delete cfg.gcName; delete cfg.gcPhoto;   // migrated to per-group cfg.gc
  saveConfig(cfg);

  // … and write the app-facing local.js
  const out =
    "/* personal_data/local.js — generated by the setup wizard. Gitignored. */\n" +
    "window.LOCAL_NAMES = " + JSON.stringify(names, null, 2) + ";\n" +
    "window.LOCAL_PFPS = " + JSON.stringify(pfpPaths, null, 2) + ";\n" +
    "window.LOCAL_ME = " + JSON.stringify(me) + ";\n" +
    "window.LOCAL_GC = " + JSON.stringify(gcOut, null, 2) + ";\n" +
    "window.LOCAL_IGNORED_USERS = " + JSON.stringify(ignoredUsers, null, 2) + ";\n" +
    "window.LOCAL_IGNORED_GROUPS = " + JSON.stringify(ignoredGroups, null, 2) + ";\n";
  writeFileAtomic(path.join(PERSONAL, "local.js"), out);
  const reply = { ok: true, names: Object.keys(names).length, pfps: Object.keys(pfpPaths).length, ignored: ignoredUsers.length, rebuilt: false };

  // SP-14: "Remove" promises exclusion, not just hiding — when the removed
  // groups / people changed, rebuild data.js without them and delete media
  // no message references any more. (Un-removing rebuilds from the copied
  // export and restores pruned media from the original media folder.)
  const changed = !sameIdSet(ignoredBefore.users, ignoredUsers) || !sameIdSet(ignoredBefore.groups, ignoredGroups);
  if (changed && cfg.sourceJs && fs.existsSync(path.join(PERSONAL, "data.js"))) {
    const mediaDir = cfg.mediaDir ? path.resolve(cfg.mediaDir) : path.join(PERSONAL, "media");
    const mediaInside = isInsidePersonal(mediaDir, PERSONAL);
    // Fix round 1 (#3): who owned each file about to be dropped, from the
    // archive as it is now (the rebuild removes that knowledge).
    const ownerCols = duringBlocking(() => foldBuilt(() => [createOwnersCollector(ignoredGroups, ignoredUsers)]));
    const owners = ownerCols ? ownerCols[0].result() : new Map();
    const quarantine = listQuarantine();
    if (mediaInside) {
      // Media whose group / person is no longer removed comes back from the
      // quarantine first; anything else missing from the original media folder,
      // except what is still quarantined.
      const stillRemoved = (o) => (o.kind === "group" ? ignoredGroups.includes(o.id) : o.kind === "person" ? ignoredUsers.includes(o.id) : false);
      for (const [name, o] of quarantine) {
        if (stillRemoved(o)) continue;
        if (moveFile(o.file, path.join(mediaDir, name))) quarantine.delete(name);
      }
      if (cfg.mediaSourceDir && fs.existsSync(cfg.mediaSourceDir)) {
        // SP7 (SP6 review #5): the same message-id filter as the first copy —
        // only media of this export's messages that are no longer removed.
        try {
          duringBlocking(() => {
            const { keep } = exportMessageIds(asList(cfg.sourceJs).map((p) => (path.isAbsolute(p) ? p : path.join(ROOT, p))), ignoredGroups, ignoredUsers);
            copyMediaFlat(cfg.mediaSourceDir, mediaDir, { skipExisting: true, skip: new Set(quarantine.keys()), ids: keep });
          });
        } catch (e) { console.error("Couldn't restore media from " + cfg.mediaSourceDir + ": " + (e && e.message)); }
      }
    }
    const built = runBuild();
    if (!built.ok) {
      return sendJSON(res, 422, { error: "Your names and photos were saved, but the archive couldn't be rebuilt without the removed chats/people: " + built.error, log: built.log });
    }
    let removed = 0;
    const after = duringBlocking(() => foldBuilt(() => [createReferencedNames(), createMessageCounter()]));
    if (after && mediaInside && fs.existsSync(mediaDir)) {
      // Media no message references any more is MOVED to
      // personal_data/.removed/<group|person>/<id>/ — never deleted — so
      // un-removing brings it back even if the original export folder is gone.
      const keep = after[0].result();
      for (const e of fs.readdirSync(mediaDir, { withFileTypes: true })) {
        if (!e.isFile() || keep.has(e.name)) continue;
        const o = owners.get(e.name.split("-")[0]) || quarantine.get(e.name) || { kind: "other", id: "unreferenced" };
        if (moveFile(path.join(mediaDir, e.name), path.join(REMOVED, o.kind, safeSegment(o.id), e.name))) removed++;
      }
    }
    Object.assign(reply, { rebuilt: true, mediaRemoved: removed, totalMsgs: after ? after[1].result() : 0 });
  }
  sendJSON(res, 200, reply);
}

/* ---- endpoint: what would removing these take out? (fix round 1, #3) ------ */
// Read-only: the wizard asks before a save that removes more, with real counts.
function apiRemovalPreview(body, res) {
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  const make = () => [createRemovalCounter(list(body && body.ignoredGroups), list(body && body.ignoredUsers))];
  const cols = duringBlocking(() => foldBuilt(make)) || make();
  sendJSON(res, 200, cols[0].result());
}

/* ---- endpoint: has a build already happened? ----------------------------- */
// Lets the wizard render its locked state on load (source files can't be changed
// once built — only Start over clears it) and prefill the group list, plus any
// identity already saved (names/me/pfps) so reopening the wizard shows it
// instead of appearing to have never been filled in.
function apiStatus(res) {
  const sum = duringBlocking(() => readSummary());
  const cfg = loadConfig();
  const groups = groupsOf(sum);
  sendJSON(res, 200, {
    built: !!sum,
    groups,
    ignoredGroups: Array.isArray(cfg.ignoredGroups) ? cfg.ignoredGroups : [],
    // fix round 1 (#4): the wizard must know who is already removed, or its
    // next save un-removes them
    ignoredUsers: Array.isArray(cfg.ignoredUsers) ? cfg.ignoredUsers : [],
    me: cfg.me ?? null,
    names: cfg.names || {},
    pfps: cfg.pfps || {},
  });
}

/* ---- endpoint: wipe personal_data/ to start setup over -------------------- */
// Deletes the wizard's output so the user can rebuild from a clean slate. Every
// path is checked through isInsidePersonal() first, so it can NEVER touch a file
// outside personal_data/ (and never the separate personal_data.REAL backup).
function apiReset(res) {
  const targets = ["config.json", "data.js", "data.js.bak", "local.js", "source", "media", "pfps", ".removed"];
  const removed = [];
  // fix round 1 (#9): backups of a source change interrupted mid-build
  if (fs.existsSync(PERSONAL)) for (const f of fs.readdirSync(PERSONAL)) if (PREV_DIR_RE.test(f)) targets.push(f);
  for (const name of targets) {
    const p = path.join(PERSONAL, name);
    if (!isInsidePersonal(p, PERSONAL)) continue;   // hard guard — never outside personal_data/
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(name); }
  }
  // SP-9: a write interrupted by a crash can leave "<target>.<pid>.<hex>.tmp"
  // beside its target — it holds the same private data, so erase it too.
  if (fs.existsSync(PERSONAL)) {
    for (const f of fs.readdirSync(PERSONAL)) {
      if (!/^(?:config\.json|data\.js|local\.js)\./.test(f) || !TMP_RE.test(f)) continue;
      const p = path.join(PERSONAL, f);
      if (isInsidePersonal(p, PERSONAL)) fs.rmSync(p, { force: true });
    }
  }
  fs.mkdirSync(PERSONAL, { recursive: true });   // leave an empty personal_data/ behind
  sendJSON(res, 200, { ok: true, removed });
}

/* ---- static file serving (allowlisted; see isServablePath) --------------- */
function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Allow": "GET, HEAD" });
    return res.end("method not allowed");
  }
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); }
  catch (e) { res.writeHead(400); return res.end("bad path"); }
  if (p === "/") p = "/index.html";
  // Allowlist gate BEFORE any fs access: only app assets + the identity files
  // the wizard writes may be served, so personal_data/config.json, .../source/,
  // .git/, scripts/, tests/, docs/, node_modules/ etc. never leave localhost
  // even though they live under ROOT alongside the app. See isServablePath's
  // own comment for the exact allow/deny shape.
  if (!isServablePath(p)) { res.writeHead(404); return res.end("not found"); }
  // QA-2/SP-16: with the isolation switch on, the two ROOT-level real-data
  // overrides are never read from disk at all — treated exactly like a missing
  // optional override (empty 200) regardless of what actually sits at
  // ROOT/data.js or ROOT/names.local.js. GCA_PERSONAL alone does not stop these
  // two paths from resolving to ROOT (see builtArchiveFiles' own ROOT fallback
  // above, which this same switch also disables), so a spawned test server
  // must set GCA_NO_ROOT_FALLBACK=1 to be fully isolated from a legacy root
  // export sitting in the checkout it happens to run from.
  if (NO_ROOT_FALLBACK && (p === "/data.js" || p === "/names.local.js")) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end("");
  }
  // /personal_data/... is served from PERSONAL (which GCA_PERSONAL can redirect
  // to a throwaway dir for tests) rather than literally ROOT/personal_data, so
  // local.js/media/pfps resolve to wherever this run's identity actually lives.
  // Everything else is served from ROOT, unchanged.
  const isPersonal = p === "/personal_data" || p.startsWith("/personal_data/");
  const base = isPersonal ? PERSONAL : ROOT;
  const rel = isPersonal ? p.slice("/personal_data".length) || "/" : p;
  const file = path.resolve(base, "." + rel.replace(/\\/g, "/"));
  const outside = path.relative(base, file);
  if (outside === "" || outside.startsWith("..") || path.isAbsolute(outside)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // A missing optional real-data override (data.js / local.js probes) gets an
      // empty 200 instead of a 404 so the served console stays clean; the app keeps
      // the bundled sample. Everything else that is missing is a genuine 404.
      if (OPTIONAL_OVERRIDES.has(p)) { res.writeHead(200, { "Content-Type": "application/javascript" }); return res.end(""); }
      res.writeHead(404); return res.end("not found");
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    // For HTML files served from the server, inject the server URL so client code
    // can use it instead of hardcoding localhost and the port.
    const isHtmlFile = type === "text/html" && (p === "/index.html" || p === "/setup.html");
    // SP-22: a <meta> CSP can't say frame-ancestors, so send it (and the older
    // X-Frame-Options) as real headers: no other site may frame these pages to
    // trick a click on Build, Save or Start over. The page's own meta CSP
    // still carries the rest of the policy (and works over file:// too).
    const frameGuard = type === "text/html" ? { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } : {};
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) { res.writeHead(416); return res.end("invalid range"); }
      let start;
      let end;
      if (m[1] === "" && m[2] !== "") {
        const suffix = parseInt(m[2], 10);
        start = Math.max(st.size - suffix, 0);
        end = st.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end("range not satisfiable");
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        ...frameGuard,
        "Content-Type": type, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
        "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else if (isHtmlFile) {
      // Read HTML, inject server URL config, send modified version
      fs.readFile(file, "utf8", (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end("internal server error");
        }
        const serverUrl = "http://" + HOST + ":" + PORT;
        // The page ships a strict `script-src 'self'` CSP (defense-in-depth). This
        // server-injected config is the one inline script we add, so give it a
        // per-response nonce and add that nonce to the page's own CSP so it (and
        // ONLY it) is allowed to run. Over file:// there is no server, no
        // injection, and no nonce — the static `script-src 'self'` stands alone.
        const nonce = crypto.randomBytes(16).toString("base64");
        const injectedData = data
          // Add the nonce to the page's script-src, anchored INSIDE the CSP
          // meta's content="..." so a stray "script-src 'self'" in a comment
          // can't be matched instead of the real directive.
          .replace(
            /(content="[^"]*?script-src 'self')/,
            "$1 'nonce-" + nonce + "'"
          )
          .replace(
            "</head>",
            `<script nonce="${nonce}">window.GCA_SERVER_URL="${serverUrl}";` +
              // SP-11: only the setup wizard gets the picker token
              (p === "/setup.html" ? `window.GCA_TOKEN="${PICKER_TOKEN}";` : "") + `</script>\n</head>`
          );
        const body = Buffer.from(injectedData, "utf8");
        res.writeHead(200, {
          ...frameGuard,
          "Content-Type": type,
          "Content-Length": body.length,
          "Cache-Control": "no-store",   // carries this run's token; never reuse a stale copy
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(body);
      });
    } else {
      res.writeHead(200, { ...frameGuard, "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

// State-changing routes (writes to disk or spawns a blocking native dialog) —
// these get the Origin/Referer CSRF check on top of the universal Host check.
// The two picker GETs are included even though they're GETs: they freeze the
// event loop with a blocking native dialog, so a cross-origin page spamming
// them is a DoS + dialog-spoofing vector, not a harmless read.
const GUARDED = new Set(["/api/reset", "/api/source", "/api/identity", "/api/removal-preview", "/api/pick-file", "/api/pick-folder", "/api/bye"]);
// SP-11: the pickers additionally need this per-process token, which only
// setup.html receives (injected into its HTML). Random per start, held in
// memory only: never logged, printed or written to disk.
const PICKERS = new Set(["/api/pick-file", "/api/pick-folder"]);
const PICKER_TOKEN = crypto.randomBytes(32).toString("hex");

const server = http.createServer(async (req, res) => {
  const [url, qs] = req.url.split("?");
  try {
    // Loopback Host allowlist — every request, before any routing. Blocks DNS
    // rebinding (an attacker domain resolving to 127.0.0.1 still sends its own
    // name in Host) and any request that didn't actually target this server.
    if (!isAllowedHost(req.headers.host, PORT)) return sendJSON(res, 403, { error: "forbidden host" });
    // CSRF guard on state-changing routes: a cross-origin fetch() always
    // carries a browser-set Origin (unspoofable from page JS), so a PRESENT
    // foreign Origin/Referer is the attack signal; same-origin requests never
    // send one for a same-origin no-CORS call, so absence stays allowed.
    if (GUARDED.has(url) && !isAllowedOrigin(req.headers.origin, req.headers.referer, PORT)) {
      return sendJSON(res, 403, { error: "forbidden origin" });
    }
    if (PICKERS.has(url) && !isPickerRequestAllowed(req.headers, PICKER_TOKEN, PORT)) {
      return sendJSON(res, 403, { error: "forbidden" });
    }
    if (req.method === "GET" && url === "/api/ping") { notePing(clientIdOf(qs)); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "POST" && url === "/api/bye") { live.bye(clientIdOf(qs)); req.resume(); res.writeHead(204); return res.end(); }
    if (req.method === "GET" && url === "/api/pick-file") { const which = /(?:^|&)for=headers(?:&|$)/.test(qs || "") ? "headers" : "group"; return sendJSON(res, 200, pickReply(nativePick("file", which))); }
    if (req.method === "GET" && url === "/api/pick-folder") return sendJSON(res, 200, pickReply(nativePick("folder", /(?:^|&)for=root(?:&|$)/.test(qs || "") ? "root" : "media")));
    if (req.method === "POST" && url === "/api/source") return apiSource(await readBody(req, res), res);
    if (req.method === "GET" && url === "/api/parts") { const g = /(?:^|&)group=([^&]*)/.exec(qs || ""); return apiParts(res, g ? decodeURIComponent(g[1]) : ""); }
    if (req.method === "POST" && url === "/api/identity") return apiIdentity(await readBody(req, res), res);
    if (req.method === "POST" && url === "/api/removal-preview") return apiRemovalPreview(await readBody(req, res), res);
    if (req.method === "GET" && url === "/api/status") return apiStatus(res);
    if (req.method === "POST" && url === "/api/reset") return apiReset(res);
  } catch (e) {
    // SP-17: one plain sentence for the user (no "EPERM: operation not
    // permitted, copyfile …" or stack); the full error stays in this console.
    if (!(e && e.statusCode)) console.error(e && e.stack || e);
    return sendJSON(res, e.statusCode || 500, { error: friendlyError(e) });
  }
  serveStatic(req, res);
});
// Bind errors (port already taken, permission denied) would otherwise throw an
// uncaught exception and dump a raw stack trace. Turn the common cases into a
// clear, actionable message and exit cleanly instead.
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      "\nPort " + PORT + " is already in use — the Group Chat Archive may already be running." +
      "\nOpen  http://" + HOST + ":" + PORT + "/setup.html  in your browser, or stop the other" +
      "\nprocess and try again. To use a different port, set GCA_PORT (e.g. GCA_PORT=9000).");
  } else if (err && err.code === "EACCES") {
    console.error(
      "\nCan't bind to port " + PORT + " — permission denied." +
      "\nPick a port above 1024 with GCA_PORT (e.g. GCA_PORT=9000) and try again.");
  } else {
    console.error("\nServer failed to start: " + (err && err.message || err));
  }
  process.exit(1);
});
// Only actually bind + listen when this file is run directly (`node
// scripts/server.js`), never when it's require()d — e.g. by tests that want
// copyMediaFlat() in-process. `server.on("error", ...)` above is a harmless
// registration either way, so it's left outside the guard.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    // GCA_PORT=0 asks the OS to pick a free port; server.address().port is the
    // ONLY way to learn what it actually bound. Reassign PORT here, before the
    // startup message (which tests parse — see server-port-zero.test.js) or any
    // request is handled — the Host-allowlist/CSRF checks above close over this
    // same `let` binding, so they immediately see the real port too.
    PORT = server.address().port;
    const setupUrl = "http://" + HOST + ":" + PORT + "/setup.html";
    console.log(
      "Group Chat Archive running at  http://" + HOST + ":" + PORT +
      "\nFirst-run setup:               " + setupUrl +
      "\nPress Ctrl+C to stop.");
    // `--open` (used by the double-click start-setup launchers) pops the wizard in
    // the default browser. A failed open must never crash the server.
    if (process.argv.includes("--open")) {
      try {
        const { cmd, args } = openerCommand(process.platform, setupUrl);
        spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      } catch (e) { /* ignore — the URL is printed above */ }
    }
  });
}

module.exports = { copyMediaFlat };
