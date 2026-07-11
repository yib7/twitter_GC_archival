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
function mergeNames(prev, posted) {
  return Object.assign({}, asNamesMap(prev), asNamesMap(posted));
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

module.exports = { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames, isServablePath, SERVABLE_EXACT, OPTIONAL_OVERRIDES };
