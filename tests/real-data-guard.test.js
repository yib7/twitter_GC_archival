require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findRealDataHazards } = require("./_real-data-guard.js");

// Locks in the detection logic that both playwright.config.js's globalSetup
// and every node:test file's top-of-file require() rely on. Runs against a
// throwaway temp directory, never the real repo root, so a bug in the guard
// itself can't accidentally trip on (or miss) this project's own checkout.
function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-guard-check-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("a clean checkout (no hazard files/dirs) reports zero hazards", () => {
  withTempRoot((dir) => {
    fs.writeFileSync(path.join(dir, "data.sample.js"), "window.CHAT_DATA = {};");
    assert.deepEqual(findRealDataHazards(dir), []);
  });
});

test("a personal_data/ directory is flagged", () => {
  withTempRoot((dir) => {
    fs.mkdirSync(path.join(dir, "personal_data"));
    assert.deepEqual(findRealDataHazards(dir), ["personal_data/"]);
  });
});

test("a personal_data.REAL/ backup-style directory (prefix match) is flagged", () => {
  withTempRoot((dir) => {
    fs.mkdirSync(path.join(dir, "personal_data.REAL"));
    assert.deepEqual(findRealDataHazards(dir), ["personal_data.REAL/"]);
  });
});

test("an exports/ directory is flagged", () => {
  withTempRoot((dir) => {
    fs.mkdirSync(path.join(dir, "exports"));
    assert.deepEqual(findRealDataHazards(dir), ["exports/"]);
  });
});

test("root data.js and names.local.js are each flagged by exact name", () => {
  withTempRoot((dir) => {
    fs.writeFileSync(path.join(dir, "data.js"), "window.CHAT_DATA = {};");
    fs.writeFileSync(path.join(dir, "names.local.js"), "window.LOCAL_NAMES = {};");
    assert.deepEqual(findRealDataHazards(dir).sort(), ["data.js", "names.local.js"]);
  });
});

test("data.sample.js (the committed demo data) is never mistaken for the hazardous data.js", () => {
  withTempRoot((dir) => {
    fs.writeFileSync(path.join(dir, "data.sample.js"), "window.CHAT_DATA = {};");
    assert.deepEqual(findRealDataHazards(dir), []);
  });
});

test("the guard never reads file contents — only existence/name checks", () => {
  withTempRoot((dir) => {
    // A "data.js" that would throw if ever read as UTF-8/JSON must still just
    // be reported by name, not opened.
    fs.writeFileSync(path.join(dir, "data.js"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    assert.deepEqual(findRealDataHazards(dir), ["data.js"]);
  });
});
