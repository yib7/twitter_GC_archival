/*
 * fs-io.js — the small filesystem layer under the ingestion pipeline.
 *
 * build-core.js stays pure (no I/O); this file is the thin shell that feeds
 * it bytes from disk. Shared by scripts/build.js and scripts/server.js.
 * Node built-ins only.
 */
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const { createExportScanner } = require("./build-core.js");

const DEFAULT_CHUNK = 1 << 20;   // 1 MiB

/**
 * Stream an export file through the scanner in `chunkSize`-byte reads, so the
 * file is never one giant string (SP-10). A StringDecoder keeps multi-byte
 * UTF-8 characters that straddle a chunk boundary intact.
 * @returns {{global: string|null, part: number|null}}
 */
function scanExportFile(file, handlers, opts) {
  opts = opts || {};
  const size = Math.max(1, opts.chunkSize || DEFAULT_CHUNK);
  const scanner = createExportScanner(handlers);
  const dec = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(size);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, size, null);
      if (n === 0) break;
      if (opts.onChunk) opts.onChunk(n);
      const text = dec.write(n === size ? buf : buf.subarray(0, n));
      if (text) scanner.push(text);
    }
    const tail = dec.end();
    if (tail) scanner.push(tail);
  } finally {
    fs.closeSync(fd);
  }
  return scanner.end();
}

// The first `max` bytes of a file as text — enough to read its window.YTD
// global without loading the file.
function readExportHead(file, max) {
  const n = max || 1024;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return new StringDecoder("utf8").write(buf.subarray(0, got));
  } finally {
    fs.closeSync(fd);
  }
}

/* ---- crash-safe writes (SP-9) --------------------------------------------- */
// Write to a temp file in the SAME directory (so the rename can't cross
// volumes), flush it, then rename it over the target: readers see either the
// old file or the complete new one, never a truncated mix — whatever happens
// mid-write (crash, power loss, full disk, an AV/OneDrive lock).
//
// Windows: renaming over a file another process holds open can fail with
// EPERM/EBUSY/EACCES. Retry with a short, growing back-off; if it still fails,
// copy the (already complete) temp file over the target as a last resort.
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
// Leftover temp files from a crashed write match this (see apiReset).
const TMP_RE = /\.\d+\.[0-9a-f]{8}\.tmp$/;
function tmpNameFor(dest) {
  return dest + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) { /* already gone */ } }
// Move a finished temp file into place. Returns "renamed" or "copied".
function replaceFile(tmp, dest, opts) {
  opts = opts || {};
  const rename = opts.rename || fs.renameSync;
  const retries = opts.retries != null ? opts.retries : 8;
  const delay = opts.delayMs != null ? opts.delayMs : 40;
  for (let attempt = 0; ; attempt++) {
    try { rename(tmp, dest); return "renamed"; }
    catch (e) {
      if (!RETRY_CODES.has(e.code)) throw e;
      if (attempt >= retries) break;
      sleepSync(delay * (attempt + 1));
    }
  }
  fs.copyFileSync(tmp, dest);
  unlinkQuiet(tmp);
  return "copied";
}
function writeFileAtomic(dest, data, opts) {
  const tmp = tmpNameFor(dest);
  try {
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return replaceFile(tmp, dest, opts);
  } catch (e) {
    unlinkQuiet(tmp);
    throw e;
  }
}
// Same, for content produced piece by piece (data.js from archiveChunks), so
// the whole archive never has to exist as one string.
function writeChunksAtomic(dest, chunks, opts) {
  const tmp = tmpNameFor(dest);
  try {
    const fd = fs.openSync(tmp, "wx");
    try {
      for (const c of chunks) if (c) fs.writeSync(fd, c);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return replaceFile(tmp, dest, opts);
  } catch (e) {
    unlinkQuiet(tmp);
    throw e;
  }
}

module.exports = { scanExportFile, readExportHead, writeFileAtomic, writeChunksAtomic, replaceFile, TMP_RE };
