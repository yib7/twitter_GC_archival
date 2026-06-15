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
 *   POST /api/source    point at raw .js + media → write config, copy media, build
 *   GET  /api/parts     participants + link-free sample messages + shared media
 *   POST /api/identity  names / pfps / GC photo / "this is you" → write local.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");        // project root (this script lives in scripts/)
const PERSONAL = path.join(ROOT, "personal_data");
const CONFIG = path.join(PERSONAL, "config.json");
const PORT = 8765;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".svg": "image/svg+xml",
};

/* ---- small helpers ------------------------------------------------------- */
const X_LINK = /(?:https?:\/\/)?(?:t\.co|(?:[\w-]+\.)?twitter\.com|(?:[\w-]+\.)?x\.com)\//i;
const IMG = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VID = new Set(["mp4", "mov", "webm", "m4v"]);
const kindOf = (p) => { const e = String(p).split(".").pop().toLowerCase(); return IMG.has(e) ? "img" : VID.has(e) ? "vid" : "file"; };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); } chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
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
  return { buf: Buffer.from(m[2], "base64"), ext };
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
  const sourceJs = (Array.isArray(body.sourceJs) ? body.sourceJs : []).map((p) => String(p).trim()).filter(Boolean);
  if (!sourceJs.length) return sendJSON(res, 400, { error: "Provide at least one source .js path." });
  const missing = sourceJs.filter((p) => !fs.existsSync(path.isAbsolute(p) ? p : path.join(ROOT, p)));
  if (missing.length) return sendJSON(res, 400, { error: "Source file(s) not found: " + missing.join(", ") });

  const mediaDirIn = body.mediaDir ? String(body.mediaDir).trim() : "";
  let mediaCopied = 0;
  const cfg = loadConfig();

  // Copy the source export(s) into personal_data/source/ so ALL private data
  // lives under personal_data/ (the export is just as private as the messages).
  const srcDir = path.join(PERSONAL, "source");
  fs.mkdirSync(srcDir, { recursive: true });
  cfg.sourceJs = sourceJs.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    const destRel = "personal_data/source/" + path.basename(abs);
    const dest = path.join(ROOT, destRel);
    if (path.resolve(abs) !== path.resolve(dest)) fs.copyFileSync(abs, dest);
    return destRel;
  });
  if (mediaDirIn) {
    const abs = path.isAbsolute(mediaDirIn) ? mediaDirIn : path.join(ROOT, mediaDirIn);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sendJSON(res, 400, { error: "Media folder not found: " + mediaDirIn });
    const dest = path.join(PERSONAL, "media");
    mediaCopied = copyMediaFlat(abs, dest);
    cfg.mediaDir = "personal_data/media";
  }
  saveConfig(cfg);

  // run the build (it reads personal_data/config.json and writes personal_data/data.js)
  let buildLog = "";
  try { buildLog = execFileSync(process.execPath, [path.join(__dirname, "build.js")], { cwd: ROOT }).toString(); }
  catch (e) { return sendJSON(res, 500, { error: "Build failed: " + (e.stderr ? e.stderr.toString() : e.message) }); }

  const data = readBuiltData();
  const groups = (data && data.conversations || []).map((c) => ({ id: c.id, title: c.title, count: c.count }));
  const totalMsgs = groups.reduce((s, g) => s + (g.count || 0), 0);
  sendJSON(res, 200, { ok: true, mediaCopied, groups, totalMsgs, log: buildLog.trim() });
}

/* ---- endpoint: participants for the naming step -------------------------- */
function apiParts(res) {
  const data = readBuiltData();
  if (!data) return sendJSON(res, 400, { error: "No built data yet — complete step 1 first." });
  const map = new Map();
  for (const c of (data.conversations || [])) {
    for (const m of (c.msgs || [])) {
      let p = map.get(m.s);
      if (!p) { p = { id: m.s, count: 0, samples: [], _seen: new Set(), media: [] }; map.set(m.s, p); }
      p.count++;
      const t = (m.x || "").trim();
      if (t.length > 14 && !/^https?:/.test(t) && !X_LINK.test(t) && p.samples.length < 40) {
        const k = t.toLowerCase();
        if (!p._seen.has(k)) { p._seen.add(k); p.samples.push(t); }
      }
      if (m.m && p.media.length < 6) p.media.push({ m: m.m, k: m.k || kindOf(m.m) });
    }
  }
  const parts = [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map((p) => ({
      id: p.id, count: p.count,
      samples: p.samples.sort((a, b) => b.length - a.length).slice(0, 10),
      media: p.media,
    }));
  sendJSON(res, 200, { parts });
}

/* ---- endpoint: save names / pfps / GC photo / "this is you" --------------- */
function apiIdentity(body, res) {
  fs.mkdirSync(path.join(PERSONAL, "pfps"), { recursive: true });
  const cfg = loadConfig();
  const names = body.names && typeof body.names === "object" ? body.names : {};
  const pfpPaths = {};

  // participant pfps (data URLs → files)
  const pfps = body.pfps && typeof body.pfps === "object" ? body.pfps : {};
  for (const id of Object.keys(pfps)) {
    const d = decodeDataUrl(pfps[id]);
    if (!d) continue;
    const fname = "pfps/" + id + "." + d.ext;
    fs.writeFileSync(path.join(PERSONAL, fname), d.buf);
    pfpPaths[id] = "personal_data/" + fname;
  }
  // carry forward pfps saved in a previous run that weren't re-uploaded
  if (cfg.pfps) for (const id of Object.keys(cfg.pfps)) if (!pfpPaths[id]) pfpPaths[id] = cfg.pfps[id];

  // group photo
  let gcPhotoPath = cfg.gcPhoto || "";
  const gc = decodeDataUrl(body.gcPhoto);
  if (gc) { const fname = "pfps/gc." + gc.ext; fs.writeFileSync(path.join(PERSONAL, fname), gc.buf); gcPhotoPath = "personal_data/" + fname; }

  const me = body.me ? String(body.me) : (cfg.me || null);
  const gcName = body.gcName != null ? String(body.gcName) : (cfg.gcName || "");

  // persist into config (so a later rebuild keeps identity) …
  cfg.me = me; cfg.gcName = gcName; cfg.gcPhoto = gcPhotoPath; cfg.names = names; cfg.pfps = pfpPaths;
  saveConfig(cfg);

  // … and write the app-facing local.js
  const out =
    "/* personal_data/local.js — generated by the setup wizard. Gitignored. */\n" +
    "window.LOCAL_NAMES = " + JSON.stringify(names, null, 2) + ";\n" +
    "window.LOCAL_PFPS = " + JSON.stringify(pfpPaths, null, 2) + ";\n" +
    "window.LOCAL_ME = " + JSON.stringify(me) + ";\n" +
    "window.LOCAL_GC = " + JSON.stringify({ name: gcName, photo: gcPhotoPath }) + ";\n";
  fs.writeFileSync(path.join(PERSONAL, "local.js"), out);
  sendJSON(res, 200, { ok: true, names: Object.keys(names).length, pfps: Object.keys(pfpPaths).length });
}

/* ---- static file serving (unchanged behavior) ---------------------------- */
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = parseInt(s, 10) || 0;
      const end = e ? parseInt(e, 10) : st.size - 1;
      res.writeHead(206, {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
  });
}

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (req.method === "POST" && url === "/api/source") return apiSource(await readBody(req), res);
    if (req.method === "GET" && url === "/api/parts") return apiParts(res);
    if (req.method === "POST" && url === "/api/identity") return apiIdentity(await readBody(req), res);
  } catch (e) {
    return sendJSON(res, 500, { error: String(e && e.message || e) });
  }
  serveStatic(req, res);
}).listen(PORT, () => console.log(
  "Group Chat Archive running at  http://localhost:" + PORT +
  "\nFirst-run setup:               http://localhost:" + PORT + "/setup.html" +
  "\nPress Ctrl+C to stop."));
