const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { dialogFilter, sanitizeName, pfpFileName, isInsidePersonal, openerCommand } = require("../scripts/server-core.js");

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
