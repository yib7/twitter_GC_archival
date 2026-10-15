/*
 * SP6 pure helpers in scripts/server-core.js (no server, no filesystem).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../scripts/server-core.js");

// ---- SP-1 / SP-17: what a failed build tells the user ----------------------
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
  const odd = new Error("weird\n    at somewhere (x.js:1:1)");
  assert.doesNotMatch(core.friendlyError(odd), /at somewhere/);
});

// ---- SP-7: only the group media folder, only message media ---------------
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
