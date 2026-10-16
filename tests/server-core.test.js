require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames, isServablePath, SERVABLE_EXACT, OPTIONAL_OVERRIDES, isAllowedHost, isAllowedOrigin } = require("../scripts/server-core.js");

// A controllable clock so elapsed time can be simulated deterministically.
function fakeClock(start) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

// X names the *headers* file with singular "message"
// (direct-message-group-headers.js) but the *messages* file with plural
// (direct-messages-group.js). The old picker filter used the plural spelling for
// headers, so the real file was hidden. A spelling-agnostic "*group-headers*.js"
// glob matches both.
test("headers filter matches both singular and plural header filenames", () => {
  const f = dialogFilter("headers");
  assert.ok(f.includes("*group-headers*.js"), "uses the spelling-agnostic glob");
  assert.ok(f.includes("All files"), "keeps an all-files fallback");
});

test("group-messages filter targets the messages file", () => {
  const f = dialogFilter("group");
  assert.ok(f.includes("direct-messages-group*.js"), "targets the messages file");
  assert.ok(f.includes("All files"), "keeps an all-files fallback");
});

test("sanitizeName lowercases and collapses non-alphanumerics to underscores", () => {
  assert.equal(sanitizeName("Alice B"), "alice_b");
  assert.equal(sanitizeName("Bob Smith!"), "bob_smith");
  assert.equal(sanitizeName("  A  B  "), "a_b");
  assert.equal(sanitizeName(""), "");
  assert.equal(sanitizeName("   "), "");
});

test("pfpFileName uses <name>_pfp.<ext> for named users", () => {
  assert.equal(pfpFileName("Alice B", "123", "png", new Set()), "alice_b_pfp.png");
});

test("pfpFileName falls back to the id when there's no name", () => {
  assert.equal(pfpFileName("", "123", "png", new Set()), "123.png");
  assert.equal(pfpFileName("   ", "123", "jpg", new Set()), "123.jpg");
});

test("pfpFileName suffixes on collision instead of overwriting", () => {
  const taken = new Set(["alice_pfp.png"]);
  const out = pfpFileName("Alice", "9999", "png", taken);
  assert.notEqual(out, "alice_pfp.png");
  assert.match(out, /^alice_pfp-\w+\.png$/);
});

// Security regression (path traversal → arbitrary file write): apiIdentity()
// writes participant/group photos to personal_data/pfps/<pfpFileName(...)>, and
// the id/cid fed into pfpFileName is an attacker-controllable JSON key on the
// unauthenticated, local POST /api/identity. The no-name fallback used to return
// `id + "." + ext` verbatim, so a crafted id like "../../evil" produced
// "pfps/../../evil.png" — a write escaping personal_data/ entirely. The filename
// must always be a single safe segment (no "/", "\", or ".."), and the resolved
// path must stay inside pfps/ (apiIdentity's isInsidePersonal guard, asserted here).
test("pfpFileName neutralizes a crafted id so it cannot escape pfps/", () => {
  const pfpsRoot = path.join(__dirname, "..", "personal_data", "pfps");
  const hostile = ["../../evil", "..\\..\\evil", "../../../../Users/x/startup/z", "/etc/passwd", "a/b/c", "..", "."];
  for (const badId of hostile) {
    const base = pfpFileName("", badId, "png", new Set());   // empty name → id fallback
    assert.ok(!/[\\/]/.test(base), `no path separators in ${JSON.stringify(base)} (from id ${JSON.stringify(badId)})`);
    assert.ok(!base.split(/[\\/]/).includes(".."), `no ".." segment in ${JSON.stringify(base)}`);
    const dest = path.join(pfpsRoot, base);
    assert.equal(isInsidePersonal(dest, pfpsRoot), true, `${JSON.stringify(badId)} → ${dest} must stay inside pfps/`);
  }
  // A normal numeric id is unchanged (opaque-id fallback still works).
  assert.equal(pfpFileName("", "123", "png", new Set()), "123.png");
});

test("isInsidePersonal only allows deletes strictly inside the personal_data root", () => {
  const root = path.join(__dirname, "..", "personal_data");
  assert.equal(isInsidePersonal(path.join(root, "config.json"), root), true);
  assert.equal(isInsidePersonal(path.join(root, "media", "x.png"), root), true);
  assert.equal(isInsidePersonal(root, root), false);                         // the root itself
  assert.equal(isInsidePersonal(path.join(root, ".."), root), false);        // parent
  assert.equal(isInsidePersonal(path.join(root, "..", "other"), root), false); // sibling escape
  assert.equal(isInsidePersonal("/etc/passwd", root), false);                // absolute outside
});

test("openerCommand picks the platform's default-browser opener", () => {
  assert.deepEqual(openerCommand("win32", "http://x/setup.html"), { cmd: "cmd", args: ["/c", "start", "", "http://x/setup.html"] });
  assert.deepEqual(openerCommand("darwin", "http://x/setup.html"), { cmd: "open", args: ["http://x/setup.html"] });
  assert.deepEqual(openerCommand("linux", "http://x/setup.html"), { cmd: "xdg-open", args: ["http://x/setup.html"] });
});

test("isIdleTimedOut is true only once the heartbeat gap exceeds the idle window", () => {
  assert.equal(isIdleTimedOut(1000, 1000 + 5000, 6000), false);  // 5s gap < 6s window
  assert.equal(isIdleTimedOut(1000, 1000 + 6000, 6000), false);  // exactly at the window: not yet
  assert.equal(isIdleTimedOut(1000, 1000 + 7000, 6000), true);   // 7s gap > 6s window
});

// The liveness rule replaced the old rule "exit after 6 s without a ping":
// Chromium throttles timers in hidden tabs to about one a minute and sleeping
// tabs / a laptop lid stop them entirely, so the launcher's server quit under
// a user who had only switched tabs. The close signal is now the page's own
// goodbye (sendBeacon /api/bye on pagehide) plus a short grace, with a long
// idle as the backstop. These tests replace the 6 s ones.
const GRACE = 5000, IDLE = 30 * 60 * 1000;

test("liveness never exits before the first heartbeat arrives", () => {
  const clock = fakeClock(0);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  clock.advance(IDLE * 2);                     // lots of time, but no ping ever seen
  assert.equal(live.shouldExit(), false);
});

test("liveness tolerates a throttled or frozen hidden tab: minutes of silence are not a close", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  live.ping("tab1");
  clock.advance(6 * 60 * 1000);                // a background tab pinging once a minute, or not at all
  assert.equal(live.shouldExit(), false);
  live.ping("tab1");
  clock.advance(IDLE - 1000);
  assert.equal(live.shouldExit(), false);
});

test("liveness exits a short grace after the last open page says goodbye", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  live.ping("tab1"); live.ping("tab2");
  live.bye("tab1");
  clock.advance(GRACE + 1000);
  assert.equal(live.shouldExit(), false, "another page is still open");
  live.bye("tab2");
  clock.advance(GRACE - 1000);
  assert.equal(live.shouldExit(), false, "still inside the grace");
  clock.advance(2000);
  assert.equal(live.shouldExit(), true, "the browser really went away");
});

test("a reload or a step to the archive page (bye, then a new page pings) does not exit", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  live.ping("setup");
  live.bye("setup");
  clock.advance(800);
  live.ping("archive");
  clock.advance(GRACE * 3);
  assert.equal(live.shouldExit(), false);
});

test("liveness still exits after the long idle when no goodbye ever came (browser killed)", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  live.ping("tab1");
  clock.advance(IDLE + 1000);
  assert.equal(live.shouldExit(), true);
});

// Regression: a native file picker runs execFileSync, which freezes the event
// loop so nothing can arrive while the dialog is open. The watchdog must not
// exit during it, and the clocks restart when it returns.
test("liveness does not exit during or right after a long native picker", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness({ graceMs: GRACE, idleMs: IDLE }, clock);
  live.ping("tab1");
  live.enter();                                // picker opens; event loop will freeze
  clock.advance(IDLE + 20000);                 // a very long stretch with no pings possible
  assert.equal(live.shouldExit(), false, "must not exit while a picker is open");
  live.leave();                                // picker returns
  assert.equal(live.shouldExit(), false, "must not exit immediately after the picker closes");
  live.bye("tab1");
  live.enter();
  clock.advance(GRACE * 2);
  assert.equal(live.shouldExit(), false, "busy wins over a goodbye too");
  live.leave();
  clock.advance(GRACE + 1000);
  assert.equal(live.shouldExit(), true, "the goodbye counts once the blocking call is done");
});

// Regression: apiIdentity used to set cfg.names = body.names verbatim, so
// reopening the wizard and saving with no names typed (or naming only one
// group's roster) wiped out every previously saved name. Names must carry
// forward exactly like pfps/me/gc already do.
test("mergeNames carries prev forward when posted is empty", () => {
  assert.deepEqual(mergeNames({ "1": "Alice" }, {}), { "1": "Alice" });
});

test("mergeNames lets posted values override the same id", () => {
  assert.deepEqual(mergeNames({ "1": "Alice" }, { "1": "Alicia" }), { "1": "Alicia" });
});

test("mergeNames keeps ids only in prev and adds ids only in posted", () => {
  assert.deepEqual(mergeNames({ "1": "Alice" }, { "2": "Bob" }), { "1": "Alice", "2": "Bob" });
});

test("mergeNames treats a missing/undefined prev as empty", () => {
  assert.deepEqual(mergeNames(undefined, { "1": "Alice" }), { "1": "Alice" });
});

test("mergeNames treats null/non-object posted as empty (prev survives)", () => {
  assert.deepEqual(mergeNames({ "1": "Alice" }, null), { "1": "Alice" });
  assert.deepEqual(mergeNames({ "1": "Alice" }, "not an object"), { "1": "Alice" });
  assert.deepEqual(mergeNames({ "1": "Alice" }, undefined), { "1": "Alice" });
});

test("mergeNames treats null/non-object prev as empty (posted survives)", () => {
  assert.deepEqual(mergeNames(null, { "1": "Alice" }), { "1": "Alice" });
  assert.deepEqual(mergeNames("not an object", { "1": "Alice" }), { "1": "Alice" });
});

// Arrays pass typeof === "object" but aren't a valid names map — merging one
// in verbatim would spray numeric-index keys ("0", "1", ...) into local.js.
test("mergeNames treats an array (prev or posted) as empty, not as index-keyed data", () => {
  assert.deepEqual(mergeNames({ "1": "Alice" }, ["x", "y"]), { "1": "Alice" });
  assert.deepEqual(mergeNames(["x", "y"], { "1": "Alice" }), { "1": "Alice" });
});

// a hand-edited config.json may hold a name that isn't text: it is ignored
// (dropped from the result), never a reason to refuse the save
test("mergeNames ignores a name that isn't text, saved or posted", () => {
  assert.deepEqual(mergeNames({ "1": null, "2": { a: 1 }, "3": 7, "4": "Ann" }, {}), { "4": "Ann" });
  assert.deepEqual(mergeNames({ "4": "Ann" }, { "4": null, "5": ["x"] }), { "4": "Ann" });
});

// clearing a name in the wizard posts "" for that id — the explicit
// "forget this name" signal (an id simply missing from the post still means
// "unchanged", so a partial save never wipes names).
test("mergeNames deletes an id posted with an empty (or blank) name", () => {
  assert.deepEqual(mergeNames({ "1": "Alice", "2": "Bob" }, { "1": "" }), { "2": "Bob" });
  assert.deepEqual(mergeNames({ "1": "Alice" }, { "1": "   " }), {});
  assert.deepEqual(mergeNames({}, { "3": "" }), {}, "clearing an unknown id adds nothing");
});

test("mergeNames never mutates its inputs", () => {
  const prev = { "1": "Alice" };
  const posted = { "1": "Alicia", "2": "Bob" };
  mergeNames(prev, posted);
  assert.deepEqual(prev, { "1": "Alice" });
  assert.deepEqual(posted, { "1": "Alicia", "2": "Bob" });
});

test("mergeNames returns a fresh object, not a reference to prev or posted", () => {
  const prev = { "1": "Alice" };
  const out = mergeNames(prev, {});
  assert.notEqual(out, prev);
});

// mergeNames' own `k !== "__proto__"` skip (server-core.js
// ~line 88) is the one thing standing between an attacker-controlled
// body.names and a polluted Object.prototype. Built via JSON.parse, not the
// `{ __proto__: ... }` object-literal syntax — a literal sets the object's
// real prototype (special-cased grammar) and would prove nothing here; only
// JSON.parse produces a genuine OWN "__proto__" data property, matching what
// an attacker's raw JSON POST body parses to server-side.
test("mergeNames drops a JSON-parsed own __proto__ key instead of repointing the result's prototype", () => {
  const posted = JSON.parse('{"__proto__": {"polluted": true}, "1": "Alice"}');
  const out = mergeNames({}, posted);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "mergeNames must not repoint its result's own [[Prototype]]");
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), false, "no own __proto__ data property either");
  assert.equal(out["1"], "Alice", "a legitimate sibling key in the same payload must still merge");
  assert.equal(({}).polluted, undefined, "global Object.prototype must remain unpolluted");
});

// isServablePath: the allowlist serveStatic consults BEFORE touching the
// filesystem. Real personal messages/config/media/source and repo internals
// (.git, scripts, tests, docs, node_modules) must never be reachable over
// HTTP even though they live under ROOT alongside the app assets.
test("isServablePath allows the app shell and its fixed top-level assets", () => {
  assert.equal(isServablePath("/"), true);
  assert.equal(isServablePath("/index.html"), true);
  assert.equal(isServablePath("/setup.html"), true);
  assert.equal(isServablePath("/favicon.ico"), true);
  assert.equal(isServablePath("/sample/data.sample.js"), true);
});

test("isServablePath allows anything under /src/ (the vendored libraries included) and /sample/", () => {
  assert.equal(isServablePath("/src/app.js"), true);
  assert.equal(isServablePath("/src/styles.css"), true);
  assert.equal(isServablePath("/src/vendor/fuse.min.js"), true);
  assert.equal(isServablePath("/src/vendor/chart.min.js"), true);
  assert.equal(isServablePath("/sample/photo-4.svg"), true);
});

test("isServablePath allows exactly personal_data/data.js and personal_data/local.js", () => {
  assert.equal(isServablePath("/personal_data/data.js"), true);
  assert.equal(isServablePath("/personal_data/local.js"), true);
});

// Legacy root overrides: index.html loads these two (as optional probes) as the
// pre-wizard manual-flow twins of personal_data/data.js and
// personal_data/local.js — same data class, same user, same localhost.
// docs/ARCHITECTURE.md documents both as supported. They must be allowed so a
// user upgrading from v1.0.1 who kept root overrides doesn't silently lose
// them over the server.
test("isServablePath allows the legacy root overrides data.js and names.local.js", () => {
  assert.equal(isServablePath("/data.js"), true);
  assert.equal(isServablePath("/names.local.js"), true);
});

test("isServablePath allows anything under personal_data/media/ and personal_data/pfps/", () => {
  assert.equal(isServablePath("/personal_data/media/clip.mp4"), true);
  assert.equal(isServablePath("/personal_data/pfps/alice_pfp.png"), true);
  assert.equal(isServablePath("/personal_data/pfps/nested/deeper.png"), true);
});

test("isServablePath denies personal_data/config.json and personal_data/source/**", () => {
  assert.equal(isServablePath("/personal_data/config.json"), false);
  assert.equal(isServablePath("/personal_data/source/direct-messages-group.js"), false);
  assert.equal(isServablePath("/personal_data/source/nested/file.js"), false);
});

test("isServablePath denies personal_data itself and unknown personal_data children", () => {
  assert.equal(isServablePath("/personal_data"), false);
  assert.equal(isServablePath("/personal_data/"), false);
  assert.equal(isServablePath("/personal_data/whatever.txt"), false);
});

test("isServablePath denies repo internals — .git, scripts, tests, docs, node_modules", () => {
  assert.equal(isServablePath("/.git/HEAD"), false);
  assert.equal(isServablePath("/scripts/server.js"), false);
  assert.equal(isServablePath("/scripts/server-core.js"), false);
  assert.equal(isServablePath("/tests/smoke.spec.js"), false);
  assert.equal(isServablePath("/docs/superpowers/specs/whatever.md"), false);
  assert.equal(isServablePath("/node_modules/eslint/package.json"), false);
});

test("isServablePath denies an unlisted top-level file", () => {
  assert.equal(isServablePath("/package.json"), false);
  assert.equal(isServablePath("/README.md"), false);
});

// Traversal forms: isServablePath is a pre-filter on the URL path string, not
// a filesystem check — but "../" segments anywhere must not smuggle a denied
// path through a prefix match (e.g. "/src/../personal_data/config.json" must
// not read as "under /src/"). isServablePath receives the already-decoded
// pathname (serveStatic decodeURIComponent()s before calling it), so raw
// %-encoded forms aren't its concern; serveStatic's existing path.resolve +
// relative() guard still runs beneath this, unchanged, as defense in depth.
test("isServablePath denies traversal forms even under an allowed prefix", () => {
  assert.equal(isServablePath("/src/../personal_data/config.json"), false);
  assert.equal(isServablePath("/personal_data/media/../source/x.js"), false);
  assert.equal(isServablePath("/../scripts/server.js"), false);
  assert.equal(isServablePath("/personal_data/pfps/../config.json"), false);
});

// Regression: a decoded literal "?" or "#" inside the pathname must not let
// ".." segments smuggle through. serveStatic strips the query string from
// the RAW url before decodeURIComponent() runs, so "%3F"/"%23" in the raw URL
// survive that split and decode into a literal "?"/"#" INSIDE the pathname
// isServablePath receives. The old implementation ran its ".." scan on
// `p.split(/[?#]/)[0]`, which truncated the scan right there — dropping every
// ".." segment that came after the "?"/"#" — while the allow-check below and
// serveStatic's downstream path.resolve both still see the FULL string, so
// the traversal resolves. isServablePath's contract is "already decoded,
// already query-stripped"; there is no legitimate "?"/"#" left to protect, so
// a decoded "?"/"#" is itself a smuggling attempt and the ".." scan must run
// on the whole string.
test("isServablePath denies decoded ?/# traversal-smuggling payloads", () => {
  assert.equal(isServablePath("/src/x?/../../personal_data/config.json"), false);
  assert.equal(isServablePath("/src/x#/../../.git/HEAD"), false);
  assert.equal(isServablePath("/personal_data/pfps/x?/../../config.json"), false);
});

// Security regression (DoS): a decoded NUL byte inside an allowlisted-prefix
// path ("/src/app.js\x00.png") used to satisfy isServablePath, reach fs.stat()
// in serveStatic, and throw ERR_INVALID_ARG_VALUE *synchronously*. serveStatic
// is called outside the request handler's try/catch, so that throw became an
// unhandledRejection and crashed the whole local server. Control characters are
// never legitimate in a served path, so isServablePath rejects them up front.
test("isServablePath rejects paths containing NUL / control characters", () => {
  assert.equal(isServablePath("/src/app.js\x00.png"), false);
  assert.equal(isServablePath("/src/app.js\x00"), false);
  assert.equal(isServablePath("/index.html\x00"), false);
  assert.equal(isServablePath("/personal_data/pfps/a\x1f.png"), false);
  assert.equal(isServablePath("/src/\tx"), false);   // tab (0x09) is a control char too
  // A normal path with no control chars is still allowed.
  assert.equal(isServablePath("/src/app.js"), true);
});

// The optional real-data overrides get an empty 200 when missing (so the served
// console stays clean) instead of a 404. Guard the two invariants that make that
// safe and correct: every optional path must be allowlisted (so it reaches the
// serveStatic stat check where the empty-200 lives), and the set must match the
// exact `<script src=... data-optional>` probe list in index.html — a drift there would
// silently reintroduce a 404 console error or leave a probe un-cleaned.
test("OPTIONAL_OVERRIDES are all allowlisted and match index.html's script probes", () => {
  for (const p of OPTIONAL_OVERRIDES) {
    assert.equal(SERVABLE_EXACT.has(p), true, `${p} must be in SERVABLE_EXACT to reach the empty-200 path`);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // Every <script src="X" data-optional> in index.html is an optional probe; collect them.
  const probes = [...html.matchAll(/<script\s+src="([^"]+)"\s+data-optional\b/g)].map((m) => "/" + m[1]);
  assert.ok(probes.length > 0, "expected to find optional <script data-optional> probes in index.html");
  // No inline event-handler attributes anywhere: the page CSP blocks them.
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+=/i, "index.html must not use inline event-handler attributes");
  assert.deepEqual(new Set(probes), OPTIONAL_OVERRIDES, "index.html optional probes and OPTIONAL_OVERRIDES have drifted");
});

// isAllowedHost: the Host header allowlist checked on EVERY request. Without
// this, DNS rebinding (an attacker-controlled domain that resolves to
// 127.0.0.1) makes a remote page same-origin against this server for every
// route, defeating the browser's own same-origin protections entirely.
test("isAllowedHost accepts loopback hostnames on our own port", () => {
  assert.equal(isAllowedHost("127.0.0.1:8765", 8765), true);
  assert.equal(isAllowedHost("localhost:8765", 8765), true);
  assert.equal(isAllowedHost("[::1]:8765", 8765), true);
});

test("isAllowedHost rejects a non-loopback Host regardless of port", () => {
  assert.equal(isAllowedHost("evil.com", 8765), false);
  assert.equal(isAllowedHost("evil.com:8765", 8765), false);
  assert.equal(isAllowedHost("attacker.com:8765", 8765), false);
});

// DNS-rebinding: an attacker domain that resolves to 127.0.0.1 still carries
// its own name in the Host header — the header string is never rewritten by
// the rebind, only the DNS answer is — so name-checking (not IP-checking)
// stops it.
test("isAllowedHost rejects a loopback-resolving attacker domain (DNS rebind)", () => {
  assert.equal(isAllowedHost("rebind.attacker.com:8765", 8765), false);
});

test("isAllowedHost rejects a loopback hostname on the wrong port", () => {
  assert.equal(isAllowedHost("127.0.0.1:9999", 8765), false);
  assert.equal(isAllowedHost("localhost:9999", 8765), false);
  assert.equal(isAllowedHost("[::1]:9999", 8765), false);
});

test("isAllowedHost rejects an absent/empty Host header", () => {
  assert.equal(isAllowedHost(undefined, 8765), false);
  assert.equal(isAllowedHost("", 8765), false);
  assert.equal(isAllowedHost(null, 8765), false);
});

test("isAllowedHost accepts a loopback Host header with no port (defensive, not our normal traffic)", () => {
  assert.equal(isAllowedHost("localhost", 8765), true);
  assert.equal(isAllowedHost("127.0.0.1", 8765), true);
});

// Anti-bypass: a Host that merely CONTAINS a loopback label as a substring/
// subdomain ("localhost.evil.com") is an attacker domain, not loopback — the
// check must be exact-name equality, never a prefix/substring match.
test("isAllowedHost rejects a domain that only has a loopback name as a subdomain label", () => {
  assert.equal(isAllowedHost("localhost.evil.com", 8765), false);
  assert.equal(isAllowedHost("localhost.evil.com:8765", 8765), false);
  assert.equal(isAllowedHost("127.0.0.1.evil.com:8765", 8765), false);
});

// Anti-bypass regression: a MALFORMED bracketed Host ("[::1" with no closing
// "]", "[localhost", "[127.0.0.1") must be rejected. Before the fix,
// parseHostHeader fell through to the bare-string branch and isLoopbackHostname
// stripped the stray leading "[", so "[::1" normalized to "::1" and was wrongly
// ALLOWED (verified live: `Host: [::1` returned 200). Brackets are only ever
// valid in the fully-matched "[v6]"/"[v6]:port" form.
test("isAllowedHost rejects a malformed bracketed Host (unmatched brackets)", () => {
  assert.equal(isAllowedHost("[::1", 8765), false);
  assert.equal(isAllowedHost("[localhost", 8765), false);
  assert.equal(isAllowedHost("[127.0.0.1", 8765), false);
  assert.equal(isAllowedHost("::1]", 8765), false);
  assert.equal(isAllowedHost("[::1]extra", 8765), false);
  // The valid bracketed forms must still be accepted (no regression).
  assert.equal(isAllowedHost("[::1]", 8765), true);
  assert.equal(isAllowedHost("[::1]:8765", 8765), true);
});

// isAllowedOrigin: the CSRF guard on state-changing routes only. A same-origin
// no-CORS GET (or a non-browser client like curl) never sets Origin/Referer,
// so absence must be allowed — but a cross-origin fetch() always carries an
// Origin the browser itself sets (unspoofable from page JS), so any PRESENT
// foreign value is the actual attack signal and must be rejected.
test("isAllowedOrigin allows when neither Origin nor Referer is present", () => {
  assert.equal(isAllowedOrigin(undefined, undefined, 8765), true);
  assert.equal(isAllowedOrigin("", "", 8765), true);
});

test("isAllowedOrigin allows our own loopback Origin", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:8765", undefined, 8765), true);
  assert.equal(isAllowedOrigin("http://localhost:8765", undefined, 8765), true);
});

test("isAllowedOrigin rejects a foreign Origin", () => {
  assert.equal(isAllowedOrigin("http://evil.com", undefined, 8765), false);
});

test("isAllowedOrigin rejects a foreign Referer when Origin is absent", () => {
  assert.equal(isAllowedOrigin(undefined, "http://evil.com/attack.html", 8765), false);
});

test("isAllowedOrigin allows our own loopback Referer when Origin is absent", () => {
  assert.equal(isAllowedOrigin(undefined, "http://127.0.0.1:8765/setup.html", 8765), true);
});

test("isAllowedOrigin rejects a same-hostname Origin on the wrong port", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999", undefined, 8765), false);
});

test("isAllowedOrigin rejects a malformed Origin/Referer rather than throwing", () => {
  assert.equal(isAllowedOrigin("not-a-url", undefined, 8765), false);
  assert.equal(isAllowedOrigin(undefined, "not-a-url", 8765), false);
});

// Anti-bypass: Origin is the browser-authoritative CSRF signal and takes
// priority. A foreign Origin must be rejected even when the request also
// carries a legit-looking (loopback) Referer — an attacker can freely set
// Referer via referrerpolicy/meta, but the browser controls Origin, so a
// present foreign Origin is dispositive and the Referer must NOT rescue it.
test("isAllowedOrigin rejects a foreign Origin even when a legit-looking Referer is present", () => {
  assert.equal(isAllowedOrigin("http://evil.com", "http://127.0.0.1:8765/legit", 8765), false);
});
