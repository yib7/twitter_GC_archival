/*
 * Pure helpers in scripts/server-core.js (no server, no filesystem).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../scripts/server-core.js");

// ---- what a failed build tells the user ----------------------
test("buildFailureMessage shows only the build's own BUILD ERROR line", () => {
  const stderr = "something noisy\nBUILD ERROR: The file is empty.\n    at Object.<anonymous> (C:\\x\\build.js:1:1)\n";
  assert.equal(core.buildFailureMessage(stderr), "The file is empty.");
});

test("buildFailureMessage maps an out-of-memory crash to plain language, never the native trace", () => {
  const oom = "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n 1: 00007FF6 node::Abort\n";
  const msg = core.buildFailureMessage(oom);
  assert.match(msg, /ran out of memory/);
  assert.doesNotMatch(msg, /FATAL|00007FF6|Abort/);
});

test("buildFailureMessage falls back to a generic sentence for anything unrecognised", () => {
  const msg = core.buildFailureMessage("TypeError: x is not a function\n    at foo (build.js:3:4)");
  assert.match(msg, /stopped unexpectedly/);
  assert.doesNotMatch(msg, /TypeError|build\.js:3/);
});

test("friendlyError turns common Node fs errors into plain sentences without stack traces", () => {
  const e = (code, p) => Object.assign(new Error(code + ": operation failed, copyfile '" + (p || "") + "'"), { code, path: p });
  assert.match(core.friendlyError(e("EPERM", "C:\\Users\\me\\data\\junc")), /denied.*junc/);
  assert.match(core.friendlyError(e("EACCES", "/x/y")), /denied/);
  assert.match(core.friendlyError(e("ENOSPC")), /disk is full/);
  assert.match(core.friendlyError(e("EBUSY", "/a/data.js")), /in use/);
  assert.match(core.friendlyError(e("ENOENT", "/a/b.js")), /couldn't be found.*b\.js/);
  assert.match(core.friendlyError(e("EISDIR", "/a/dir")), /folder/);
  const http = Object.assign(new Error("Uploaded images must be 10 MB or smaller."), { statusCode: 413 });
  assert.equal(core.friendlyError(http), "Uploaded images must be 10 MB or smaller.", "our own user-facing messages pass through");
  // Fs-io's "held by another program" errors carry their own sentence
  const held = Object.assign(new Error("x"), { code: "EBUSY", path: "/a/data.js", userMessage: "Couldn't save data.js: close the other program." });
  assert.equal(core.friendlyError(held), "Couldn't save data.js: close the other program.");
  const odd = new Error("weird\n    at somewhere (x.js:1:1)");
  assert.doesNotMatch(core.friendlyError(odd), /at somewhere/);
});

// ---- only the group media folder, only message media ---------------
test("MEDIA_FILE_RE matches X message media names only", () => {
  for (const ok of ["9002-AbCdEf.png", "123-x.JPG", "1-a.jpeg", "77-clip.mp4", "8-a.webm", "9-b.mov", "10-c.m4v", "11-d.gif", "12-e.webp"]) assert.match(ok, core.MEDIA_FILE_RE, ok);
  for (const bad of ["direct-messages.js", "account.js", "photo.jpg", "9002-a.txt", "9002-.png", "abc-1.png", "9002-a.png.exe", "desktop.ini"]) assert.doesNotMatch(bad, core.MEDIA_FILE_RE, bad);
});

test("mediaFolderProblem refuses the data folder, any folder of .js files and 1:1 DM media", () => {
  assert.match(core.mediaFolderProblem("data", ["9002-a.png"]), /data folder/);
  assert.match(core.mediaFolderProblem("export", ["direct-messages.js", "account.js"]), /data folder/);
  assert.match(core.mediaFolderProblem("direct_messages_media", ["8001-a.jpg"]), /1:1/);
  assert.equal(core.mediaFolderProblem("direct_messages_group_media", ["9002-a.png"]), null);
  assert.equal(core.mediaFolderProblem("my media", []), null);
});

// ---- the build gets a heap sized to the machine -------------------
test("buildHeapMb gives the build about half the RAM, clamped to 2-16 GB", () => {
  const GB = 1024 ** 3;
  assert.equal(core.buildHeapMb(8 * GB), 4096);
  assert.equal(core.buildHeapMb(4 * GB), 2048);
  assert.equal(core.buildHeapMb(2 * GB), 2048, "never below Node's usual default");
  assert.equal(core.buildHeapMb(64 * GB), 16384, "capped");
  assert.equal(core.buildHeapMb(NaN), 2048, "unknown RAM falls back to the floor");
});

test("buildNodeArgs passes the heap flag before the build script", () => {
  assert.deepEqual(core.buildNodeArgs("/app/scripts/build.js", 16 * 1024 ** 3), ["--max-old-space-size=8192", "/app/scripts/build.js"]);
});

// ---- the native pickers need the page's token, not just no Referer ----
test("isPickerRequestAllowed needs the per-process token AND an own/absent Origin", () => {
  const T = "a".repeat(64), P = 8765;
  const ok = (h) => core.isPickerRequestAllowed(h, T, P);
  assert.equal(ok({ "x-gca-token": T }), true, "same-origin fetch: token, no Origin");
  assert.equal(ok({ "x-gca-token": T, origin: "http://127.0.0.1:8765", "sec-fetch-site": "same-origin" }), true);
  assert.equal(ok({}), false, "an <img referrerpolicy=no-referrer> sends neither header nor token");
  assert.equal(ok({ "x-gca-token": "b".repeat(64) }), false, "wrong token");
  assert.equal(ok({ "x-gca-token": T.slice(1) }), false, "different length");
  assert.equal(ok({ "x-gca-token": T, origin: "http://evil.com" }), false, "foreign Origin even with the token");
  assert.equal(ok({ "x-gca-token": T, "sec-fetch-site": "cross-site" }), false, "browser says cross-site");
  assert.equal(ok({ "x-gca-token": T, "sec-fetch-site": "same-site" }), false, "another localhost port is same-site, not same-origin");
  assert.equal(core.isPickerRequestAllowed({ "x-gca-token": "" }, "", P), false, "never allowed with an empty server token");
});

// ---- cross-site reads and writes ----------------------------------
test("isForeignFetchSite is true only when the browser names another site", () => {
  assert.equal(core.isForeignFetchSite({}), false, "no header: curl, an older browser");
  assert.equal(core.isForeignFetchSite({ "sec-fetch-site": "" }), false);
  assert.equal(core.isForeignFetchSite({ "sec-fetch-site": "same-origin" }), false);
  assert.equal(core.isForeignFetchSite({ "sec-fetch-site": "none" }), false, "a typed-in address or bookmark");
  assert.equal(core.isForeignFetchSite({ "sec-fetch-site": "cross-site" }), true);
  assert.equal(core.isForeignFetchSite({ "sec-fetch-site": "same-site" }), true, "another localhost port");
  assert.equal(core.isForeignFetchSite(null), false);
});

test("isPrivateServedPath covers the archive, the names and everything under personal_data/", () => {
  for (const p of ["/data.js", "/names.local.js", "/personal_data/data.js", "/personal_data/local.js", "/personal_data/media/9001-a.mp4", "/personal_data/pfps/ann_pfp.png", "/personal_data"]) {
    assert.equal(core.isPrivateServedPath(p), true, p);
  }
  for (const p of ["/", "/index.html", "/setup.html", "/data.sample.js", "/src/app.js", "/lib/x.js", "/sample_media/photo-1.svg", "/favicon.ico"]) {
    assert.equal(core.isPrivateServedPath(p), false, p);
  }
});

// ---- pasted paths -------------------------------------------------
test("normalizeUserPath strips one pair of surrounding quotes (Explorer's Copy as path)", () => {
  const win = { platform: "win32", home: "C:/Users/me" };
  assert.equal(core.normalizeUserPath('"C:/Users/me/Downloads/data/direct-messages-group.js"', win), "C:/Users/me/Downloads/data/direct-messages-group.js");
  assert.equal(core.normalizeUserPath("  'D:/x y/z.js'  ", win), "D:/x y/z.js");
  assert.equal(core.normalizeUserPath('"unbalanced', win), '"unbalanced', "only a matching pair is removed");
});

test("normalizeUserPath expands a leading ~ to the home folder", () => {
  const nix = { platform: "linux", home: "/home/me" };
  assert.equal(core.normalizeUserPath("~/Downloads/data", nix), "/home/me/Downloads/data");
  assert.equal(core.normalizeUserPath("~", nix), "/home/me");
  assert.equal(core.normalizeUserPath("~bob/x", nix), "~bob/x", "other users' ~name is left alone");
  assert.equal(core.normalizeUserPath('"~/a b/c"', nix), "/home/me/a b/c");
});

test("normalizeUserPath unescapes Terminal-style backslash-spaces off Windows only", () => {
  const BS = String.fromCharCode(92);
  assert.equal(core.normalizeUserPath("/Users/me/My" + BS + " Archive/data", { platform: "darwin", home: "/Users/me" }), "/Users/me/My Archive/data");
  const winPath = "C:" + BS + "My Stuff" + BS + "data";
  assert.equal(core.normalizeUserPath(winPath, { platform: "win32", home: "C:" + BS + "Users" + BS + "me" }), winPath, "Windows backslashes are separators");
});

test("pathNotFoundHint gives a full-path example for the platform", () => {
  assert.match(core.pathNotFoundHint("win32", "direct-messages-group.js"), /full path.*C:.*Users.*data.*direct-messages-group\.js/);
  assert.match(core.pathNotFoundHint("darwin", "direct_messages_group_media"), /full path.*\/Users\/.*data\/direct_messages_group_media/);
});

// ---- what a rebuild keeps -------------------------------------------
test("referencedMediaNames lists every m and mx file name; sameIdSet ignores order", () => {
  const data = { conversations: [{ msgs: [
    { i: "1", m: "personal_data/media/1-a.png", mx: [{ m: "personal_data/media/1-b.jpg" }] },
    { i: "2" },
  ] }, { msgs: [{ i: "3", m: "personal_data/media/3-c.mp4" }] }] };
  assert.deepEqual([...core.referencedMediaNames(data)].sort(), ["1-a.png", "1-b.jpg", "3-c.mp4"]);
  assert.deepEqual([...core.referencedMediaNames(null)], []);
  assert.equal(core.sameIdSet(["1", "2"], [2, "1"]), true);
  assert.equal(core.sameIdSet(undefined, []), true);
  assert.equal(core.sameIdSet(["1"], []), false);
  assert.equal(core.sameIdSet(["1"], ["2"]), false);
});

// ---- a free-space check before copying gigabytes ------------------------
test("diskSpaceProblem says how much is needed and free, in plain units", () => {
  const MB = 1048576, GB = 1024 * MB;
  assert.equal(core.diskSpaceProblem(2 * GB, 10 * GB), null);
  const msg = core.diskSpaceProblem(3.5 * GB, 1.2 * GB);
  assert.match(msg, /Not enough free disk space/);
  assert.match(msg, /3\.5 GB/);
  assert.match(msg, /1\.2 GB free/);
  assert.match(core.diskSpaceProblem(300 * MB, 20 * MB), /300 MB.*20 MB free/);
  assert.equal(core.diskSpaceProblem(5 * GB, NaN), null, "unknown free space never blocks");
});
