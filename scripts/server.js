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
const { execFileSync, spawn } = require("child_process");
const { collectParticipants } = require("./build-core.js");
const { dialogFilter, pfpFileName, isInsidePersonal, openerCommand, makeLiveness, mergeNames, isServablePath } = require("./server-core.js");

const ROOT = path.resolve(__dirname, "..");     // project root (this script lives in scripts/)
// GCA_PERSONAL mirrors build.js's env override: point identity storage at a
// throwaway directory so tests can exercise real save/reload persistence
// without ever touching the real personal_data/. Unset in normal use.
const PERSONAL = process.env.GCA_PERSONAL ? path.resolve(process.env.GCA_PERSONAL) : path.join(ROOT, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");
const PORT = process.env.GCA_PORT ? Number(process.env.GCA_PORT) : 8765;
const HOST = "127.0.0.1";

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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_JSON_BODY) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
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
function saveConfig(cfg) {
  fs.mkdirSync(PERSONAL, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
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
function copyMediaFlat(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { fs.copyFileSync(full, path.join(destDir, e.name)); n++; }
    }
  })(srcDir);
  return n;
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
  for (const f of [path.join(PERSONAL, "data.js"), path.join(ROOT, "data.js")]) {
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
  if (!fs.existsSync(groupAbs)) return sendJSON(res, 400, { error: "Messages file not found: " + groupJs });
  if (!fs.existsSync(headersAbs)) return sendJSON(res, 400, { error: "Headers file not found: " + headersJs });
  if (!fs.existsSync(mediaAbs) || !fs.statSync(mediaAbs).isDirectory()) return sendJSON(res, 400, { error: "Media folder not found: " + mediaDirIn });

  const cfg = loadConfig();

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
  cfg.sourceJs = [copyInto(groupAbs)];   // message bodies (build parses these)
  cfg.headersJs = copyInto(headersAbs);  // metadata only (roster + events)

  // media is required → always copied
  const mediaDestDir = path.join(PERSONAL, "media");
  const mediaCopied = copyMediaFlat(mediaAbs, mediaDestDir);
  cfg.mediaDir = mediaDestDir;
  saveConfig(cfg);

  // run the build (it reads personal_data/config.json and writes personal_data/data.js)
  let buildLog;
  try { buildLog = duringBlocking(() => execFileSync(process.execPath, [path.join(__dirname, "build.js")], { cwd: ROOT })).toString(); }
  catch (e) { return sendJSON(res, 500, { error: "Build failed: " + (e.stderr ? e.stderr.toString() : e.message) }); }

  const data = readBuiltData();
  const groups = (data && data.conversations || []).map((c) => ({ id: c.id, title: c.title, count: c.count }));
  const totalMsgs = groups.reduce((s, g) => s + (g.count || 0), 0);
  sendJSON(res, 200, { ok: true, mediaCopied, groups, totalMsgs, log: buildLog.trim() });
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
  const pfps = body.pfps && typeof body.pfps === "object" ? body.pfps : {};
  for (const id of Object.keys(pfps)) {
    const d = decodeDataUrl(pfps[id]);
    if (!d) continue;
    const base = pfpFileName(names[id], id, d.ext, taken);
    taken.add(base);
    const fname = "pfps/" + base;
    fs.writeFileSync(path.join(PERSONAL, fname), d.buf);
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
    const entry = gcIn[cid] || {};
    const name = entry.name != null ? String(entry.name) : ((gcOut[cid] && gcOut[cid].name) || "");
    let photo = (gcOut[cid] && gcOut[cid].photo) || "";
    const d = decodeDataUrl(entry.photo);
    if (d) {
      // Named group → <groupname>_pfp.<ext>; unnamed → gc-<cid>.<ext> fallback.
      const base = pfpFileName(name, "gc-" + cid, d.ext, taken);
      taken.add(base);
      const fname = "pfps/" + base;
      fs.writeFileSync(path.join(PERSONAL, fname), d.buf);
      photo = "personal_data/" + fname;
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
  fs.writeFileSync(path.join(PERSONAL, "local.js"), out);
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
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
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
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

http.createServer(async (req, res) => {
  const [url, qs] = req.url.split("?");
  try {
    if (req.method === "GET" && url === "/api/ping") { notePing(); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "GET" && url === "/api/pick-file") { const which = /(?:^|&)for=headers(?:&|$)/.test(qs || "") ? "headers" : "group"; const p = nativePick("file", which); return sendJSON(res, 200, { path: p == null ? "" : p, supported: p !== null }); }
    if (req.method === "GET" && url === "/api/pick-folder") { const p = nativePick("folder"); return sendJSON(res, 200, { path: p == null ? "" : p, supported: p !== null }); }
    if (req.method === "POST" && url === "/api/source") return apiSource(await readBody(req), res);
    if (req.method === "GET" && url === "/api/parts") { const g = /(?:^|&)group=([^&]*)/.exec(qs || ""); return apiParts(res, g ? decodeURIComponent(g[1]) : ""); }
    if (req.method === "POST" && url === "/api/identity") return apiIdentity(await readBody(req), res);
    if (req.method === "GET" && url === "/api/status") return apiStatus(res);
    if (req.method === "POST" && url === "/api/reset") return apiReset(res);
  } catch (e) {
    return sendJSON(res, e.statusCode || 500, { error: String(e && e.message || e) });
  }
  serveStatic(req, res);
}).listen(PORT, HOST, () => {
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
