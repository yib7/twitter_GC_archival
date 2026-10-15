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
 *   POST /api/source    point at group .js + headers .js + media (all required)
 *                       → write config, copy sources + media, build
 *   GET  /api/parts     participants + link-free sample messages + shared media
 *   POST /api/identity  names / pfps / GC photo / "this is you" → write local.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const { collectParticipants, exportPartFiles, identifyExport, wrongKindMessage } = require("./build-core.js");
const { writeFileAtomic, readExportHead, TMP_RE } = require("./fs-io.js");
const { buildFailureMessage, friendlyError, dialogFilter, pfpFileName, isInsidePersonal, openerCommand, makeLiveness, mergeNames, isServablePath, OPTIONAL_OVERRIDES, isAllowedHost, isAllowedOrigin } = require("./server-core.js");

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
// Served pages send a heartbeat (GET /api/ping); when it goes quiet, we exit.
const AUTO_EXIT = process.argv.includes("--open");
const IDLE_MS = 6000;
const live = makeLiveness(IDLE_MS);
let idleWatch = null;
function notePing() {
  live.ping();
  if (AUTO_EXIT && !idleWatch) {   // arm the watchdog once the browser first connects
    idleWatch = setInterval(() => {
      if (live.shouldExit()) {
        console.log("Browser closed — shutting down.");
        process.exit(0);
      }
    }, 2000);
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
        reject(httpError(413, "Request body is too large."));
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
function decodeDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "img";
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw httpError(413, "Uploaded images must be 10 MB or smaller.");
  return { buf, ext };
}
// Flattens srcDir's tree into destDir by basename. Two files sharing a
// basename in different source subfolders would otherwise silently clobber
// (last-write-wins, data loss with no signal) — instead, keep the first one
// encountered and count the rest as skipped so the caller can warn.
function copyMediaFlat(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const taken = new Set();
  let copied = 0, skipped = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (taken.has(e.name)) { skipped++; }   // duplicate basename → keep first, don't clobber
      else { fs.copyFileSync(full, path.join(destDir, e.name)); taken.add(e.name); copied++; }
    }
  })(srcDir);
  return { copied, skipped };
}
// Open a native Windows file/folder picker and return the chosen absolute path.
// `which` ("group" | "headers") only tailors the file dialog's title + filter —
// the values are constant strings we control, so there's no injection risk.
// Returns "" on cancel, or null when unsupported (non-Windows / no PowerShell)
// so the caller can tell the user to type the path instead.
function nativePick(kind, which) {
  if (process.platform !== "win32") return null;
  let ps;
  if (kind === "folder") {
    // Use the SAME modern file dialog as the .js pickers (FolderBrowserDialog is
    // the old tree-view style, which looks inconsistent). The user opens any file
    // inside their media folder and we return that file's parent directory.
    const title = "Open ANY file inside your direct_messages_group_media folder";
    ps = "Add-Type -AssemblyName System.Windows.Forms;$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title='" + title + "';$d.Filter='All files (*.*)|*.*';$d.Multiselect=$false;if($d.ShowDialog($o) -eq 'OK'){[Console]::Out.Write([System.IO.Path]::GetDirectoryName($d.FileName))};$o.Dispose()";
  } else {
    const headers = which === "headers";
    const title = headers ? "Select direct-message-group-headers.js" : "Select direct-messages-group.js";
    const filter = dialogFilter(which);
    ps = "Add-Type -AssemblyName System.Windows.Forms;$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Filter='" + filter + "';$d.Multiselect=$false;$d.Title='" + title + "';if($d.ShowDialog($o) -eq 'OK'){[Console]::Out.Write($d.FileName)};$o.Dispose()";
  }
  try {
    return duringBlocking(() => execFileSync("powershell.exe", ["-STA", "-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true })).trim();
  } catch (e) { return null; }
}

function readBuiltData() {
  const candidates = NO_ROOT_FALLBACK
    ? [path.join(PERSONAL, "data.js")]
    : [path.join(PERSONAL, "data.js"), path.join(ROOT, "data.js")];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const s = fs.readFileSync(f, "utf8").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
      return JSON.parse(s);
    } catch (e) { /* try next */ }
  }
  return null;
}

/* ---- endpoint: point at source + build ----------------------------------- */
function apiSource(body, res) {
  // All three pieces of the group export are required.
  const groupJs = body.groupJs ? String(body.groupJs).trim() : "";
  const headersJs = body.headersJs ? String(body.headersJs).trim() : "";
  const mediaDirIn = body.mediaDir ? String(body.mediaDir).trim() : "";
  if (!groupJs) return sendJSON(res, 400, { error: "Choose your direct-messages-group.js file." });
  if (!headersJs) return sendJSON(res, 400, { error: "Choose your direct-message-group-headers.js file." });
  if (!mediaDirIn) return sendJSON(res, 400, { error: "Choose your direct_messages_group_media folder." });

  const absOf = (p) => path.resolve(path.isAbsolute(p) ? p : path.join(ROOT, p));
  const groupAbs = absOf(groupJs), headersAbs = absOf(headersJs), mediaAbs = absOf(mediaDirIn);
  // SP-1 / SP-17: check what was picked BEFORE copying anything, so a wrong,
  // empty or missing file gets one plain sentence and nothing is half-written.
  const fileProblem = (abs, typed, role, expected) => {
    let st;
    try { st = fs.statSync(abs); } catch (e) { return role + " not found: " + typed; }
    if (st.isDirectory()) return "The " + role.toLowerCase() + " you chose is a folder, not a file: " + typed + ". Pick the .js file inside it.";
    if (!st.isFile()) return "The " + role.toLowerCase() + " you chose isn't a regular file: " + typed;
    return wrongKindMessage(identifyExport(readExportHead(abs)), expected, path.basename(abs));
  };
  const groupBad = fileProblem(groupAbs, groupJs, "Messages file", "messages");
  if (groupBad) return sendJSON(res, 400, { error: groupBad });
  const headersBad = fileProblem(headersAbs, headersJs, "Headers file", "headers");
  if (headersBad) return sendJSON(res, 400, { error: headersBad });
  if (!fs.existsSync(mediaAbs) || !fs.statSync(mediaAbs).isDirectory()) return sendJSON(res, 400, { error: "Media folder not found: " + mediaDirIn });

  const cfg = loadConfig();
  const cfgBefore = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG) : null;

  // Copy every source into personal_data/source/ so ALL private data lives under
  // personal_data/ (the export is just as private as the messages).
  const srcDir = path.join(PERSONAL, "source");
  fs.mkdirSync(srcDir, { recursive: true });
  // Store absolute destinations (not "personal_data/…"-relative-to-ROOT) so this
  // works whether PERSONAL is the real ROOT/personal_data or a GCA_PERSONAL
  // override (tests) — build.js's own path resolution already accepts absolute
  // paths as-is, so no change needed there.
  const copyInto = (abs) => {
    const dest = path.join(srcDir, path.basename(abs));
    if (path.resolve(abs) !== path.resolve(dest)) fs.copyFileSync(abs, dest);
    return dest;
  };
  // SP-2: X splits big files into <name>.js, <name>-part1.js, …; picking any
  // one of them brings its whole family (in part order), so messages in
  // part1+ are never silently left behind.
  const groupFiles = partSiblings(groupAbs);
  const headerFiles = partSiblings(headersAbs);
  cfg.sourceJs = groupFiles.map(copyInto);   // message bodies (build parses these)
  const headerDests = headerFiles.map(copyInto);
  cfg.headersJs = headerDests.length === 1 ? headerDests[0] : headerDests;  // metadata only (roster + events)

  // media is required → always copied. Thousands of files can take a while to
  // copy synchronously, so bracket it in duringBlocking like the build below —
  // otherwise the auto-exit watchdog could mistake the frozen event loop for
  // the browser having closed.
  const mediaDestDir = path.join(PERSONAL, "media");
  const media = duringBlocking(() => copyMediaFlat(mediaAbs, mediaDestDir));
  if (media.skipped > 0) {
    console.warn("Skipped " + media.skipped + " media file(s) with a basename already used by another file — only the first of each was kept.");
  }
  cfg.mediaDir = mediaDestDir;
  saveConfig(cfg);

  // run the build (it reads personal_data/config.json and writes personal_data/data.js)
  let buildLog;
  // The log is shown in the wizard, so ask for plain text (an inherited
  // FORCE_COLOR would otherwise wrap every number in ANSI colour codes).
  const buildEnv = Object.assign({}, process.env, { NO_COLOR: "1" });
  delete buildEnv.FORCE_COLOR;
  // eslint-disable-next-line no-control-regex -- matching ESC is the point
  const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  try { buildLog = plain(duringBlocking(() => execFileSync(process.execPath, [path.join(__dirname, "build.js")], { cwd: ROOT, env: buildEnv, stdio: ["ignore", "pipe", "pipe"] }))); }
  catch (e) {
    // SP-1 / SP-17: the user gets build.js's one-sentence BUILD ERROR (never a
    // raw stack trace); the full stderr goes to this server's console only.
    const stderr = e.stderr ? plain(e.stderr) : String(e.message || e);
    console.error("Build failed:\n" + stderr.trim());
    // A failed build wrote no data.js; put config.json back the way it was so
    // the wizard isn't left pointing at the file that just failed.
    try {
      if (cfgBefore) writeFileAtomic(CONFIG, cfgBefore);
      else fs.rmSync(CONFIG, { force: true });
    } catch (err) { /* best effort — the next build overwrites it anyway */ }
    const error = buildFailureMessage(stderr);
    const log = ((e.stdout ? plain(e.stdout).trim() : "") + "\nBUILD ERROR: " + error).trim();
    return sendJSON(res, 422, { error, log });
  }

  const data = readBuiltData();
  const groups = (data && data.conversations || []).map((c) => ({ id: c.id, title: c.title, count: c.count }));
  const totalMsgs = groups.reduce((s, g) => s + (g.count || 0), 0);
  sendJSON(res, 200, { ok: true, mediaCopied: media.copied, mediaSkipped: media.skipped, groups, totalMsgs, partFiles: groupFiles.length, headerPartFiles: headerFiles.length, log: buildLog.trim() });
}
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
  const data = readBuiltData();
  if (!data) return sendJSON(res, 400, { error: "No built data yet — complete step 1 first." });
  sendJSON(res, 200, { parts: collectParticipants(data, group) });
}

/* ---- endpoint: save names / pfps / GC photo / "this is you" --------------- */
function apiIdentity(body, res) {
  fs.mkdirSync(path.join(PERSONAL, "pfps"), { recursive: true });
  const cfg = loadConfig();
  // Carry forward names from a previous save (like pfps/me/gc already do) —
  // otherwise reopening the wizard and saving with names untyped/unloaded
  // wipes out every name assigned in an earlier run.
  const names = mergeNames(cfg.names, body.names);
  const pfpPaths = {};

  // Reserve filenames already on disk (from a previous save) so a fresh upload
  // with the same name doesn't clobber them.
  const taken = new Set();
  if (cfg.pfps) for (const id of Object.keys(cfg.pfps)) { const bn = String(cfg.pfps[id]).split("/").pop(); if (bn) taken.add(bn); }

  // participant pfps (data URLs → files). Named people get <name>_pfp.<ext>;
  // unnamed people keep their opaque id, so the file is easy to relocate later.
  const pfpsDir = path.join(PERSONAL, "pfps");
  const pfps = body.pfps && typeof body.pfps === "object" ? body.pfps : {};
  for (const id of Object.keys(pfps)) {
    const d = decodeDataUrl(pfps[id]);
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
  const gcIn = body.gc && typeof body.gc === "object" ? body.gc : {};
  const gcOut = Object.assign({}, cfg.gc || {});
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
    const d = decodeDataUrl(entry.photo);
    if (d) {
      // Named group → <groupname>_pfp.<ext>; unnamed → gc-<cid>.<ext> fallback.
      const base = pfpFileName(name, "gc-" + cid, d.ext, taken);
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

  const me = body.me ? String(body.me) : (cfg.me || null);

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
  sendJSON(res, 200, { ok: true, names: Object.keys(names).length, pfps: Object.keys(pfpPaths).length, ignored: ignoredUsers.length });
}

/* ---- endpoint: has a build already happened? ----------------------------- */
// Lets the wizard render its locked state on load (source files can't be changed
// once built — only Start over clears it) and prefill the group list, plus any
// identity already saved (names/me/pfps) so reopening the wizard shows it
// instead of appearing to have never been filled in.
function apiStatus(res) {
  const data = readBuiltData();
  const cfg = loadConfig();
  const groups = (data && data.conversations || []).map((c) => ({ id: c.id, title: c.title, count: c.count }));
  sendJSON(res, 200, {
    built: !!data,
    groups,
    ignoredGroups: Array.isArray(cfg.ignoredGroups) ? cfg.ignoredGroups : [],
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
  const targets = ["config.json", "data.js", "local.js", "source", "media", "pfps"];
  const removed = [];
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
  // two paths from resolving to ROOT (see readBuiltData's own ROOT fallback
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
            `<script nonce="${nonce}">window.GCA_SERVER_URL="${serverUrl}";</script>\n</head>`
          );
        const body = Buffer.from(injectedData, "utf8");
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": body.length,
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(body);
      });
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
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
const GUARDED = new Set(["/api/reset", "/api/source", "/api/identity", "/api/pick-file", "/api/pick-folder"]);

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
    if (req.method === "GET" && url === "/api/ping") { notePing(); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "GET" && url === "/api/pick-file") { const which = /(?:^|&)for=headers(?:&|$)/.test(qs || "") ? "headers" : "group"; const p = nativePick("file", which); return sendJSON(res, 200, { path: p == null ? "" : p, supported: p !== null }); }
    if (req.method === "GET" && url === "/api/pick-folder") { const p = nativePick("folder"); return sendJSON(res, 200, { path: p == null ? "" : p, supported: p !== null }); }
    if (req.method === "POST" && url === "/api/source") return apiSource(await readBody(req, res), res);
    if (req.method === "GET" && url === "/api/parts") { const g = /(?:^|&)group=([^&]*)/.exec(qs || ""); return apiParts(res, g ? decodeURIComponent(g[1]) : ""); }
    if (req.method === "POST" && url === "/api/identity") return apiIdentity(await readBody(req, res), res);
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
