/*
 * SP-9: crash-safe writes. data.js, config.json, local.js and photos are
 * written to a temp file in the same directory and renamed over the target,
 * so a crash / full disk / AV lock mid-write never leaves a truncated file.
 * On Windows a rename over a file another process holds can fail with
 * EPERM/EBUSY — it is retried briefly, then falls back to a copy.
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic, writeChunksAtomic } = require("../scripts/fs-io.js");

const tmpDirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gca-atomic-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const errno = (code) => Object.assign(new Error(code + ": simulated"), { code });

test("writeFileAtomic replaces the file and leaves no temp file behind", () => {
  const dir = scratch();
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, "old");
  assert.equal(writeFileAtomic(f, "new contents"), "renamed");
  assert.equal(fs.readFileSync(f, "utf8"), "new contents");
  assert.deepEqual(leftovers(dir), []);
});

test("a rename that fails with EPERM/EBUSY is retried, then succeeds", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  let calls = 0;
  const rename = (a, b) => { calls++; if (calls <= 2) throw errno(calls === 1 ? "EPERM" : "EBUSY"); fs.renameSync(a, b); };
  assert.equal(writeFileAtomic(f, "fresh", { rename, delayMs: 1 }), "renamed");
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(f, "utf8"), "fresh");
  assert.deepEqual(leftovers(dir), []);
});

test("a rename that keeps failing falls back to copying the finished temp file", () => {
  const dir = scratch();
  const f = path.join(dir, "local.js");
  fs.writeFileSync(f, "old");
  const rename = () => { throw errno("EPERM"); };
  assert.equal(writeFileAtomic(f, "copied in", { rename, delayMs: 1, retries: 2 }), "copied");
  assert.equal(fs.readFileSync(f, "utf8"), "copied in");
  assert.deepEqual(leftovers(dir), []);
});

test("an unrelated rename error is not swallowed and the temp file is removed", () => {
  const dir = scratch();
  const f = path.join(dir, "x.json");
  fs.writeFileSync(f, "old");
  assert.throws(() => writeFileAtomic(f, "new", { rename: () => { throw errno("EXDEV"); } }), /EXDEV/);
  assert.equal(fs.readFileSync(f, "utf8"), "old");
  assert.deepEqual(leftovers(dir), []);
});

test("writeChunksAtomic: a failure mid-write leaves the previous file intact (no truncation)", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "window.CHAT_DATA = {\"previous\":true};\n");
  function* chunks() { yield "window.CHAT_DATA = {\"half"; throw errno("ENOSPC"); }
  assert.throws(() => writeChunksAtomic(f, chunks()), /ENOSPC/);
  assert.equal(fs.readFileSync(f, "utf8"), "window.CHAT_DATA = {\"previous\":true};\n");
  assert.deepEqual(leftovers(dir), []);
});

test("writeChunksAtomic writes every chunk in order", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  writeChunksAtomic(f, ["a", "b", "", "c"]);
  assert.equal(fs.readFileSync(f, "utf8"), "abc");
  assert.deepEqual(leftovers(dir), []);
});

// On this machine (Windows) a reader holding the target open must not make
// the write fail: either the rename goes through or the fallback copy does.
test("replacing a file another handle has open still succeeds", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  const fd = fs.openSync(f, "r");
  try {
    const how = writeFileAtomic(f, "new while open", { delayMs: 1 });
    assert.ok(how === "renamed" || how === "copied");
  } finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(f, "utf8"), "new while open");
  assert.deepEqual(leftovers(dir), []);
});
