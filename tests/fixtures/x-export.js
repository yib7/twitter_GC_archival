/*
 * Synthetic Twitter/X export generator for the SP6 ingestion tests.
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
    data, media,
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
  // group media: two files for 9002 (SP-20), one for 9101; a 1:1 media folder
  // and a stray .js next to them exercise SP-7.
  fs.writeFileSync(path.join(media, "9002-AbCdEf.png"), "png-1");
  fs.writeFileSync(path.join(media, "9002-ZzSecond.jpg"), "jpg-2");
  fs.writeFileSync(path.join(media, "9101-Other.mp4"), "mp4");
  fs.mkdirSync(path.join(data, "direct_messages_media"), { recursive: true });
  fs.writeFileSync(path.join(data, "direct_messages_media", "8001-Private.jpg"), "private");
  return files;
}

module.exports = { gmsg, hmsg, conv, ytd, iso, T0, defaultExport, writeExport };
