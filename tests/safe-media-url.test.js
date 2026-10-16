// safeMediaUrl (src/shared-core.js) decides which media paths from data.js
// become a link or a photo/video source. Node's URL parser is the WHATWG one
// Firefox and Safari use, so the shapes Chromium happens to parse differently
// (file:////host/share keeps an empty host here) are pinned in this file;
// tests/archive-injection.spec.js covers the rendered viewer in Chromium.

require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const test = require("node:test");
const assert = require("node:assert");
const { safeMediaUrl } = require("../src/shared-core.js");

const VIEWER = "file:///C:/archive/index.html";
const SERVED = "http://127.0.0.1:8765/index.html";

test("relative media paths, http(s) and local file: URLs pass through unchanged", () => {
  for (const base of [VIEWER, SERVED]) {
    for (const ok of ["sample_media/photo-1.svg", "personal_data/media/a b.jpg", "https://example.test/x.png",
      "http://example.test/y.mp4", "file:///C:/archive/ok.pdf", "file:///home/me/ok.pdf"]) {
      assert.equal(safeMediaUrl(ok, base), ok, ok + " from " + base);
    }
  }
});

test("script, data and other schemes are refused", () => {
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "JAVASCRIPT:alert(1)",
    "data:text/html,<b>x</b>", "vbscript:x", "blob:http://example.test/1", "", null, undefined, 7, {}]) {
    assert.equal(safeMediaUrl(bad, VIEWER), "", JSON.stringify(bad));
  }
});

test("a file: URL that names another machine is refused, however the share is spelled", () => {
  for (const bad of [
    "file://attacker.example/share/x.pdf",
    "file:////attacker.example/share/x.pdf",
    "file://///attacker.example/share/x.pdf",
    "file:///\\\\attacker.example\\share\\x.pdf",
    "file:\\\\attacker.example\\share\\x.pdf",
    "//attacker.example/share/x.pdf",
    "\\\\attacker.example\\share\\x.pdf",
  ]) {
    assert.equal(safeMediaUrl(bad, VIEWER), "", bad);
  }
});

test("a viewer opened from a network share keeps its own media, and only its own", () => {
  // \\nas\share\archive\index.html reaches the page as either URL shape,
  // depending on the browser's parser
  for (const base of ["file://nas/share/archive/index.html", "file:////nas/share/archive/index.html"]) {
    for (const ok of ["sample_media/photo-1.svg", "personal_data/media/a b.jpg", "https://example.test/x.png",
      "file://nas/share/archive/personal_data/x.jpg", "file://NAS/share/other/x.jpg"]) {
      assert.equal(safeMediaUrl(ok, base), ok, ok + " from " + base);
    }
    for (const bad of ["file://attacker.example/share/x.pdf", "file:////attacker.example/share/x.pdf",
      "//attacker.example/share/x.pdf", "javascript:alert(1)"]) {
      assert.equal(safeMediaUrl(bad, base), "", bad + " from " + base);
    }
  }
});
