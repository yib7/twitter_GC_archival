const { test } = require("node:test");
const assert = require("node:assert");
const { dialogFilter } = require("../scripts/server-core.js");

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
