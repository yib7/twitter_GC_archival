/*
 * Synthetic Twitter/X export generator for the ingestion tests.
 *
 * Everything here is made up: numeric ids, invented text, fake media names.
 * It follows the export shape described in the deep audit's Appendix C:
 *   data/direct-messages-group.js            window.YTD.direct_messages_group.part0 = [...]
 *   data/direct-messages-group-part1.js      window.YTD.direct_messages_group.part1 = [...]
 *   data/direct-message-group-headers.js     window.YTD.direct_message_group_headers.part0 = [...]
 *   data/direct-messages.js                  window.YTD.direct_messages.part0 = [...]   (1:1 DMs)
 *   data/account.js                          window.YTD.account.part0 = [...]
 *   data/direct_messages_group_media/<msgId>-<rand>.<ext>
 * The pretty-printed layout (2-space indent) matches how X writes the files.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const iso = (ms) => new Date(ms).toISOString();

// One group message in export form.
function gmsg(id, senderId, ms, text, extra) {
  return { messageCreate: Object.assign({ id: String(id), senderId: String(senderId), createdAt: iso(ms), text, urls: [], reactions: [], mediaUrls: [] }, extra || {}) };
}
// The same message as the headers file carries it: no text, no urls.
function hmsg(id, senderId, ms) {
  return { messageCreate: { id: String(id), senderId: String(senderId), createdAt: iso(ms) } };
}
function conv(conversationId, messages) {
  return { dmConversation: { conversationId: String(conversationId), messages } };
}
function ytd(global, part, arr) {
  return "window.YTD." + global + "." + part + " = " + JSON.stringify(arr, null, 2);
}

const T0 = Date.parse("2021-06-01T12:00:00Z");

// The default two-group export used by most tests.
//   G 1000000001: 5 messages over two part files (3 in part0, 2 in part1), a
//                 lurker (444) known only from the headers, a name event.
//   G 1000000002: 2 messages.
//   1:1 DM 111-222: must never be ingested.
function defaultExport() {
  const g1part0 = [
    gmsg(9001, 111, T0, "hello from the first part 🎉"),
    gmsg(9002, 222, T0 + 60e3, "a photo \"quoted\" with a \\ backslash"),
    gmsg(9003, 111, T0 + 120e3, "line one\nline two"),
    { conversationNameUpdate: { initiatingUserId: "111", name: "Synthetic Crew", createdAt: iso(T0 + 1000) } },
  ];
  const g1part1 = [
    gmsg(9004, 333, T0 + 180e3, "from the second part file"),
    gmsg(9005, 222, T0 + 240e3, "último mensaje — ünïcödé"),
  ];
  const g2 = [
    gmsg(9101, 111, T0 + 10e3, "other group message one"),
    gmsg(9102, 555, T0 + 20e3, "other group message two"),
  ];
  return {
    part0: [conv("1000000001", g1part0), conv("1000000002", g2), conv("111-222", [gmsg(8001, 111, T0, "a private 1:1 message")])],
    part1: [conv("1000000001", g1part1)],
    headers: [
      conv("1000000001", [
        hmsg(9001, 111, T0), hmsg(9002, 222, T0 + 60e3), hmsg(9003, 111, T0 + 120e3),
        hmsg(9004, 333, T0 + 180e3), hmsg(9005, 222, T0 + 240e3),
        { participantsJoin: { initiatingUserId: "111", userIds: ["444"], createdAt: iso(T0 + 5000) } },
      ]),
      conv("1000000002", [hmsg(9101, 111, T0 + 10e3), hmsg(9102, 555, T0 + 20e3)]),
    ],
  };
}

// Write a whole synthetic archive into `root` (an mkdtemp dir). Returns paths.
function writeExport(root, opts) {
  opts = opts || {};
  const ex = defaultExport();
  const data = path.join(root, "data");
  const media = path.join(data, "direct_messages_group_media");
  fs.mkdirSync(media, { recursive: true });
  const bom = opts.bom ? "\uFEFF" : "";
  const files = {
    root, data, media,
    group: path.join(data, "direct-messages-group.js"),
    part1: path.join(data, "direct-messages-group-part1.js"),
    headers: path.join(data, "direct-message-group-headers.js"),
    dm: path.join(data, "direct-messages.js"),
    account: path.join(data, "account.js"),
  };
  fs.writeFileSync(files.group, bom + ytd("direct_messages_group", "part0", ex.part0));
  if (opts.parts !== false) fs.writeFileSync(files.part1, ytd("direct_messages_group", "part1", ex.part1));
  fs.writeFileSync(files.headers, ytd("direct_message_group_headers", "part0", ex.headers));
  fs.writeFileSync(files.dm, ytd("direct_messages", "part0", [conv("111-222", [gmsg(8001, 111, T0, "private")])]));
  fs.writeFileSync(files.account, ytd("account", "part0", [{ account: { username: "nobody" } }]));
  // group media: two files for 9002, one for 9101; a 1:1 media folder
  // and a stray .js next to them exercise the media-folder checks.
  fs.writeFileSync(path.join(media, "9002-AbCdEf.png"), "png-1");
  fs.writeFileSync(path.join(media, "9002-ZzSecond.jpg"), "jpg-2");
  fs.writeFileSync(path.join(media, "9101-Other.mp4"), "mp4");
  fs.mkdirSync(path.join(data, "direct_messages_media"), { recursive: true });
  fs.writeFileSync(path.join(data, "direct_messages_media", "8001-Private.jpg"), "private");
  if (opts.manifest) {
    files.manifest = writeManifest(root, {
      messages: [files.group].concat(opts.parts !== false ? [files.part1] : []).map((f) => "data/" + path.basename(f)),
      headers: ["data/" + path.basename(files.headers)],
      mediaDirectory: "data/direct_messages_group_media",
    });
    fs.writeFileSync(path.join(root, "Your archive.html"), "<!doctype html><title>Your archive</title>");
  }
  return files;
}

/* ---- data/manifest.js ---------------------------------------------- */
// A real X archive has data/manifest.js:
//   window.__THAR_CONFIG = { "userInfo": {…}, "archiveInfo": {…}, "readmeInfo": {…},
//     "dataTypes": { "<type>": { "mediaDirectory"?: "data/…", "files": [
//       { "fileName": "data/<file>.js", "globalName": "YTD.<global>.part<N>", "count": "<n>" } ] }, … } }
// Paths are relative to the archive root. Everything here is invented.
function manifestText(spec, opts) {
  opts = opts || {};
  const fileEntry = (global) => (f, i) => ({ fileName: f, globalName: "YTD." + global + ".part" + i, count: "1" });
  const dataTypes = {
    account: { files: [{ fileName: "data/account.js", globalName: "YTD.account.part0", count: "1" }] },
    directMessages: { mediaDirectory: "data/direct_messages_media", files: [{ fileName: "data/direct-messages.js", globalName: "YTD.direct_messages.part0", count: "1" }] },
    directMessagesGroup: Object.assign(spec.mediaDirectory != null ? { mediaDirectory: spec.mediaDirectory } : {}, { files: (spec.messages || []).map(fileEntry("direct_messages_group")) }),
    directMessageGroupHeaders: { files: (spec.headers || []).map(fileEntry("direct_message_group_headers")) },
  };
  const cfg = {
    userInfo: { accountId: "1", userName: "nobody", displayName: "Nobody" },
    archiveInfo: { sizeBytes: "1", generationDate: "2023-01-01T00:00:00.000Z", isPartialArchive: false, maxPartSizeBytes: "53687091200" },
    readmeInfo: { fileName: "data/README.txt", directory: "data/", name: "README.txt" },
    dataTypes: Object.assign(dataTypes, spec.extraTypes || {}),
  };
  return (opts.bom ? "\uFEFF" : "") + "window.__THAR_CONFIG = " + JSON.stringify(cfg, null, 2) + (opts.noSemicolon ? "" : ";") + "\n";
}
function writeManifest(root, spec, opts) {
  const f = path.join(root, "data", "manifest.js");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, manifestText(spec, opts));
  return f;
}

/* ---- an older export A and a newer, overlapping export B ------------ */
// A (written by writeExport): G1 1000000001 = 9001-9005 (333 sent 9004),
// G2 1000000002 = 9101-9102.
// B, a later download of the same account:
//   G1 again: 9003 + 9005 (overlap), 9006 by 222, 9007 by 111 (with a photo),
//             9008 by 333, and a newer name event.
//   G2 is gone from B (the user left it) — its history must survive the merge.
//   G3 1000000003 is new: 9201 by 111 (with a photo), 9202 by 666.
// B ships a manifest with a single messages file and a headers file.
function exportB() {
  const t = T0 + 30 * 86400e3;
  return {
    messages: [
      conv("1000000001", [
        gmsg(9003, 111, T0 + 120e3, "line one\nline two"),
        gmsg(9005, 222, T0 + 240e3, "último mensaje — ünïcödé"),
        gmsg(9006, 222, t, "a newer message from the second export"),
        gmsg(9007, 111, t + 60e3, "a newer photo from the second export"),
        gmsg(9008, 333, t + 120e3, "a newer message from someone removed"),
        { conversationNameUpdate: { initiatingUserId: "222", name: "Synthetic Crew II", createdAt: iso(t + 1000) } },
      ]),
      conv("1000000003", [
        gmsg(9201, 111, t + 10e3, "a brand new group chat in the newer export"),
        gmsg(9202, 666, t + 20e3, "hello from the newest group chat"),
      ]),
      conv("111-222", [gmsg(8002, 111, t, "another private 1:1 message")]),
    ],
    headers: [
      conv("1000000001", [hmsg(9003, 111, T0 + 120e3), hmsg(9005, 222, T0 + 240e3), hmsg(9006, 222, t), hmsg(9007, 111, t + 60e3), hmsg(9008, 333, t + 120e3)]),
      conv("1000000003", [hmsg(9201, 111, t + 10e3), hmsg(9202, 666, t + 20e3)]),
    ],
  };
}
function writeExportB(root) {
  const ex = exportB();
  const data = path.join(root, "data");
  const media = path.join(data, "direct_messages_group_media");
  fs.mkdirSync(media, { recursive: true });
  const files = {
    root, data, media,
    group: path.join(data, "direct-messages-group.js"),
    headers: path.join(data, "direct-message-group-headers.js"),
  };
  fs.writeFileSync(files.group, ytd("direct_messages_group", "part0", ex.messages));
  fs.writeFileSync(files.headers, ytd("direct_message_group_headers", "part0", ex.headers));
  fs.writeFileSync(path.join(data, "direct-messages.js"), ytd("direct_messages", "part0", [conv("111-222", [gmsg(8002, 111, T0, "private")])]));
  fs.writeFileSync(path.join(data, "account.js"), ytd("account", "part0", [{ account: { username: "nobody" } }]));
  fs.writeFileSync(path.join(media, "9002-AbCdEf.png"), "png-1");        // already in A
  fs.writeFileSync(path.join(media, "9007-NewPic.jpg"), "jpg-new");
  fs.writeFileSync(path.join(media, "9008-Removed.png"), "png-removed");  // a removed person's
  fs.writeFileSync(path.join(media, "9201-Group3.png"), "png-g3");
  files.manifest = writeManifest(root, {
    messages: ["data/direct-messages-group.js"],
    headers: ["data/direct-message-group-headers.js"],
    mediaDirectory: "data/direct_messages_group_media",
  });
  fs.writeFileSync(path.join(root, "Your archive.html"), "<!doctype html><title>Your archive</title>");
  return files;
}

module.exports = { gmsg, hmsg, conv, ytd, iso, T0, defaultExport, writeExport, manifestText, writeManifest, exportB, writeExportB };
