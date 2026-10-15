/*
 * SP-10, opt-in ONLY: a ~600 MB synthetic messages file must build.
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
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
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
function writeBigExport(file) {
  const fd = fs.openSync(file, "w");
  let bytes = 0, msgs = 0, id = 10000000;
  const put = (s) => { const b = Buffer.from(s, "utf8"); fs.writeSync(fd, b); bytes += b.length; };
  const filler = "lorem ipsum dolor sit amet, synthetic message text with some unicode — ünïcödé 🎉 and a \"quote\" ";
  put("\uFEFFwindow.YTD.direct_messages_group.part0 = [");
  const perGroup = Math.ceil(TARGET / GROUPS);
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

test("SP-10: a ~600 MB messages file builds without ERR_STRING_TOO_LONG", { timeout: 30 * 60e3 }, () => {
  const exportDir = scratch("gca-big-export-");
  const personal = scratch("gca-big-personal-");
  const file = path.join(exportDir, "direct-messages-group.js");

  let t = Date.now();
  const { bytes, msgs } = writeBigExport(file);
  const genSec = (Date.now() - t) / 1000;
  assert.ok(bytes > 0x1fffffe8, "the file must be larger than V8's max string length");
  // The old whole-file read could not even load it:
  assert.throws(() => fs.readFileSync(file, "utf8"), (e) => e.code === "ERR_STRING_TOO_LONG" || /Invalid string length|too long/i.test(e.message));

  fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [file] }));
  t = Date.now();
  const env = Object.assign({}, process.env, { GCA_PERSONAL: personal, NO_COLOR: "1" });
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, buildNodeArgs(path.join(__dirname, "..", "scripts", "build.js"), os.totalmem()), {
    env,
    encoding: "utf8", maxBuffer: 64 * 1048576,
  });
  const buildSec = (Date.now() - t) / 1000;
  assert.equal(r.status, 0, "build failed:\n" + r.stderr);
  assert.doesNotMatch(r.stderr, /ERR_STRING_TOO_LONG|heap/i);
  const total = Number((/Total messages: (\d+)/.exec(r.stdout) || [])[1]);
  assert.equal(total, msgs);
  const outMb = fs.statSync(path.join(personal, "data.js")).size / 1048576;
  console.log("[SP-10 big] export " + (bytes / 1048576).toFixed(1) + " MB, " + msgs + " messages in " + GROUPS + " groups; " +
    "generated in " + genSec.toFixed(1) + " s; built in " + buildSec.toFixed(1) + " s (" + buildNodeArgs("build.js", os.totalmem())[0] +
    "); data.js " + outMb.toFixed(1) + " MB");
});
