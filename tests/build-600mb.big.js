/*
 * Opt-in ONLY: a ~600 MB synthetic messages file must build.
 *
 *   GCA_BIG=1 node --test tests/build-600mb.big.js      (or: npm run test:big)
 *
 * Not part of the default suite: the file name doesn't match the unit glob
 * (tests/**\/*.test.js) or Playwright's (**\/*.spec.js), and without GCA_BIG=1
 * it refuses to run. It writes ~600 MB of made-up messages into an mkdtemp
 * dir, runs scripts/build.js exactly as the setup server does (same heap
 * flag, GCA_PERSONAL = another mkdtemp dir), and deletes both afterwards.
 * Nothing it writes is ever committed. The everyday proof of the streaming
 * path is the tiny-chunk scanner test in tests/build-ingest.test.js.
 *
 * A second build merges a further ~400 MB export into the first
 * build's data.js, and a third build reads that data.js back, which by then is
 * itself larger than V8's max string length (the old whole-file read of the
 * previous archive could not load it). tests/archive-stream.test.js is the
 * everyday proof of that path.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const X = require("./fixtures/x-export.js");
const { buildNodeArgs } = require("../scripts/server-core.js");

if (process.env.GCA_BIG !== "1") {
  console.error("tests/build-600mb.big.js is opt-in: run it with GCA_BIG=1 (npm run test:big).");
  process.exit(1);
}

const TARGET = 600 * 1048576;          // > V8's ~512 MB max string length
const GROUPS = 12;
const tmpDirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Streams the file out conversation by conversation, never holding it whole.
function writeBigExport(file, target, firstId) {
  target = target || TARGET;
  const fd = fs.openSync(file, "w");
  let bytes = 0, msgs = 0, id = firstId || 10000000;
  const put = (s) => { const b = Buffer.from(s, "utf8"); fs.writeSync(fd, b); bytes += b.length; };
  const filler = "lorem ipsum dolor sit amet, synthetic message text with some unicode — ünïcödé 🎉 and a \"quote\" ";
  put("\uFEFFwindow.YTD.direct_messages_group.part0 = [");
  const perGroup = Math.ceil(target / GROUPS);
  for (let g = 0; g < GROUPS; g++) {
    const start = bytes;
    put((g ? "," : "") + "\n  {\n    \"dmConversation\" : {\n      \"conversationId\" : \"" + (2000000001 + g) + "\",\n      \"messages\" : [");
    let first = true, batch = [], pending = 0;
    while (bytes + pending < start + perGroup) {
      const m = X.gmsg(id++, 100 + (id % 7), X.T0 + id * 1000, filler + id);
      const s = (first ? "" : ",") + "\n        " + JSON.stringify(m);
      batch.push(s);
      pending += Buffer.byteLength(s);
      first = false;
      msgs++;
      if (batch.length === 2000) { put(batch.join("")); batch = []; pending = 0; }
    }
    put(batch.join("") + "\n      ]\n    }\n  }");
  }
  put("\n]\n");
  fs.closeSync(fd);
  return { bytes, msgs };
}

test("a ~600 MB messages file builds without ERR_STRING_TOO_LONG, and a >512 MB data.js merges", { timeout: 30 * 60e3 }, () => {
  const exportDir = scratch("gca-big-export-");
  const personal = scratch("gca-big-personal-");
  const file = path.join(exportDir, "direct-messages-group.js");

  let t = Date.now();
  const { bytes, msgs } = writeBigExport(file);
  const genSec = (Date.now() - t) / 1000;
  assert.ok(bytes > 0x1fffffe8, "the file must be larger than V8's max string length");
  // The old whole-file read could not even load it:
  assert.throws(() => fs.readFileSync(file, "utf8"), (e) => e.code === "ERR_STRING_TOO_LONG" || /Invalid string length|too long/i.test(e.message));

  const run = (src) => {
    fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [src] }));
    const t0 = Date.now();
    const env = Object.assign({}, process.env, { GCA_PERSONAL: personal, NO_COLOR: "1" });
    delete env.FORCE_COLOR;
    const r = spawnSync(process.execPath, buildNodeArgs(path.join(__dirname, "..", "scripts", "build.js"), os.totalmem()), {
      env, encoding: "utf8", maxBuffer: 64 * 1048576,
    });
    assert.equal(r.status, 0, "build failed: " + r.stderr);
    assert.doesNotMatch(r.stderr, /ERR_STRING_TOO_LONG|heap/i);
    return { r, sec: (Date.now() - t0) / 1000, total: Number((/Total messages: (\d+)/.exec(r.stdout) || [])[1]) };
  };
  const out = path.join(personal, "data.js");
  const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1);

  const b1 = run(file);
  assert.equal(b1.total, msgs);
  const out1Mb = mb(out);
  console.log("[big build] export " + (bytes / 1048576).toFixed(1) + " MB, " + msgs + " messages in " + GROUPS + " groups; " +
    "generated in " + genSec.toFixed(1) + " s; built in " + b1.sec.toFixed(1) + " s (" + buildNodeArgs("build.js", os.totalmem())[0] +
    "); data.js " + out1Mb + " MB");
  fs.rmSync(file);   // keep the disk footprint down

  // Build 2 merges a second export (new message ids) into build 1's data.js.
  const file2 = path.join(exportDir, "direct-messages-group-2.js");
  const second = writeBigExport(file2, 400 * 1048576, 90000000);
  const b2 = run(file2);
  assert.equal(b2.total, msgs + second.msgs, "every message of both exports is kept");
  assert.ok(b2.r.stdout.includes("Baseline from data.js: " + msgs + " messages"), b2.r.stdout);
  const size2 = fs.statSync(out).size;
  console.log("[fix-1 big] merge build: +" + (second.bytes / 1048576).toFixed(1) + " MB export (" + second.msgs + " messages) into the " +
    out1Mb + " MB data.js in " + b2.sec.toFixed(1) + " s; data.js now " + mb(out) + " MB, " + b2.total + " messages");

  // Build 3 reads that data.js back as its baseline: it is now larger than
  // V8's max string length, so only the streaming reader can.
  assert.ok(size2 > 0x1fffffe8, "data.js must now be larger than V8's max string length (" + size2 + " bytes)");
  assert.throws(() => fs.readFileSync(out, "utf8"), (e) => e.code === "ERR_STRING_TOO_LONG" || /Invalid string length|too long/i.test(e.message));
  const b3 = run(file2);
  assert.equal(b3.total, msgs + second.msgs, "re-merging the same export adds nothing and loses nothing");
  console.log("[fix-1 big] rebuild reading the " + (size2 / 1048576).toFixed(1) + " MB data.js as its baseline: " + b3.sec.toFixed(1) + " s, " + b3.total + " messages");
});
