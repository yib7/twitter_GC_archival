require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// copyMediaFlat() copies the group media folder into personal_data/media/.
// SP-7 (deep audit) changed it: it used to walk the whole tree and copy every
// file, so a mis-picked data/ folder dragged 1:1 DMs and account.js into the
// servable media folder. It now copies ONLY top-level files named like X
// message media and counts everything else as `unmatched`. Because it no
// longer recurses, the old "same basename in two subfolders" case (P2-5) can't
// arise any more; that test is replaced by the ones below.
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

test("copyMediaFlat copies only top-level message media and counts the rest", () => {
  const src = mkScratch("gca-media-src-");
  const dest = mkScratch("gca-media-dest-");
  fs.rmSync(dest, { recursive: true, force: true });   // copyMediaFlat must create it

  fs.writeFileSync(path.join(src, "9001-AbC.jpg"), "a");
  fs.writeFileSync(path.join(src, "9002-dEf.PNG"), "b");
  fs.writeFileSync(path.join(src, "9003-clip.mp4"), "c");
  fs.writeFileSync(path.join(src, "direct-messages.js"), "private");   // never media
  fs.writeFileSync(path.join(src, "photo.jpg"), "no message id");
  fs.mkdirSync(path.join(src, "nested"));
  fs.writeFileSync(path.join(src, "nested", "9004-Deep.jpg"), "not walked");

  const result = copyMediaFlat(src, dest);
  assert.equal(result.copied, 3);
  assert.equal(result.unmatched, 3, "direct-messages.js, photo.jpg and the nested/ folder");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["9001-AbC.jpg", "9002-dEf.PNG", "9003-clip.mp4"]);
});

test("copyMediaFlat never follows a symlink out of the media folder", (t) => {
  const src = mkScratch("gca-media-src-");
  const outside = mkScratch("gca-media-outside-");
  const dest = path.join(mkScratch("gca-media-dest-"), "media");
  fs.writeFileSync(path.join(outside, "9009-Secret.jpg"), "outside");
  fs.writeFileSync(path.join(src, "9001-AbC.jpg"), "a");
  let linked = true;
  try { fs.symlinkSync(path.join(outside, "9009-Secret.jpg"), path.join(src, "9009-Secret.jpg"), "file"); }
  catch (e) { linked = false; t.diagnostic("symlinks need extra rights here (" + e.code + "); checked the plain copy only"); }
  const result = copyMediaFlat(src, dest);
  assert.equal(result.copied, 1);
  assert.deepEqual(fs.readdirSync(dest), ["9001-AbC.jpg"]);
  if (linked) assert.equal(result.unmatched, 1, "the symlink is counted, not copied");
});
