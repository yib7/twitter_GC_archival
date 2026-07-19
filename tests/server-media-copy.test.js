const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Regression for SP6 (P2-5): copyMediaFlat() flattens every media file into one
// destination dir by basename. Two source files sharing a basename in different
// subfolders used to silently clobber (last-write-wins, data loss with no
// signal). It must now skip the duplicate (first-encountered wins) and report
// how many were skipped, so the caller can warn instead of losing data quietly.
//
// require()ing scripts/server.js only works because it's guarded with
// `if (require.main === module)` around server.listen() — requiring it here
// must NOT bind a socket. If that guard regresses, this require() call itself
// would attempt to listen and could hang/throw (EADDRINUSE races in CI).
const { copyMediaFlat } = require("../scripts/server.js");

// HARD RULE: fs.mkdtempSync scratch dirs only — never personal_data*/ or exports/.
const tmpDirs = [];
function mkScratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test("copyMediaFlat skips duplicate basenames instead of clobbering, and reports the count", () => {
  const src = mkScratch("gca-media-src-");
  const dest = mkScratch("gca-media-dest-");
  fs.rmSync(dest, { recursive: true, force: true });   // copyMediaFlat must create it

  fs.mkdirSync(path.join(src, "a"));
  fs.mkdirSync(path.join(src, "b"));
  fs.mkdirSync(path.join(src, "c"));
  fs.writeFileSync(path.join(src, "a", "photo.jpg"), "from-a");
  fs.writeFileSync(path.join(src, "b", "photo.jpg"), "from-b");   // same basename, different subdir
  fs.writeFileSync(path.join(src, "a", "unique1.png"), "u1");
  fs.writeFileSync(path.join(src, "c", "unique2.png"), "u2");

  const result = copyMediaFlat(src, dest);
  assert.equal(result.copied, 3, "3 distinct basenames should be copied (photo.jpg once, unique1.png, unique2.png)");
  assert.equal(result.skipped, 1, "the second photo.jpg should be skipped, not overwrite the first");

  const names = fs.readdirSync(dest).sort();
  assert.deepEqual(names, ["photo.jpg", "unique1.png", "unique2.png"]);
  // First-encountered wins: fs.readdirSync is alphabetical by dirent name at each
  // level, so "a" is walked before "b" — a/photo.jpg ("from-a") must survive.
  assert.equal(fs.readFileSync(path.join(dest, "photo.jpg"), "utf8"), "from-a");
});
