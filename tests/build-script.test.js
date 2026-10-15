/*
 * SP6: scripts/build.js end to end, run as a child process exactly like the
 * setup server runs it — GCA_PERSONAL points at an mkdtemp dir and the config
 * names synthetic export files (tests/fixtures/x-export.js). Never real data.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
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
function runBuild(personal, cfg) {
  fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [BUILD], { env: Object.assign({}, process.env, { GCA_PERSONAL: personal }), encoding: "utf8" });
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

test("SP-1: a messages file with a UTF-8 BOM builds normally", () => {
  const { personal, files } = setup({ bom: true });
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readData(personal).conversations.length, 2);
});

const FAILS = [
  ["the 1:1 direct-messages.js picked by mistake", (f) => ({ sourceJs: [f.dm], headersJs: f.headers }), /1:1/],
  ["account.js picked by mistake", (f) => ({ sourceJs: [f.account], headersJs: f.headers }), /account/],
  ["the headers file given as the messages file (SP-8)", (f) => ({ sourceJs: [f.headers], headersJs: f.headers }), /headers file/i],
  ["a headers-shaped file with no window.YTD prefix given as the messages file (SP-8, by content)", (f) => {
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
  test("SP-1: fails loudly (non-zero exit, plain-language reason, no data.js) for " + name, () => {
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

test("SP-9: an unreadable previous data.js stops the build instead of silently dropping that history", () => {
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
  noStack(r);
  assert.equal(fs.readFileSync(out, "utf8"), truncated, "the damaged file is left for the user to restore, not overwritten");
});

test("SP-9: the build writes data.js through a temp file and leaves none behind", () => {
  const { personal, files } = setup();
  assert.equal(runBuild(personal, { sourceJs: [files.group], headersJs: files.headers }).status, 0);
  assert.deepEqual(fs.readdirSync(personal).filter((f) => f.endsWith(".tmp")), []);
});

test("SP-1: a failed rebuild leaves the previous data.js untouched", () => {
  const { personal, files } = setup();
  assert.equal(runBuild(personal, { sourceJs: [files.group], headersJs: files.headers }).status, 0);
  const before = fs.readFileSync(path.join(personal, "data.js"), "utf8");
  const r = runBuild(personal, { sourceJs: [files.account], headersJs: files.headers });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(personal, "data.js"), "utf8"), before);
});

test("SP-20: the build attaches both media files of a message, not just the first", () => {
  const { personal, files } = setup();
  const r = runBuild(personal, { sourceJs: [files.group], headersJs: files.headers, mediaDir: files.media });
  assert.equal(r.status, 0, r.stderr);
  const m = readData(personal).conversations.find((c) => c.id === "1000000001").msgs.find((x) => x.i === "9002");
  assert.match(m.m, /9002-AbCdEf\.png$/);
  assert.equal(m.k, "img");
  assert.equal(m.mx.length, 1);
  assert.match(m.mx[0].m, /9002-ZzSecond\.jpg$/);
});
