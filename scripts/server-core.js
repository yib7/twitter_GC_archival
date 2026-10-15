/*
 * server-core.js — pure, side-effect-free helpers for the setup server.
 *
 * Kept separate from server.js (which opens a listening socket on require) so
 * these can be unit-tested in isolation, mirroring the build.js / build-core.js
 * split.
 */
"use strict";

const path = require("path");
const { foldConversations } = require("./build-core.js");

// True only when `target` resolves to a location STRICTLY inside `root` (a
// descendant) — false for `root` itself, a parent, a sibling, or any path that
// escapes via "..". The reset endpoint checks every path through this before
// deleting, so a bug or crafted input can never reach outside personal_data/.
function isInsidePersonal(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Build a native Windows OpenFileDialog filter string for the wizard pickers.
// `which` is "headers" or "group" (anything else → group). The headers glob is
// spelling-agnostic ("*group-headers*.js") because X names that file with the
// singular "message" (direct-message-group-headers.js) while exports/tools
// sometimes use the plural — both must show up in the picker.
function dialogFilter(which) {
  if (which === "headers") {
    return "Group headers (*group-headers*.js)|*group-headers*.js" +
      "|JavaScript (*.js)|*.js|All files (*.*)|*.*";
  }
  return "Group messages (direct-messages-group*.js)|direct-messages-group*.js" +
    "|JavaScript (*.js)|*.js|All files (*.*)|*.*";
}

// Lowercase a display name into a filename-safe slug: any run of characters that
// isn't a-z/0-9 becomes a single underscore; leading/trailing underscores are
// trimmed. Returns "" for empty/blank input.
function sanitizeName(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Pick the on-disk filename for a saved photo. A named person/group becomes
// `<slug>_pfp.<ext>` (easy to find later); an unnamed one keeps the opaque id
// (`<id>.<ext>`). `taken` is a Set of filenames already chosen in this save, so
// two people with the same name don't clobber each other — the later one gets a
// short id suffix.
// SECURITY: `id` is an attacker-controllable JSON key on the unauthenticated,
// local POST /api/identity (body.pfps / body.gc). It is NEVER trusted as a path
// — even the no-name fallback runs it through sanitizeName() so a crafted id
// like "../../evil" can't smuggle "/" or ".." into the filename and escape
// personal_data/pfps/. (apiIdentity also containment-checks the resolved path.)
function pfpFileName(name, id, ext, taken) {
  const slug = sanitizeName(name);
  if (!slug) return (sanitizeName(id) || "pfp") + "." + ext;
  const base = slug + "_pfp";
  let file = base + "." + ext;
  if (taken && taken.has(file)) {
    const id4 = (sanitizeName(String(id)).replace(/^_+/, "").slice(-4)) || "x";
    file = base + "-" + id4 + "." + ext;
    let n = 2;
    while (taken && taken.has(file)) { file = base + "-" + id4 + "-" + n + "." + ext; n++; }
  }
  return file;
}

// Merge posted names over previously saved ones so a partial save (or a save
// with no names typed at all) never wipes out names assigned in an earlier
// wizard run — the same carry-forward behavior pfps/me/gc already get.
// Returns a fresh object; `prev`/`posted` are never mutated. Non-plain-object
// arguments (null, undefined, strings, arrays, ...) are treated as {}.
function asNamesMap(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
// SECURITY: `posted` is attacker-controllable JSON (body.names on the
// unauthenticated, local POST /api/identity). Object.assign({}, ...) copies
// via ordinary [[Set]], so a "__proto__" key — a normal OWN data property on
// an object JSON.parse produced, not the special object-literal syntax —
// would invoke the inherited accessor setter and repoint the merged object's
// own [[Prototype]] instead of adding a "__proto__" entry (classic
// prototype-pollution shape). Skip that one key explicitly rather than
// relying on Object.assign's default copy semantics.
// a posted empty / blank name is the explicit "forget this name"
// signal and deletes the id; an id missing from the post is left unchanged.
function mergeNames(prev, posted) {
  const out = {};
  const p = asNamesMap(prev), q = asNamesMap(posted);
  for (const k of Object.keys(p)) { if (k !== "__proto__") out[k] = p[k]; }
  for (const k of Object.keys(q)) {
    if (k === "__proto__") continue;
    if (typeof q[k] === "string" && !q[k].trim()) delete out[k];
    else out[k] = q[k];
  }
  return out;
}

// Allowlist gate for serveStatic: true only for URL paths the app actually
// needs served. Everything else 404s BEFORE any filesystem access, so
// personal_data/config.json, personal_data/source/**, .git/**, scripts/**,
// tests/**, docs/**, node_modules/**, and any other file under ROOT stay
// unreachable over HTTP even though the traversal guard would otherwise let
// same-directory reads through. `urlPath` is the decoded, query-stripped
// pathname (e.g. "/src/app.js") — a string, not a filesystem path. Per that
// contract there is no legitimate "?"/"#" left in it, so the ".." scan runs
// on the WHOLE string rather than truncating at the first "?"/"#": serveStatic
// strips the query from the RAW url before decoding, so an encoded "%3F"/"%23"
// survives that split and decodes into a literal "?"/"#" inside the pathname —
// scanning only up to it would drop every ".." segment that follows while the
// allow-check and serveStatic's downstream path.resolve still see the full
// string. A literal ".." segment anywhere (split on "/" or "\") is rejected
// outright rather than resolved; serveStatic's existing path.resolve +
// relative() traversal guard still runs beneath this call, unchanged, as
// defense in depth.
const SERVABLE_EXACT = new Set(["/", "/index.html", "/setup.html", "/favicon.ico", "/data.sample.js", "/data.js", "/names.local.js", "/personal_data/data.js", "/personal_data/local.js"]);
const SERVABLE_PREFIXES = ["/src/", "/lib/", "/sample_media/", "/personal_data/media/", "/personal_data/pfps/"];
// The real-data overrides index.html probes with `<script src=... onerror>`. They
// are gitignored, so on a clean clone / before setup they are absent and a plain
// 404 prints a console error on every served load. Serving an empty 200 for a
// MISSING one keeps the served console clean (the app harmlessly keeps the bundled
// data.sample.js). A present file is served normally, unchanged. (Over file:// there
// is no server to intercept, so those file-not-found lines are inherent to the
// zero-setup double-click mode — this only cleans `npm start`.) Keep in sync with
// the `<script>` probe list in index.html — asserted by server-core.test.js.
const OPTIONAL_OVERRIDES = new Set(["/data.js", "/personal_data/data.js", "/names.local.js", "/personal_data/local.js"]);
function isServablePath(urlPath) {
  const p = String(urlPath == null ? "" : urlPath);
  // A decoded NUL (or any control char) is never a legitimate served path.
  // Reject it here so serveStatic 404s before fs.stat(), which throws
  // synchronously on a NUL-byte path (ERR_INVALID_ARG_VALUE). serveStatic runs
  // outside the request handler's try/catch, so that throw would otherwise
  // surface as an unhandledRejection and crash the whole local server. (A
  // codepoint scan, not a regex, to stay clear of eslint's no-control-regex.)
  for (let i = 0; i < p.length; i++) { if (p.charCodeAt(i) < 32) return false; }
  if (p.split(/[\\/]/).includes("..")) return false;
  if (SERVABLE_EXACT.has(p)) return true;
  return SERVABLE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// Loopback hostname allowlist shared by isAllowedHost (raw Host header) and
// isAllowedOrigin (parsed Origin/Referer URL). Bracket-stripped and lowercased
// before the lookup, so it matches both "::1" (out of parseHostHeader, which
// already strips brackets) and "[::1]" (the WHATWG URL API's own .hostname
// serialization for IPv6, which KEEPS the brackets) with one definition.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
function isLoopbackHostname(hostname) {
  const h = String(hostname == null ? "" : hostname).toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return LOOPBACK_HOSTNAMES.has(h);
}

// Parse a raw `Host` request-header value into { hostname, port } (port is
// `null` when absent), or `null` when the header is missing/empty. Handles the
// three shapes we actually need to tell apart:
//   "host"          → { hostname: "host", port: null }
//   "host:port"      → { hostname: "host", port: Number(port) }   (exactly one colon, numeric tail)
//   "[v6]" / "[v6]:port" → bracketed IPv6, the only unambiguous way to combine
//                          a literal IPv6 address (which itself contains colons)
//                          with a port
// A bare, unbracketed multi-colon string (an IPv6 literal with no brackets,
// which is not valid per RFC 3986/7230 but could still arrive from a
// non-browser client) is returned as-is with no port guessed, rather than
// mis-splitting on the wrong colon — it will simply fail the loopback-name
// check downstream since it won't equal "::1".
// A MALFORMED bracket (a "[" or "]" present but the full bracketed form above
// doesn't match — e.g. "[::1" with no closing "]") is rejected outright
// (return null → 403). Otherwise it would fall through to the bare-string
// branch and, because isLoopbackHostname() strips a stray leading "[", "[::1"
// would normalize to "::1" and be wrongly ALLOWED. Brackets are only ever
// legitimate in the fully-matched "[v6]"/"[v6]:port" form, so any other
// bracket is a malformed/hostile Host header.
function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return null;
  const s = hostHeader.trim();
  if (!s) return null;
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(s);
  if (bracketed) return { hostname: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : null };
  if (s.includes("[") || s.includes("]")) return null;   // unmatched bracket → malformed, reject
  const firstColon = s.indexOf(":");
  const lastColon = s.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(s.slice(lastColon + 1))) {
    return { hostname: s.slice(0, lastColon), port: Number(s.slice(lastColon + 1)) };
  }
  return { hostname: s, port: null };
}

// Loopback Host-header allowlist, checked on EVERY request (server.js does this
// first, before routing). The Host header's hostname must be one of our
// loopback names; if it carries a port, that port must equal ours. This is
// what stops DNS rebinding: an attacker's DNS name can be made to resolve to
// 127.0.0.1, but the browser still sends that attacker name (not "127.0.0.1")
// in the Host header, so checking the NAME (not the IP the socket connected
// to) is what catches it. A missing/malformed Host header is rejected, not
// treated as "no opinion" — legitimate requests (browser or the loopback
// smoke/e2e tests) always send one.
function isAllowedHost(hostHeader, port) {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed || !isLoopbackHostname(parsed.hostname)) return false;
  return parsed.port == null || parsed.port === port;
}

// Does `urlString` (an Origin or Referer header value) parse as our own
// loopback origin on `port`? Used only by isAllowedOrigin below. Any parse
// failure (missing scheme, garbage text, etc.) is a reject, never a throw.
function isOwnLoopbackUrl(urlString, port) {
  let u;
  try { u = new URL(urlString); } catch (e) { return false; }
  if (u.protocol !== "http:") return false;
  if (!isLoopbackHostname(u.hostname)) return false;
  const p = u.port ? Number(u.port) : 80;
  return p === port;
}

// CSRF guard for state-changing routes only (server.js applies this after
// isAllowedHost, and only to the guarded route set). A same-origin, non-CORS
// GET — and any non-browser client (curl, the native app talking to itself)
// — never sets Origin or Referer, so their absence must be ALLOWED. But a
// cross-origin browser request always carries an Origin the page itself
// cannot spoof or suppress, so any PRESENT value must match our own loopback
// origin; Referer is the fallback when Origin is absent (older browsers /
// some same-site navigations omit Origin on GETs but still send Referer).
// Origin takes priority over Referer when both are present.
function isAllowedOrigin(originHeader, refererHeader, port) {
  if (typeof originHeader === "string" && originHeader) return isOwnLoopbackUrl(originHeader, port);
  if (typeof refererHeader === "string" && refererHeader) return isOwnLoopbackUrl(refererHeader, port);
  return true;
}

// The command + args to open `url` in the platform's default browser, used by the
// `--open` launcher flag so a double-clicked start-setup script pops the wizard.
function openerCommand(platform, url) {
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

// True when the browser heartbeat has been silent longer than `idleMs` — the
// launcher uses this to shut the server down once the last tab is closed.
function isIdleTimedOut(lastPing, now, idleMs) {
  return (now - lastPing) > idleMs;
}

// Liveness tracker for the launcher's auto-exit watchdog (server.js arms it only
// under --open), so closing the browser also closes the command window.
//
// silence is NOT a close signal — Chromium throttles timers in hidden
// tabs to about one a minute, sleeping tabs / Memory Saver / a laptop lid stop
// them entirely, and the old "6 s without a ping" rule shut the server down
// under a user who had only switched tabs. Each open page pings with its own
// client id and says goodbye (sendBeacon /api/bye) on pagehide; the server
// exits `graceMs` after the LAST open page said goodbye (a reload or a step
// from the wizard to the archive pings again well inside the grace), or after
// `idleMs` with no contact at all (a killed browser never says goodbye).
//
// Server-initiated blocking work — the native pickers and the build — freezes
// the event loop, so nothing can arrive meanwhile; enter()/leave() bracket it,
// the watchdog holds off while busy, and leave() restarts the clocks.
// `clock` is injectable for tests.
function makeLiveness(opts, clock) {
  const o = opts || {};
  const graceMs = o.graceMs != null ? o.graceMs : 20000;
  const idleMs = o.idleMs != null ? o.idleMs : 30 * 60 * 1000;
  const now = clock || Date.now;
  const clients = new Set();
  let lastContact = 0;   // 0 = no page has ever connected
  let byeAt = 0;         // when the last open page said goodbye (0 = pages still open)
  let busy = 0;
  return {
    ping(id) {
      clients.add(String(id == null ? "" : id));
      lastContact = now(); byeAt = 0;
    },
    bye(id) {
      clients.delete(String(id == null ? "" : id));
      if (lastContact === 0) return;
      lastContact = now();
      if (clients.size === 0) byeAt = now();
    },
    enter() { busy++; },
    leave() {
      if (busy > 0) busy--;
      if (lastContact !== 0) { lastContact = now(); if (byeAt) byeAt = now(); }
    },
    isBusy() { return busy > 0; },
    openPages() { return clients.size; },
    shouldExit() {
      if (busy > 0 || lastContact === 0) return false;
      if (byeAt && isIdleTimedOut(byeAt, now(), graceMs)) return true;
      return isIdleTimedOut(lastContact, now(), idleMs);
    },
  };
}

/* ---- plain-language failures ------------------------------- */
// A failed build (scripts/build.js) prints ONE "BUILD ERROR: <sentence>" line
// meant for the user. Show exactly that; never raw stderr, which can hold a
// native stack trace (an out-of-memory crash) and private paths.
function buildFailureMessage(stderr) {
  const s = String(stderr == null ? "" : stderr);
  const m = /^BUILD ERROR: (.+)$/m.exec(s);
  if (m) return m[1].trim();
  if (/heap out of memory|Reached heap limit|Allocation failed|ERR_STRING_TOO_LONG|Invalid string length/i.test(s)) {
    return "The build ran out of memory — your export is very large. Close other programs and try again.";
  }
  return "The build stopped unexpectedly. The server window has the technical details.";
}
// Node fs errors (EPERM on a junction, ENOSPC mid-copy, ...) as one plain
// sentence. Errors we raise ourselves with a statusCode are already written
// for the user and pass through unchanged.
function friendlyError(e) {
  if (!e) return "Something went wrong.";
  if (e.statusCode && e.message) return String(e.message);
  if (e.userMessage) return String(e.userMessage);   // fs-io: a file held by another program
  const where = e.path ? " (“" + path.basename(String(e.path)) + "”)" : "";
  switch (e.code) {
    case "ENOENT": return "A file or folder couldn't be found" + where + ". Check the path and try again.";
    case "EPERM":
    case "EACCES": return "Access was denied" + where + ". Close any program using it, or move the archive out of a protected folder, and try again.";
    case "EBUSY": return "A file is in use by another program" + where + " — antivirus or a sync app? Wait a moment and try again.";
    case "ENOSPC": return "The disk is full. Free up some space and try again.";
    case "EISDIR": return "Expected a file but found a folder" + where + ".";
    case "ENOTDIR": return "Expected a folder but found a file" + where + ".";
    case "EMFILE":
    case "ENFILE": return "Too many files are open at once. Close some programs and try again.";
    default: return "Something went wrong: " + String(e.message || e).split(/\r?\n/)[0];
  }
}

/* ---- what may be copied in as group media ------------------------- */
// X names group-DM media "<messageId>-<random>.<ext>"; nothing else in an
// export (account.js, tweets, 1:1 DM media folders) looks like that.
const MEDIA_FILE_RE = /^\d+-[^/\\]+\.(?:jpe?g|png|gif|webp|mp4|mov|m4v|webm)$/i;
// Why a picked folder (its own name + the names inside it) is clearly NOT the
// group media folder, or null when it may be. Called only after the caller
// looked for a direct_messages_group_media folder inside it.
function mediaFolderProblem(dirName, names) {
  const n = String(dirName || "");
  if (/^direct_messages_media$/i.test(n)) {
    return "“" + n + "” is the media from your 1:1 direct messages, not your group chats. Pick the direct_messages_group_media folder next to it.";
  }
  if (/^data$/i.test(n) || (names || []).some((f) => /\.js$/i.test(f))) {
    return "“" + n + "” looks like your archive's data folder (it holds .js export files), not the group media folder. " +
      "Pick the direct_messages_group_media folder inside it — the archive never copies your other private files.";
  }
  return null;
}

/* ---- a heap sized to the machine for the build -------------------- */
// The build streams the export files, but it still holds every message of the
// archive at once. Node's default heap (~2-4 GB) is the limit that crashed big
// archives; give the build about half the RAM, never less than 2 GB (Node's
// usual default) and never more than 16 GB.
function buildHeapMb(totalBytes) {
  const half = Math.floor(Number(totalBytes) / 2 / 1048576);
  if (!Number.isFinite(half)) return 2048;
  return Math.min(16384, Math.max(2048, half));
}
function buildNodeArgs(buildJs, totalBytes) {
  return ["--max-old-space-size=" + buildHeapMb(totalBytes), buildJs];
}

/* ---- who may open a native file dialog ---------------------------- */
// The picker GETs freeze the server behind a blocking dialog, so they need
// more than the Origin/Referer check: an <img referrerpolicy="no-referrer">
// on any web page sends neither header. They also need the per-process token
// the server writes into setup.html (a custom header, so a cross-origin page
// would need a CORS preflight the server never grants), and — when the
// browser says where the request came from — it must be this very origin.
function isPickerRequestAllowed(headers, token, port) {
  const h = headers || {};
  const got = typeof h["x-gca-token"] === "string" ? h["x-gca-token"] : "";
  if (!token || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(String(token));
  if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) return false;
  const site = h["sec-fetch-site"];
  if (typeof site === "string" && site && site !== "same-origin" && site !== "none") return false;
  return isAllowedOrigin(h.origin, h.referer, port);
}

/* ---- paths as people actually paste them -------------------------- */
// Explorer's "Copy as path" wraps the path in double quotes; macOS / Linux
// users type ~/Downloads/... or paste a Terminal-escaped "My\ Archive". Undo
// all three (one matching pair of quotes; a leading ~ or ~/; backslash-space
// off Windows, where backslash is the path separator instead).
function normalizeUserPath(raw, opts) {
  const o = opts || {};
  let s = String(raw == null ? "" : raw).trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  if (o.platform !== "win32") s = s.replace(/\\ /g, " ");
  if (o.home && (s === "~" || /^~[\\/]/.test(s))) s = String(o.home).replace(/[\\/]+$/, "") + s.slice(1);
  return s;
}
// The "not found" hint: what a full path looks like on this platform.
function pathNotFoundHint(platform, name) {
  const ex = platform === "win32" ? "C:\\Users\\you\\Downloads\\twitter-\u2026\\data\\" + name
    : (platform === "darwin" ? "/Users/you" : "/home/you") + "/Downloads/twitter-\u2026/data/" + name;
  return "Paste the full path, e.g. " + ex;
}

/* ---- which copied media files the archive still uses --------------- */
// each of these is a collector — message(conv, msg) per message,
// conversation(conv) once per conversation (msgs excluded), result() — so the
// server folds them over a STREAMED data.js (fs-io foldArchive) and never
// holds the archive's message bodies. The data-object forms below fold the
// same collectors over an in-memory archive.
const fold = (data, col) => foldConversations(data, [col])[0].result();

// The file names (basenames) every message's m / mx[].m points at.
function createReferencedNames() {
  const out = new Set();
  const add = (p) => { if (typeof p === "string" && p) out.add(p.split("/").pop()); };
  return {
    message(c, m) {
      add(m.m);
      if (Array.isArray(m.mx)) for (const x of m.mx) add(x && x.m);
    },
    conversation() {},
    result() { return out; },
  };
}
function referencedMediaNames(data) { return fold(data, createReferencedNames()); }
// What removing these groups / people would take out of the
// built archive (`data` already excludes anything removed earlier, so this
// counts only what is newly removed). A person's messages count in every group.
function createRemovalCounter(ignoredGroups, ignoredUsers) {
  const G = new Set((ignoredGroups || []).map(String)), U = new Set((ignoredUsers || []).map(String));
  let messages = 0, media = 0, groups = 0;
  const people = new Set();
  const files = (m) => (m.m ? 1 : 0) + (Array.isArray(m.mx) ? m.mx.filter((x) => x && x.m).length : 0);
  return {
    message(c, m) {
      const wholeGroup = G.has(String(c.id));
      if (U.has(String(m.s))) people.add(String(m.s));
      if (!wholeGroup && !U.has(String(m.s))) return;
      messages++;
      media += files(m);
    },
    conversation(c) {
      if (G.has(String(c.id))) groups++;
      for (const id of c.participants || []) if (U.has(String(id))) people.add(String(id));
    },
    result() { return { messages, media, groups, people: people.size }; },
  };
}
function removalPreview(data, ignoredGroups, ignoredUsers) { return fold(data, createRemovalCounter(ignoredGroups, ignoredUsers)); }
// Who a media file belonged to, for the quarantine folder
// personal_data/.removed/<kind>/<id>/ — by message id, from the archive as it
// was BEFORE the rebuild that drops them. Only messages being removed are mapped.
function createOwnersCollector(ignoredGroups, ignoredUsers) {
  const G = new Set((ignoredGroups || []).map(String)), U = new Set((ignoredUsers || []).map(String));
  const out = new Map();
  return {
    message(c, m) {
      if (!m.m && !m.mx) return;
      if (G.has(String(c.id))) out.set(String(m.i), { kind: "group", id: String(c.id) });
      else if (U.has(String(m.s))) out.set(String(m.i), { kind: "person", id: String(m.s) });
    },
    conversation() {},
    result() { return out; },
  };
}
function removedMediaOwners(data, ignoredGroups, ignoredUsers) { return fold(data, createOwnersCollector(ignoredGroups, ignoredUsers)); }
// the total number of messages (for replies after a rebuild).
function createMessageCounter() {
  let n = 0;
  return { message() { n++; }, conversation() {}, result() { return n; } };
}
// A folder-name-safe form of an id (ids are digits; anything else is replaced).
function safeSegment(s) { return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_"; }
// True when the removed groups / people differ between two saves (order-free).
function sameIdSet(a, b) {
  const x = new Set((Array.isArray(a) ? a : []).map(String)), y = new Set((Array.isArray(b) ? b : []).map(String));
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

/* ---- room on disk for the copy ------------------------------------ */
// The wizard copies the export and every media file into personal_data/; a
// full disk mid-copy used to surface as a raw ENOSPC. Check first. Unknown
// free space (NaN) never blocks.
function diskSpaceProblem(needBytes, freeBytes) {
  if (!Number.isFinite(freeBytes) || !Number.isFinite(needBytes) || freeBytes >= needBytes) return null;
  const fmt = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1048576)) + " MB";
  return "Not enough free disk space to copy your archive: it needs about " + fmt(needBytes) + " and the disk has " + fmt(freeBytes) +
    " free. Free up some space (or move the Group Chat Archive folder to a bigger drive) and try again.";
}

/* ---- the pre-flight preview's words --------------------------------- */
const qn = (f) => "“" + String(f) + "”";
const fmtN = (n) => Number(n).toLocaleString("en-US");
const plural = (n, one, many) => fmtN(n) + " " + (n === 1 ? one : many);
// What finding the export in the archive folder noticed, as one plain sentence
// (null when there's nothing to say). Every note carries its own text so the
// wizard never has to word them.
function sourceNoteText(n) {
  const files = (list) => (list || []).map((f) => qn(typeof f === "string" ? f : f.file)).join(", ");
  switch (n && n.code) {
    case "manifest-missing": return "The archive's manifest lists files that aren't in the folder: " + files(n.files) + ". The archive may not have unzipped completely — their messages will be missing.";
    case "manifest-extra": return "Also included " + files(n.files) + ": in the archive's data folder, though its manifest doesn't list " + (n.files.length === 1 ? "it" : "them") + ".";
    case "manifest-unsafe": return "Ignored " + plural(n.files.length, "path", "paths") + " in the archive's manifest that point outside the folder you picked.";
    case "manifest-unreadable": return "The archive's manifest couldn't be read, so its files were found by their names instead.";
    case "manifest-no-groups": return "The archive's manifest lists no group chats, so its files were found by their names instead.";
    case "skipped-files": return "Skipped " + files(n.files) + ": empty, or not a group chat file.";
    case "no-headers": return "No group headers file was found, so people who never sent a message won't be listed.";
    case "no-media": return "No group media folder was found, so no photos or videos will be copied.";
    case "dm-file": return "Your 1:1 direct messages are left out — only group chats are imported.";
    default: return null;
  }
}
const withText = (n) => Object.assign({}, n, { text: sourceNoteText(n) });
/**
 * The pre-flight warnings, each { code, text } — in the order the user should
 * read them. `p`: { swapped, notes, missingParts: [file names], survey
 * (createExportSurvey().result()), media: { unmatched } | null, merge:
 * { overlap } | null }.
 */
function preflightWarnings(p) {
  const out = [];
  const add = (code, text, extra) => out.push(Object.assign({ code, text }, extra || {}));
  const sv = p.survey;
  if (sv.totals.messages === 0) add("zero-messages", "This export has no group chat messages to import" + (sv.removedMsgs ? " (every message is from a group chat or person you removed)" : "") + ". Check you picked the right archive.");
  if (p.swapped) add("swapped", "The messages and headers files were the other way round — they'll be swapped back automatically.");
  const missing = p.missingParts || [];
  if (missing.length) {
    const one = missing.length === 1;
    add("missing-parts", missing.map(qn).join(", ") + (one ? " is" : " are") + " missing from the export — the messages in " + (one ? "it" : "them") +
      " won't be imported. Re-extract the archive to get every part.", { files: missing });
  }
  for (const n of p.notes || []) {
    if (n.code === "dm-file" && sv.dm.conversations) continue;   // said with counts below
    const t = sourceNoteText(n);
    if (t) add(n.code === "manifest-missing" ? "missing-parts" : n.code, t, n.files ? { files: n.files } : null);
  }
  if (sv.dm.conversations) add("dm-ignored", plural(sv.dm.conversations, "1:1 conversation", "1:1 conversations") + " (" + plural(sv.dm.messages, "message", "messages") + ") will be left out — only group chats are imported.");
  if (p.media && p.media.unmatched) add("unmatched-media", plural(p.media.unmatched, "file", "files") + " in the media folder don't belong to any message in this export and won't be copied.");
  // an older download than the archive (or nothing new
  // in it at all): merging keeps the archive's newer copies, but say so first.
  const mg = p.merge;
  if (mg && ((Number.isFinite(mg.exportNewest) && Number.isFinite(mg.archiveNewest) && mg.exportNewest < mg.archiveNewest) || (mg.added === 0 && mg.overlap > 0))) {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    add("older-export", (Number.isFinite(mg.exportNewest) && Number.isFinite(mg.archiveNewest) && mg.exportNewest < mg.archiveNewest
      ? "This export is older than your archive: its newest message is from " + day(mg.exportNewest) + ", your archive's from " + day(mg.archiveNewest) + "."
      : "Everything in this export is already in your archive.") +
      " Merging only adds what's missing; messages your archive already has keep their newer text.");
  }
  if (p.merge && p.merge.overlap) add("overlap", plural(p.merge.overlap, "message is", "messages are") + " already in your archive; they'll be merged, not duplicated.");
  if (sv.removedMsgs) add("removed", plural(sv.removedMsgs, "message", "messages") + " from people or group chats you removed will stay out.");
  if (sv.badTime) add("bad-time", plural(sv.badTime, "message has", "messages have") + " a missing or unreadable date and will be skipped.");
  return out;
}

module.exports = { withText, preflightWarnings, createReferencedNames, createRemovalCounter, createOwnersCollector, createMessageCounter, removalPreview, removedMediaOwners, safeSegment, diskSpaceProblem, referencedMediaNames, sameIdSet, normalizeUserPath, pathNotFoundHint, isPickerRequestAllowed, buildHeapMb, buildNodeArgs, buildFailureMessage, friendlyError, MEDIA_FILE_RE, mediaFolderProblem, dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames, isServablePath, SERVABLE_EXACT, OPTIONAL_OVERRIDES, isAllowedHost, isAllowedOrigin };
