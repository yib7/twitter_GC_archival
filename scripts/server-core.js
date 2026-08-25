/*
 * server-core.js — pure, side-effect-free helpers for the setup server.
 *
 * Kept separate from server.js (which opens a listening socket on require) so
 * these can be unit-tested in isolation, mirroring the build.js / build-core.js
 * split.
 */
"use strict";

const path = require("path");

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
function mergeNames(prev, posted) {
  const out = {};
  for (const src of [asNamesMap(prev), asNamesMap(posted)]) {
    for (const k of Object.keys(src)) { if (k !== "__proto__") out[k] = src[k]; }
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
// under --open). Browser heartbeats (GET /api/ping) call ping(). Server-initiated
// blocking work — the native file/folder pickers and the build — runs via a
// synchronous execFileSync that FREEZES the event loop, so heartbeats can't arrive
// while a picker dialog is open; that frozen stretch must never be mistaken for the
// browser going away. enter()/leave() bracket such work: while busy the watchdog
// holds off, and leave() refreshes the heartbeat so the idle clock restarts from
// when the blocking call finished (we were actively serving the user) rather than
// from the now-stale ping taken before it began. `clock` is injectable for tests.
function makeLiveness(idleMs, clock) {
  const now = clock || Date.now;
  let lastPing = 0;
  let busy = 0;
  return {
    ping() { lastPing = now(); },
    enter() { busy++; },
    leave() { if (busy > 0) busy--; lastPing = now(); },
    isBusy() { return busy > 0; },
    // Exit only when the browser has genuinely gone quiet: never before the first
    // heartbeat, and never while a blocking call is still in flight.
    shouldExit() { return busy === 0 && lastPing !== 0 && isIdleTimedOut(lastPing, now(), idleMs); },
  };
}

module.exports = { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames, isServablePath, SERVABLE_EXACT, OPTIONAL_OVERRIDES, isAllowedHost, isAllowedOrigin };
