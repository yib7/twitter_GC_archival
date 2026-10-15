/*
 * crash-safe writes. data.js, config.json, local.js and photos are
 * written to a temp file in the same directory and renamed over the target,
 * so a crash / full disk / AV lock mid-write never leaves a truncated file.
 * On Windows a rename over a file another process holds can fail with
 * EPERM/EBUSY — it is retried briefly; if it still fails the old file is left
 * as it was and the error names the file that is held.
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
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

// There is no copy fallback. Copying over the target
// in place could fail half-way (full disk) and truncate it, after which the
// temp file — the only complete copy — was deleted. A rename that keeps
// failing leaves the old file untouched and says which file is held and what
// to do.
test("a rename that keeps failing leaves the old file intact and says which file is held", () => {
  const dir = scratch();
  const f = path.join(dir, "local.js");
  fs.writeFileSync(f, "old");
  const rename = () => { throw errno("EBUSY"); };
  const realCopy = fs.copyFileSync;
  // If anything still copied over the target, make that copy fail half-way
  // the way a full disk would: the target is truncated, then ENOSPC.
  fs.copyFileSync = (a, b) => { fs.writeFileSync(b, "ne"); throw errno("ENOSPC"); };
  let err;
  try { writeFileAtomic(f, "new contents", { rename, delayMs: 1, retries: 2 }); }
  catch (e) { err = e; }
  finally { fs.copyFileSync = realCopy; }
  assert.ok(err, "the write reports the failure");
  assert.equal(err.code, "EBUSY");
  assert.equal(err.path, f);
  assert.match(err.message, /local\.js/);
  assert.match(err.message, /close/i);
  assert.equal(fs.readFileSync(f, "utf8"), "old", "the previous file is untouched");
  assert.deepEqual(leftovers(dir), []);
});

// Windows won't rename over a file another program has open, but it does let
// the open file itself be renamed (Node and most readers allow that). So the
// fallback moves the old file aside, then moves the new one in — nothing is
// ever overwritten in place.
test("when the target can't be replaced, the old file is moved aside and the new one moved in", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  const rename = (a, b) => { if (b === f && a.endsWith(".tmp") && fs.existsSync(f)) throw errno("EPERM"); fs.renameSync(a, b); };
  assert.equal(writeFileAtomic(f, "new", { rename, delayMs: 1, retries: 1 }), "swapped");
  assert.equal(fs.readFileSync(f, "utf8"), "new");
  assert.deepEqual(leftovers(dir), []);
});

test("if moving the new file in fails after the old one was moved aside, the old one is put back", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  let asideDone = false;
  const rename = (a, b) => {
    if (a === f) { asideDone = true; return fs.renameSync(a, b); }   // moving the old file aside works
    if (b === f && a.endsWith(".tmp") && asideDone && fs.readFileSync(a, "utf8") === "new") throw errno("EBUSY");
    if (b === f && a.endsWith(".tmp") && !asideDone) throw errno("EPERM");
    return fs.renameSync(a, b);
  };
  assert.throws(() => writeFileAtomic(f, "new", { rename, delayMs: 1, retries: 1 }), (e) => e.code === "EBUSY" && /data\.js/.test(e.message));
  assert.equal(fs.readFileSync(f, "utf8"), "old");
  assert.deepEqual(leftovers(dir), []);
});

test("if neither the new nor the old file can be put in place, both are kept and named", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  const rename = (a, b) => { if (a === f) return fs.renameSync(a, b); if (b === f) throw errno("EBUSY"); return fs.renameSync(a, b); };
  let err;
  try { writeFileAtomic(f, "new", { rename, delayMs: 1, retries: 1 }); } catch (e) { err = e; }
  assert.ok(err);
  const kept = leftovers(dir);
  assert.equal(kept.length, 2, "both complete copies survive");
  const contents = kept.map((k) => fs.readFileSync(path.join(dir, k), "utf8")).sort();
  assert.deepEqual(contents, ["new", "old"]);
  for (const k of kept) assert.ok(err.message.includes(k), "the error names " + k);
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
// the write fail: the rename goes through, or the old file is moved aside.
test("replacing a file another handle has open still succeeds", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old");
  const fd = fs.openSync(f, "r");
  try {
    const how = writeFileAtomic(f, "new while open", { delayMs: 1 });
    assert.ok(how === "renamed" || how === "swapped", how);
  } finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(f, "utf8"), "new while open");
  assert.deepEqual(leftovers(dir), []);
});

// on a FIRST save there is no old file. When
// the new file can't be renamed into place (antivirus scanning the fresh temp
// file), the fallback's "move the old one aside" step hits ENOENT. That used
// to be reported as "another program is holding data.js … the previous
// version is unchanged" — there is no previous version, and data.js isn't
// what's held.
test("a first save whose new file is held says so, without claiming a previous version", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  const rename = (a, b) => { if (a.endsWith(".tmp") && b === f) throw errno("EPERM"); return fs.renameSync(a, b); };
  let err;
  try { writeFileAtomic(f, "first", { rename, delayMs: 1, retries: 1 }); } catch (e) { err = e; }
  assert.ok(err, "the write reports the failure");
  assert.equal(err.path, f);
  assert.ok(err.userMessage, "it carries a plain sentence for the user");
  assert.match(err.userMessage, /data\.js/);
  assert.match(err.userMessage, /new file/i);
  assert.doesNotMatch(err.userMessage, /previous version/i);
  assert.doesNotMatch(err.userMessage, /holding it open/i);
  assert.ok(!fs.existsSync(f));
  assert.deepEqual(leftovers(dir), []);
});

// fs.writeSync may write fewer bytes than asked (POSIX, a nearly full disk)
// without throwing. The rest of the chunk must still be written, and a write
// that makes no progress at all must fail rather than save a cut-off file.
test("writeChunksAtomic finishes a chunk the OS wrote only part of", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  const chunks = ["window.CHAT_DATA = {", "\"conversations\":[]", "};\n"];
  const real = fs.writeSync;
  let shorted = false;
  fs.writeSync = function (fd, data, ...rest) {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (!shorted && buf.toString() === "};\n") { shorted = true; return real.call(fs, fd, buf, 0, buf.length - 1); }
    return real.call(fs, fd, data, ...rest);
  };
  try { writeChunksAtomic(f, chunks); }
  finally { fs.writeSync = real; }
  assert.ok(shorted, "the short write happened");
  assert.equal(fs.readFileSync(f, "utf8"), chunks.join(""));
  assert.deepEqual(leftovers(dir), []);
});

test("writeChunksAtomic throws when a write makes no progress, and the old file stays", () => {
  const dir = scratch();
  const f = path.join(dir, "data.js");
  fs.writeFileSync(f, "old archive");
  const real = fs.writeSync;
  fs.writeSync = () => 0;
  let err;
  try { writeChunksAtomic(f, ["new ", "archive"]); }
  catch (e) { err = e; }
  finally { fs.writeSync = real; }
  assert.ok(err, "the write must fail");
  assert.equal(fs.readFileSync(f, "utf8"), "old archive");
  assert.deepEqual(leftovers(dir), []);
});
