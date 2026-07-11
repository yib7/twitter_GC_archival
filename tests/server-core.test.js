const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames, isServablePath, SERVABLE_EXACT, OPTIONAL_OVERRIDES } = require("../scripts/server-core.js");

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

test("liveness never exits before the first heartbeat arrives", () => {
  const clock = fakeClock(0);
  const live = makeLiveness(6000, clock);
  clock.advance(100000);                       // lots of time, but no ping ever seen
  assert.equal(live.shouldExit(), false);      // nothing to time out yet
});

test("liveness exits once heartbeats stop for longer than the idle window", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness(6000, clock);
  live.ping();                                 // browser alive
  clock.advance(5000);
  assert.equal(live.shouldExit(), false);      // 5s gap < 6s window
  clock.advance(2000);                         // 7s since the last heartbeat
  assert.equal(live.shouldExit(), true);       // browser really went away
});

// Regression: a native file picker runs execFileSync, which freezes the event
// loop so heartbeats can't arrive while the dialog is open. The watchdog must not
// mistake that frozen stretch for a closed browser, and the idle clock must
// restart when the picker returns (we were actively serving the user) — not keep
// counting from the stale pre-Browse heartbeat.
test("liveness does not exit during or right after a long native picker", () => {
  const clock = fakeClock(1000);
  const live = makeLiveness(6000, clock);
  live.ping();                                 // last heartbeat just before Browse… clicked
  live.enter();                                // picker opens; event loop will freeze
  clock.advance(20000);                        // user browses for 20s — no pings possible
  assert.equal(live.shouldExit(), false, "must not exit while a picker is open");
  live.leave();                                // picker returns
  assert.equal(live.shouldExit(), false, "must not exit immediately after the picker closes");
  clock.advance(5000);
  assert.equal(live.shouldExit(), false, "idle clock restarts from when the picker closed");
  clock.advance(2000);                         // 7s after the picker closed, still no heartbeat
  assert.equal(live.shouldExit(), true, "normal idle timeout resumes after the picker");
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

// isServablePath: the allowlist serveStatic consults BEFORE touching the
// filesystem. Real personal messages/config/media/source and repo internals
// (.git, scripts, tests, docs, node_modules) must never be reachable over
// HTTP even though they live under ROOT alongside the app assets.
test("isServablePath allows the app shell and its fixed top-level assets", () => {
  assert.equal(isServablePath("/"), true);
  assert.equal(isServablePath("/index.html"), true);
  assert.equal(isServablePath("/setup.html"), true);
  assert.equal(isServablePath("/favicon.ico"), true);
  assert.equal(isServablePath("/data.sample.js"), true);
});

test("isServablePath allows anything under /src/, /lib/, /sample_media/", () => {
  assert.equal(isServablePath("/src/app.js"), true);
  assert.equal(isServablePath("/src/styles.css"), true);
  assert.equal(isServablePath("/lib/fuse.min.js"), true);
  assert.equal(isServablePath("/lib/fonts/plus-jakarta-sans-latin.woff2"), true);
  assert.equal(isServablePath("/sample_media/avatar-1.svg"), true);
});

test("isServablePath allows exactly personal_data/data.js and personal_data/local.js", () => {
  assert.equal(isServablePath("/personal_data/data.js"), true);
  assert.equal(isServablePath("/personal_data/local.js"), true);
});

// Legacy root overrides: index.html loads these two (onerror-guarded) as the
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
// exact `<script src=... onerror>` probe list in index.html — a drift there would
// silently reintroduce a 404 console error or leave a probe un-cleaned.
test("OPTIONAL_OVERRIDES are all allowlisted and match index.html's script probes", () => {
  for (const p of OPTIONAL_OVERRIDES) {
    assert.equal(SERVABLE_EXACT.has(p), true, `${p} must be in SERVABLE_EXACT to reach the empty-200 path`);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // Every <script src="X" onerror=...> in index.html is an optional probe; collect them.
  const probes = [...html.matchAll(/<script\s+src="([^"]+)"\s+onerror=/g)].map((m) => "/" + m[1]);
  assert.ok(probes.length > 0, "expected to find optional <script onerror> probes in index.html");
  assert.deepEqual(new Set(probes), OPTIONAL_OVERRIDES, "index.html optional probes and OPTIONAL_OVERRIDES have drifted");
});
