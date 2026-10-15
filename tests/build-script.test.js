/*
 * scripts/build.js end to end, run as a child process exactly like the
 * setup server runs it — GCA_PERSONAL points at an mkdtemp dir and the config
 * names synthetic export files (tests/fixtures/x-export.js). Never real data.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const X = require("./fixtures/x-export.js");

const BUILD = path.join(__dirname, "..", "scripts", "build.js");
const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A fresh personal dir + synthetic export; returns helpers to run the build.
function setup(exportOpts) {
  const personal = scratch("gca-build-personal-");
  const files = X.writeExport(scratch("gca-build-export-"), exportOpts);
  return { personal, files };
}
function runBuild(personal, cfg, extraEnv) {
  fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [BUILD], { env: Object.assign({}, process.env, { GCA_PERSONAL: personal }, extraEnv || {}), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function readData(personal) {
  const s = fs.readFileSync(path.join(personal, "data.js"), "utf8");
  return JSON.parse(s.replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}
const noStack = (r) => assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at .+:\d+:\d+/, "no stack trace may reach the user");

test("a valid export builds; group chats only, 1:1 DMs skipped", () => {
  const { personal, files } = setup();
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers });
  assert.equal(r.status, 0, r.stderr);
  const data = readData(personal);
  assert.deepEqual(data.conversations.map((c) => c.id).sort(), ["1000000001", "1000000002"]);
  assert.equal(data.conversations.find((c) => c.id === "1000000001").count, 3);
});

test("a messages file with a UTF-8 BOM builds normally", () => {
  const { personal, files } = setup({ bom: true });
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readData(personal).conversations.length, 2);
});

const FAILS = [
  ["the 1:1 direct-messages.js picked by mistake", (f) => ({ sourceJs: [f.dm], headersJs: f.headers }), /1:1/],
  ["account.js picked by mistake", (f) => ({ sourceJs: [f.account], headersJs: f.headers }), /account/],
  ["the headers file given as the messages file", (f) => ({ sourceJs: [f.headers], headersJs: f.headers }), /headers file/i],
  ["a headers-shaped file with no window.YTD prefix given as the messages file (detected by content)", (f) => {
    fs.writeFileSync(f.group, JSON.stringify(X.defaultExport().headers));
    return { sourceJs: [f.group], headersJs: f.headers };
  }, /headers file/i],
  ["an empty messages file", (f) => { fs.writeFileSync(f.group, ""); return { sourceJs: [f.group], headersJs: f.headers }; }, /empty/i],
  ["a truncated messages file", (f) => { const s = fs.readFileSync(f.group, "utf8"); fs.writeFileSync(f.group, s.slice(0, s.length >> 1)); return { sourceJs: [f.group], headersJs: f.headers }; }, /truncated/i],
  ["a file that is not an export at all", (f) => { fs.writeFileSync(f.group, "just some notes\n"); return { sourceJs: [f.group], headersJs: f.headers }; }, /isn't a Twitter\/X export/i],
  ["a messages file with no group chats (only a 1:1 conversation)", (f) => {
    fs.writeFileSync(f.group, X.ytd("direct_messages_group", "part0", [X.conv("111-222", [X.gmsg(1, 111, X.T0, "hi")])]));
    return { sourceJs: [f.group], headersJs: f.headers };
  }, /no group chats/i],
  ["a configured messages file that no longer exists", (f) => ({ sourceJs: [f.group + ".gone"], headersJs: f.headers }), /missing|not found/i],
  ["the messages file given as the headers file", (f) => ({ sourceJs: [f.group], headersJs: f.group }), /messages file/i],
];
for (const [name, cfgOf, re] of FAILS) {
  test("fails loudly (non-zero exit, plain-language reason, no data.js) for " + name, () => {
    const { personal, files } = setup();
    const r = runBuild(personal, cfgOf(files));
    assert.notEqual(r.status, 0, "must exit non-zero; stdout:\n" + r.stdout);
    const line = (r.stderr.match(/^BUILD ERROR: (.+)$/m) || [])[1];
    assert.ok(line, "stderr must carry one BUILD ERROR: line; got:\n" + r.stderr);
    assert.match(line, re);
    noStack(r);
    assert.equal(fs.existsSync(path.join(personal, "data.js")), false, "a failed build must not write data.js");
  });
}

test("an unreadable previous data.js stops the build instead of silently dropping that history", () => {
  const { personal, files } = setup();
  const cfg = { sourceJs: [files.group], headersJs: files.headers };
  assert.equal(runBuild(personal, cfg).status, 0);
  const out = path.join(personal, "data.js");
  const full = fs.readFileSync(out, "utf8");
  const truncated = full.slice(0, full.length >> 1);   // what a crash mid-write used to leave
  fs.writeFileSync(out, truncated);
  const r = runBuild(personal, cfg);
  assert.notEqual(r.status, 0, "must not rebuild over a damaged baseline; stdout:\n" + r.stdout);
  assert.match(r.stderr, /^BUILD ERROR: .*data\.js.*couldn't be read/m);
  // Never advise deleting the history without a backup first
  assert.match(r.stderr, /backup copy.*delete/i);
  noStack(r);
  assert.equal(fs.readFileSync(out, "utf8"), truncated, "the damaged file is left for the user to restore, not overwritten");
});

test("a data.js that parses but isn't an archive is reported as damaged, not merged", () => {
  const { personal, files } = setup();
  const cfg = { sourceJs: [files.group], headersJs: files.headers };
  const out = path.join(personal, "data.js");
  fs.writeFileSync(out, "window.CHAT_DATA = {\"conversations\":[1,2]};\n");
  const r = runBuild(personal, cfg);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^BUILD ERROR: .*data\.js.*damaged.*backup copy/m);
  noStack(r);
});

test("the previous data.js is merged by streaming it (BOM and all), history kept", () => {
  const { personal, files } = setup();
  const cfg = { sourceJs: [files.group], headersJs: files.headers };
  assert.equal(runBuild(personal, cfg).status, 0);
  const out = path.join(personal, "data.js");
  const data = readData(personal);
  // a message only the old archive knows about (no longer in any export)
  data.conversations[0].msgs.unshift({ i: "1", s: data.conversations[0].msgs[0].s, t: 1, x: "only in the old archive" });
  fs.writeFileSync(out, "\uFEFFwindow.CHAT_DATA = " + JSON.stringify(data) + ";\n");
  const r = runBuild(personal, cfg);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Baseline from data\.js: \d+ messages/);
  const again = readData(personal).conversations.find((c) => c.id === data.conversations[0].id);
  assert.ok(again.msgs.some((m) => m.x === "only in the old archive"));
});

test("a whole build + merge read in 7-byte chunks gives the same data.js as normal reads", () => {
  const a = setup(), b = setup();
  const cfgA = { sourceJs: [a.files.group], headersJs: a.files.headers };
  const cfgB = { sourceJs: [b.files.group], headersJs: b.files.headers };
  for (let i = 0; i < 2; i++) {   // the second run merges into the first run's data.js
    assert.equal(runBuild(a.personal, cfgA).status, 0);
    const r = runBuild(b.personal, cfgB, { GCA_SCAN_CHUNK: "7" });
    assert.equal(r.status, 0, r.stderr);
  }
  const strip = (d) => Object.assign(d, { generatedAt: null });
  assert.deepEqual(strip(readData(b.personal)), strip(readData(a.personal)));
});

test("data.js.bak is the previous archive, rotated only by a successful build", () => {
  const { personal, files } = setup();
  const cfg = { sourceJs: [files.group], headersJs: files.headers };
  const out = path.join(personal, "data.js"), bak = out + ".bak";
  assert.equal(runBuild(personal, cfg).status, 0);
  assert.ok(!fs.existsSync(bak), "nothing to back up on the first build");
  const first = fs.readFileSync(out, "utf8");
  assert.equal(runBuild(personal, Object.assign({ ignoredGroups: ["1000000002"] }, cfg)).status, 0);
  assert.equal(fs.readFileSync(bak, "utf8"), first, "the second build backs up the first");
  const second = fs.readFileSync(out, "utf8");
  assert.notEqual(second, first);
  assert.notEqual(runBuild(personal, { sourceJs: [files.account], headersJs: files.headers }).status, 0);
  assert.equal(fs.readFileSync(bak, "utf8"), first, "a failed build leaves data.js.bak alone");
  assert.equal(fs.readFileSync(out, "utf8"), second);
  assert.deepEqual(fs.readdirSync(personal).filter((f) => f.endsWith(".tmp")), []);
});

test("the build writes data.js through a temp file and leaves none behind", () => {
  const { personal, files } = setup();
  assert.equal(runBuild(personal, { sourceJs: [files.group], headersJs: files.headers }).status, 0);
  assert.deepEqual(fs.readdirSync(personal).filter((f) => f.endsWith(".tmp")), []);
});

test("a failed rebuild leaves the previous data.js untouched", () => {
  const { personal, files } = setup();
  assert.equal(runBuild(personal, { sourceJs: [files.group], headersJs: files.headers }).status, 0);
  const before = fs.readFileSync(path.join(personal, "data.js"), "utf8");
  const r = runBuild(personal, { sourceJs: [files.account], headersJs: files.headers });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(personal, "data.js"), "utf8"), before);
});

test("the build attaches both media files of a message, not just the first", () => {
  const { personal, files } = setup();
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers, mediaDir: files.media });
  assert.equal(r.status, 0, r.stderr);
  const m = readData(personal).conversations.find((c) => c.id === "1000000001").msgs.find((x) => x.i === "9002");
  assert.match(m.m, /9002-AbCdEf\.png$/);
  assert.equal(m.k, "img");
  assert.equal(m.mx.length, 1);
  assert.match(m.mx[0].m, /9002-ZzSecond\.jpg$/);
});

test("every part file is ingested, merged in order and deduped", () => {
  const { personal, files } = setup();
  // part1 repeats a part0 message (same id) — it must not be double-counted
  const ex = X.defaultExport();
  ex.part1[0].dmConversation.messages.push(X.gmsg(9001, 111, X.T0, "hello from the first part 🎉"));
  fs.writeFileSync(files.part1, X.ytd("direct_messages_group", "part1", ex.part1));
  const r = runBuild(personal, { sourceJs: [files.group, files.part1], headersJs: files.headers });
  assert.equal(r.status, 0, r.stderr);
  const g = readData(personal).conversations.find((c) => c.id === "1000000001");
  assert.deepEqual(g.msgs.map((m) => m.i), ["9001", "9002", "9003", "9004", "9005"]);
  assert.doesNotMatch(r.stdout, /no message text/);
});

test("a missing part file is called out (headers list messages with no body)", () => {
  const { personal, files } = setup();
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Warning: 2 message\(s\) listed in the headers file have no message text.*-part/);
});

// data.js missing while its backup or an
// unfinished save sits next to it means the archive's history is in one of
// those files (a crash mid-swap, or data.js deleted by hand). Building from
// the export alone would silently replace that history, so stop and say what
// to do. Nothing may be written.
for (const leftover of ["data.js.bak", "data.js.4242.0a1b2c3d.tmp", "data.js.bak.4242.0a1b2c3d.tmp"]) {
  test("no data.js but a leftover " + leftover + " stops the build with a plain sentence", () => {
    const { personal, files } = setup();
    fs.writeFileSync(path.join(personal, leftover), "window.CHAT_DATA = {\"conversations\":[]};\n");
    const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^BUILD ERROR: .*data\.js\) is missing/m);
    assert.ok(r.stderr.includes(leftover), "the sentence names the leftover file");
    assert.match(r.stderr, /Start over/);
    noStack(r);
    assert.ok(!fs.existsSync(path.join(personal, "data.js")), "no data.js is written");
  });
}

// The older layout kept the archive at the project root (data.js), with no
// personal_data/data.js. The setup server counts that file as the archive
// (its merge preview and reply), so the build must merge into it too, or the
// first wizard build would hide that history behind a new data.js holding
// only the export. A synthetic project root (a copy of the build's scripts)
// stands in for the checkout; nothing real is read.
function synthRootWith(dataJs) {
  const root = scratch("gca-build-root-");
  const here = path.join(__dirname, "..");
  for (const f of ["scripts/build.js", "scripts/build-core.js", "scripts/fs-io.js", "src/shared-core.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(here, f), path.join(root, f));
  }
  fs.writeFileSync(path.join(root, "data.js"), dataJs);
  return root;
}
const ROOT_ARCHIVE = "window.CHAT_DATA = " + JSON.stringify({ generatedAt: "2020-01-01T00:00:00.000Z", conversations: [
  { id: "1000000001", type: "group", title: "Synthetic Crew", participants: ["111"], count: 1, msgs: [{ i: "7001", s: "111", t: X.T0 - 86400e3, x: "older history, only in the root data.js" }], events: [] },
] }) + ";\n";
for (const [label, extraEnv, keeps] of [["merges the root data.js when personal_data has none", {}, true], ["leaves it alone with GCA_NO_ROOT_FALLBACK=1", { GCA_NO_ROOT_FALLBACK: "1" }, false]]) {
  test("a build " + label, () => {
    const root = synthRootWith(ROOT_ARCHIVE);
    const { personal, files } = setup();
    fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [files.group, files.part1], headersJs: files.headers }));
    const env = Object.assign({}, process.env, { GCA_PERSONAL: personal }, extraEnv);
    if (!extraEnv.GCA_NO_ROOT_FALLBACK) delete env.GCA_NO_ROOT_FALLBACK;
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "build.js")], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const ids = readData(personal).conversations.find((c) => c.id === "1000000001").msgs.map((m) => String(m.i));
    assert.equal(ids.includes("7001"), keeps, ids.join(","));
    assert.ok(ids.includes("9001") && ids.includes("9005"), "the export's own messages are there too");
    assert.equal(fs.readFileSync(path.join(root, "data.js"), "utf8"), ROOT_ARCHIVE, "the root file itself is never changed");
  });
}
