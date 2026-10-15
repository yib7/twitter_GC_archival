/*
 * Test-only preload for a spawned server (node --require <this file>):
 *   - counts the file read streams the server has open (each leaves the count
 *     when it closes), reported by GET /__test/open-streams;
 *   - GCA_TEST_UNREADABLE=<regex>: createReadStream of a matching path fails
 *     to open, as a file that stat sees but can't read would (a OneDrive
 *     placeholder offline, a file antivirus has locked).
 */
"use strict";
const fs = require("fs");
const http = require("http");

const open = new Set();
const bad = process.env.GCA_TEST_UNREADABLE ? new RegExp(process.env.GCA_TEST_UNREADABLE) : null;
const realStream = fs.createReadStream;
fs.createReadStream = function (p, opts) {
  const s = realStream.call(fs, bad && bad.test(String(p)) ? String(p) + ".unreadable-in-this-test" : p, opts);
  open.add(s);
  s.on("close", () => open.delete(s));
  return s;
};
const realCreate = http.createServer;
http.createServer = function (handler) {
  return realCreate.call(http, (req, res) => {
    if (req.url === "/__test/open-streams") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ open: open.size }));
    }
    return handler(req, res);
  });
};
