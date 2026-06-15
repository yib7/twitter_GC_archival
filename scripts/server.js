/*
 * server.js — optional local web server for the Group Chat Archive.
 *
 * You usually DON'T need this: just double-click index.html.
 * Use this only if your browser blocks local videos/images over file://.
 *
 * Run:  node server.js     then open  http://localhost:8765
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");   // serve the project root (this script lives in scripts/)
const PORT = 8765;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = parseInt(s, 10) || 0;
      const end = e ? parseInt(e, 10) : st.size - 1;
      res.writeHead(206, {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(PORT, () => console.log("Group Chat Archive running at  http://localhost:" + PORT + "\nPress Ctrl+C to stop."));
