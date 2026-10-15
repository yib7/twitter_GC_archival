/*
 * fs-io.js — the small filesystem layer under the ingestion pipeline.
 *
 * build-core.js stays pure (no I/O); this file is the thin shell that feeds
 * it bytes from disk. Shared by scripts/build.js and scripts/server.js.
 * Node built-ins only.
 */
"use strict";

const fs = require("fs");
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

module.exports = { scanExportFile, readExportHead };
