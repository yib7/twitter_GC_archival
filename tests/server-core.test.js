const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand, isIdleTimedOut, makeLiveness, mergeNames } = require("../scripts/server-core.js");

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
