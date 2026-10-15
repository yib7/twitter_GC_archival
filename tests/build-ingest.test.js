/*
 * SP6 ingestion: the streaming export scanner and the incremental archive
 * writer in scripts/build-core.js (pure) plus the thin file reader in
 * scripts/fs-io.js. Synthetic data only (tests/fixtures/x-export.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../scripts/build-core.js");
const fsio = require("../scripts/fs-io.js");
const X = require("./fixtures/x-export.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Feed `text` to a scanner in fixed-size pieces and collect what it emits.
function scanText(text, size) {
  const convIds = [], msgs = [];
  const sc = core.createExportScanner({
    onConversationId: (ci, id) => { convIds[ci] = id; },
    onMessage: (ci, m) => msgs.push([ci, m]),
  });
  for (let i = 0; i < text.length; i += size) sc.push(text.slice(i, i + size));
  const info = sc.end();
  return { convIds, msgs, info };
}

// What a plain whole-file JSON.parse would have produced, for comparison.
function expected(arr) {
  const convIds = [], msgs = [];
  arr.forEach((d, ci) => { convIds[ci] = d.dmConversation.conversationId; d.dmConversation.messages.forEach((m) => msgs.push([ci, m])); });
  return { convIds, msgs };
}

test("scanner: emits every conversation id and message, identical to a whole-file parse, at any chunk size", () => {
  const ex = X.defaultExport();
  const text = X.ytd("direct_messages_group", "part0", ex.part0);
  const want = expected(ex.part0);
  for (const size of [1, 2, 3, 7, 64, 4096, text.length]) {
    const got = scanText(text, size);
    assert.deepEqual(got.convIds, want.convIds, "conversation ids at chunk size " + size);
    assert.deepEqual(got.msgs, want.msgs, "messages at chunk size " + size);
    assert.equal(got.info.global, "direct_messages_group");
    assert.equal(got.info.part, 0);
  }
});

test("scanner: strips a UTF-8 BOM and accepts a trailing semicolon", () => {
  const ex = X.defaultExport();
  const text = "﻿" + X.ytd("direct_messages_group", "part0", ex.part0) + ";\n";
  const got = scanText(text, 5);
  assert.deepEqual(got.msgs, expected(ex.part0).msgs);
});

test("scanner: a conversationId that comes AFTER its messages still attaches them", () => {
  const text = 'window.YTD.direct_messages_group.part0 = [{"dmConversation":{"messages":[{"messageCreate":{"id":"1","senderId":"9","createdAt":"2020-01-01T00:00:00Z","text":"x"}}],"conversationId":"77"}}]';
  const got = scanText(text, 4);
  assert.deepEqual(got.convIds, ["77"]);
  assert.equal(got.msgs.length, 1);
  assert.equal(got.msgs[0][0], 0);
});

test("scanner: skips unknown keys and values of any shape without emitting them", () => {
  const text = 'window.YTD.direct_messages_group.part0 = [{"other":{"messages":[1,2]},"dmConversation":{"junk":[{"a":"]}"}],"conversationId":"5","messages":[{"x":"y"}],"tail":null}},3,"s"]';
  const got = scanText(text, 3);
  assert.deepEqual(got.convIds, ["5"]);
  assert.deepEqual(got.msgs, [[0, { x: "y" }]]);
});

test("scanner: plain JSON with no window.YTD prefix is accepted (global is null)", () => {
  const got = scanText('[{"dmConversation":{"conversationId":"1","messages":[]}}]', 2);
  assert.deepEqual(got.convIds, ["1"]);
  assert.equal(got.info.global, null);
});

test("scanner: empty, truncated, non-export and broken input throw a readable ExportScanError", () => {
  const bad = {
    "": /empty/i,
    "   \n": /empty/i,
    "﻿": /empty/i,
    "window.YTD.direct_messages_group.part0 = [{\"dmConversation\":{\"conversationId\":\"1\",\"messages\":[{\"a\":1}": /ends early|truncated/i,
    "hello world, not an export": /isn't a Twitter\/X export/i,
    "window.YTD.direct_messages_group.part0 = [{\"dmConversation\":{\"conversationId\":\"1\",\"messages\":[{\"a\":tru}]}}]": /couldn't be read/i,
    "window.YTD.direct_messages_group.part0 = [{\"dmConversation\" \"x\"}]": /couldn't be read/i,
    "window.YTD.direct_messages_group.part0 = []garbage": /after the end/i,
  };
  for (const [text, re] of Object.entries(bad)) {
    assert.throws(() => scanText(text, 3), (e) => e instanceof core.ExportScanError && re.test(e.message), JSON.stringify(text.slice(0, 40)));
  }
});

test("identifyExport names each X file kind from its window.YTD global (BOM-tolerant)", () => {
  const k = (s) => core.identifyExport(s).kind;
  assert.equal(k("window.YTD.direct_messages_group.part0 = ["), "messages");
  assert.equal(k("﻿window.YTD.direct_messages_group.part3 = ["), "messages");
  assert.equal(k("window.YTD.direct_message_group_headers.part0 = ["), "headers");
  assert.equal(k("window.YTD.direct_messages_group_headers.part0 = ["), "headers");
  assert.equal(k("window.YTD.direct_messages.part0 = ["), "dm");
  assert.equal(k("window.YTD.direct_message_headers.part0 = ["), "dm-headers");
  assert.equal(k("window.YTD.account.part0 = ["), "other");
  assert.equal(k("[{\"dmConversation\":"), "unknown");
  assert.equal(k(""), "empty");
  assert.equal(k("﻿  \n"), "empty");
  assert.equal(core.identifyExport("window.YTD.direct_messages_group.part2 = [").part, 2);
});

test("archiveChunks streams exactly what one JSON.stringify of the archive would produce", () => {
  const meta = { generatedAt: "2026-01-01T00:00:00.000Z", ignoredUsers: ["1"], ignoredGroups: [] };
  const conversations = [
    { id: "G1", type: "group", title: "T \"q\"", participants: ["a"], count: 3, msgs: [{ i: "1", s: "a", t: 1, x: "é🎉" }, { i: "2", s: "a", t: 2, x: "" }, { i: "3", s: "a", t: 3, x: "\n" }], events: [{ t: 1, type: "name", name: "n" }] },
    { id: "G2", type: "group", title: null, participants: [], count: 0, msgs: [], events: [] },
  ];
  const whole = "window.CHAT_DATA = " + JSON.stringify(Object.assign({}, meta, { conversations })) + ";\n";
  for (const batch of [1, 2, 1000]) assert.equal([...core.archiveChunks(meta, conversations, batch)].join(""), whole);
  assert.equal([...core.archiveChunks(meta, [], 5)].join(""), "window.CHAT_DATA = " + JSON.stringify(Object.assign({}, meta, { conversations: [] })) + ";\n");
});

// SP-10 fast proof of the streaming path: the file reader hands the scanner
// tiny byte chunks, so multi-byte UTF-8 (emoji, accents) straddles chunk
// boundaries — the decoded result must still equal a whole-file parse.
test("scanExportFile reads a file in tiny byte chunks with identical results (streaming path)", () => {
  const dir = scratch("gca-ingest-");
  const ex = X.defaultExport();
  const file = path.join(dir, "direct-messages-group.js");
  fs.writeFileSync(file, "﻿" + X.ytd("direct_messages_group", "part0", ex.part0));
  const want = expected(ex.part0);
  for (const chunkSize of [1, 3, 5, 17, 1 << 20]) {
    const convIds = [], msgs = [];
    let reads = 0;
    const info = fsio.scanExportFile(file, {
      onConversationId: (ci, id) => { convIds[ci] = id; },
      onMessage: (ci, m) => msgs.push([ci, m]),
    }, { chunkSize, onChunk: () => { reads++; } });
    assert.deepEqual(convIds, want.convIds);
    assert.deepEqual(msgs, want.msgs);
    assert.equal(info.global, "direct_messages_group");
    if (chunkSize < 100) assert.ok(reads > 50, "a tiny chunk size must really read the file piecewise (" + reads + " reads)");
  }
});

test("readExportHead returns the leading text of a file for identification", () => {
  const dir = scratch("gca-head-");
  const f = path.join(dir, "a.js");
  fs.writeFileSync(f, "﻿window.YTD.account.part0 = [" + "x".repeat(5000));
  const head = fsio.readExportHead(f);
  assert.equal(core.identifyExport(head).kind, "other");
  assert.ok(head.length <= 1024);
  fs.writeFileSync(f, "");
  assert.equal(core.identifyExport(fsio.readExportHead(f)).kind, "empty");
});
