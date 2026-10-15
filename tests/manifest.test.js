/*
 * SP7: pick the archive root. A real X archive lists its data files in
 * data/manifest.js (window.__THAR_CONFIG = {…}); the wizard reads it to find
 * the group messages files (every part), the headers and the group media
 * folder, and falls back to scanning file names when it is missing or
 * unusable. Paths from the manifest are never followed outside the folder the
 * user picked (no "..", no absolute paths, no symlink / junction escapes).
 * Synthetic archives only (tests/fixtures/x-export.js).
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const fsio = require("../scripts/fs-io.js");
const X = require("./fixtures/x-export.js");

const tmpDirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gca-manifest-")); tmpDirs.push(d); return d; }
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const SPEC = {
  messages: ["data/direct-messages-group.js", "data/direct-messages-group-part1.js"],
  headers: ["data/direct-message-group-headers.js"],
  mediaDirectory: "data/direct_messages_group_media",
};
const base = (list) => list.map((f) => path.basename(f));

/* ---- parseManifest (pure) ------------------------------------------------ */
test("parseManifest reads a real-shaped manifest: group messages (in part order), headers, media folder", () => {
  const m = core.parseManifest(X.manifestText(SPEC));
  assert.equal(m.ok, true);
  assert.deepEqual(m.messages, SPEC.messages);
  assert.deepEqual(m.headers, SPEC.headers);
  assert.deepEqual(m.mediaDirs, ["data/direct_messages_group_media"]);
  assert.equal(m.dmFiles, 1, "the 1:1 DM file is noticed (and not imported)");
});

test("parseManifest tolerates a BOM, no semicolon, out-of-order parts and variant key spellings", () => {
  const spec = { messages: [], headers: [] };
  const extraTypes = {
    directMessagesGroup: { files: [
      { fileName: "data/direct-messages-group-part1.js", globalName: "YTD.direct_messages_group.part1" },
      { fileName: "data/direct-messages-group.js", globalName: "YTD.direct_messages_group.part0" },
    ] },
    DirectMessagesGroupHeaders: { files: [{ fileName: "data/direct-messages-group-headers.js" }] },
  };
  const text = X.manifestText(Object.assign({}, spec, { extraTypes }), { bom: true, noSemicolon: true });
  const m = core.parseManifest(text);
  assert.equal(m.ok, true);
  // parts listed out of order come back in part order (by their globalName)
  assert.deepEqual(m.messages, ["data/direct-messages-group.js", "data/direct-messages-group-part1.js"]);
  assert.deepEqual(m.headers, ["data/direct-messages-group-headers.js"], "a plural, capitalised type key with no globalName is still the headers");
  assert.deepEqual(m.mediaDirs, []);
});

test("parseManifest classifies a file by its globalName even under an unexpected type key", () => {
  const extraTypes = { somethingNew: { files: [{ fileName: "data/dm-groups-extra.js", globalName: "YTD.direct_messages_group.part2" }] } };
  const m = core.parseManifest(X.manifestText(Object.assign({}, SPEC, { extraTypes })));
  assert.deepEqual(m.messages, SPEC.messages.concat(["data/dm-groups-extra.js"]));
});

test("parseManifest says why it can't be used", () => {
  for (const bad of ["", "window.__THAR_CONFIG = ", "window.__THAR_CONFIG = { not json", "window.__THAR_CONFIG = {\"userInfo\": {}};", "[1,2,3]"]) {
    const m = core.parseManifest(bad);
    assert.equal(m.ok, false, JSON.stringify(bad));
    assert.equal(typeof m.error, "string");
  }
  const noGroups = core.parseManifest("window.__THAR_CONFIG = " + JSON.stringify({ dataTypes: { account: { files: [{ fileName: "data/account.js" }] } } }));
  assert.equal(noGroups.ok, true);
  assert.deepEqual(noGroups.messages, []);
});

/* ---- locateExport (filesystem) ----------------------------------------- */
test("locateExport: the archive root is resolved through data/manifest.js", () => {
  const f = X.writeExport(scratch(), { manifest: true });
  const loc = fsio.locateExport(f.root);
  assert.equal(loc.error, undefined);
  assert.equal(loc.via, "manifest");
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js", "direct-messages-group-part1.js"]);
  assert.deepEqual(base(loc.headers), ["direct-message-group-headers.js"]);
  assert.equal(path.basename(loc.mediaDir), "direct_messages_group_media");
  assert.ok(loc.notes.some((n) => n.code === "dm-file"));
});

test("locateExport: picking the data folder itself, or a file in the archive root, works too", () => {
  const f = X.writeExport(scratch(), { manifest: true });
  for (const picked of [f.data, path.join(f.root, "Your archive.html")]) {
    const loc = fsio.locateExport(picked);
    assert.equal(loc.via, "manifest", picked);
    assert.equal(loc.messages.length, 2);
    assert.equal(loc.headers.length, 1);
    assert.ok(loc.mediaDir);
  }
});

test("locateExport follows the manifest, not file names: a part only the manifest knows about is found", () => {
  const f = X.writeExport(scratch(), { manifest: true });
  fs.renameSync(f.part1, path.join(f.data, "group-chats-extra.js"));
  X.writeManifest(f.root, Object.assign({}, SPEC, { messages: ["data/direct-messages-group.js", "data/group-chats-extra.js"] }));
  const loc = fsio.locateExport(f.root);
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js", "group-chats-extra.js"]);
});

test("locateExport falls back to scanning file names when there is no (usable) manifest", () => {
  const f = X.writeExport(scratch());   // no manifest
  const loc = fsio.locateExport(f.root);
  assert.equal(loc.via, "scan");
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js", "direct-messages-group-part1.js"]);
  assert.deepEqual(base(loc.headers), ["direct-message-group-headers.js"]);
  assert.ok(loc.mediaDir);
  const g = X.writeExport(scratch(), { manifest: true });
  fs.writeFileSync(g.manifest, "window.__THAR_CONFIG = { broken");
  const loc2 = fsio.locateExport(g.root);
  assert.equal(loc2.via, "scan");
  assert.ok(loc2.notes.some((n) => n.code === "manifest-unreadable"));
  assert.equal(loc2.messages.length, 2);
});

// SP7 fix round 1 (#6): the manifest isn't the whole story — a part on disk
// that a stale manifest doesn't list is still found (by its export name).
test("locateExport adds a part file on disk that the manifest doesn't list", () => {
  const f = X.writeExport(scratch(), { manifest: true });
  X.writeManifest(f.root, Object.assign({}, SPEC, { messages: ["data/direct-messages-group.js", "data/direct-messages-group-part2.js"] }));   // part1 not listed
  fs.writeFileSync(path.join(f.data, "direct-messages-group-part2.js"), X.ytd("direct_messages_group", "part2", [X.conv("1000000001", [X.gmsg(9009, 111, X.T0 + 900e3, "part two")])]));
  const loc = fsio.locateExport(f.root);
  assert.equal(loc.via, "manifest");
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js", "direct-messages-group-part1.js", "direct-messages-group-part2.js"]);
  const extra = loc.notes.find((n) => n.code === "manifest-extra");
  assert.ok(extra, JSON.stringify(loc.notes));
  assert.deepEqual(extra.files, ["direct-messages-group-part1.js"]);
});

test("locateExport reports manifest files that are missing (a part that didn't unzip)", () => {
  const f = X.writeExport(scratch(), { manifest: true });
  fs.rmSync(f.part1);
  const loc = fsio.locateExport(f.root);
  assert.equal(loc.via, "manifest");
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js"]);
  const miss = loc.notes.find((n) => n.code === "manifest-missing");
  assert.ok(miss);
  assert.deepEqual(miss.files, ["direct-messages-group-part1.js"]);
});

test("locateExport never follows manifest paths outside the picked folder", () => {
  const outside = scratch("gca-manifest-outside-");
  fs.writeFileSync(path.join(outside, "secret.js"), X.ytd("direct_messages_group", "part0", []));
  const f = X.writeExport(scratch(), { manifest: true });
  const rel = path.relative(f.root, path.join(outside, "secret.js")).split(path.sep).join("/");
  X.writeManifest(f.root, Object.assign({}, SPEC, {
    messages: SPEC.messages.concat(["data/../../" + path.basename(outside) + "/secret.js", rel, path.join(outside, "secret.js"), "/etc/passwd", "C:\\Windows\\win.ini"]),
    mediaDirectory: "../" + path.basename(outside),
  }));
  const loc = fsio.locateExport(f.root);
  assert.deepEqual(base(loc.messages), ["direct-messages-group.js", "direct-messages-group-part1.js"], "only the two real parts");
  assert.ok(loc.messages.every((p) => !p.includes(path.basename(outside))));
  const unsafe = loc.notes.find((n) => n.code === "manifest-unsafe");
  assert.ok(unsafe && unsafe.files.length >= 5, JSON.stringify(loc.notes));
  assert.equal(path.basename(loc.mediaDir), "direct_messages_group_media", "an escaping media folder falls back to the standard one inside");
});

test("locateExport doesn't follow a link (junction / symlink) inside the archive that points outside it", () => {
  const outside = scratch("gca-manifest-outside-");
  fs.mkdirSync(path.join(outside, "media"));
  fs.writeFileSync(path.join(outside, "media", "9002-Leak.png"), "not part of the archive");
  const f = X.writeExport(scratch(), { manifest: true });
  const link = path.join(f.data, "linked_media");
  fs.symlinkSync(path.join(outside, "media"), link, "junction");   // a junction needs no admin rights on Windows
  X.writeManifest(f.root, Object.assign({}, SPEC, { mediaDirectory: "data/linked_media" }));
  const loc = fsio.locateExport(f.root);
  assert.equal(path.basename(loc.mediaDir), "direct_messages_group_media");
  assert.ok(loc.notes.some((n) => n.code === "manifest-unsafe" && n.files.includes("data/linked_media")));
});

test("locateExport explains a folder with no group chat files", () => {
  const empty = scratch();
  fs.writeFileSync(path.join(empty, "notes.txt"), "x");
  const loc = fsio.locateExport(empty);
  assert.match(loc.error, /No group chat files were found/);
  assert.match(fsio.locateExport(path.join(empty, "nope")).error, /not found/i);
});
