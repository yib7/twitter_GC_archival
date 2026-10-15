/*
 * fs-io.js — the small filesystem layer under the ingestion pipeline.
 *
 * build-core.js stays pure (no I/O); this file is the thin shell that feeds
 * it bytes from disk. Shared by scripts/build.js and scripts/server.js.
 * Node built-ins only.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const { createExportScanner, createArchiveScanner } = require("./build-core.js");

const DEFAULT_CHUNK = 1 << 20;   // 1 MiB

// Feed a file to a streaming scanner in `chunkSize`-byte reads, so the file is
// never one giant string (SP-10). A StringDecoder keeps multi-byte UTF-8
// characters that straddle a chunk boundary intact.
function feedFile(file, scanner, opts) {
  opts = opts || {};
  const size = Math.max(1, opts.chunkSize || DEFAULT_CHUNK);
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
/**
 * Stream an export file through the export scanner.
 * @returns {{global: string|null, part: number|null}}
 */
function scanExportFile(file, handlers, opts) {
  return feedFile(file, createExportScanner(handlers), opts);
}
/**
 * Stream a previously built data.js, one conversation at a time (fix round 1:
 * the accumulated history can outgrow V8's ~512 MB string limit).
 * @returns {{meta: object, conversations: number}}
 */
function scanArchiveFile(file, handlers, opts) {
  return feedFile(file, createArchiveScanner(handlers), opts);
}
// SP7: what the setup server needs to know about a built archive, read without
// keeping (or even parsing) a single message: its meta and, per conversation,
// id / type / title / participants / count. Memory is bounded by the largest
// conversation's roster, not the archive.
function readArchiveSummary(file, opts) {
  const conversations = [];
  const { meta } = scanArchiveFile(file, {
    skipMessages: true,
    onConversation: (c) => conversations.push({ id: c.id, type: c.type, title: c.title, participants: c.participants || [], count: c.count }),
  }, opts);
  return { meta, conversations };
}
// SP7: run collectors (message(conv, msg) / conversation(conv) / result(),
// see server-core.js and build-core createParticipantCollector) over a data.js
// one message at a time; each message is dropped once the collectors saw it.
function foldArchive(file, collectors, opts) {
  const cols = collectors || [];
  return scanArchiveFile(file, {
    onMessage: (c, m) => { for (const col of cols) col.message(c, m); },
    onConversation: (c) => { for (const col of cols) col.conversation(c); },
  }, opts);
}
// The metadata at the head of a data.js (generatedAt, ignoredUsers,
// ignoredGroups — archiveChunks writes it before "conversations"), without
// reading the rest. null when the file is missing or doesn't start that way.
const ARCHIVE_META_RE = /^\uFEFF?\s*window\.CHAT_DATA\s*=\s*(\{[\s\S]*?),?"conversations"\s*:/;
function readArchiveMeta(file) {
  let head;
  try { head = readExportHead(file, 64 * 1024); } catch (e) { return null; }
  const m = ARCHIVE_META_RE.exec(head);
  if (!m) return null;
  try { return JSON.parse(m[1] === "{" ? "{}" : m[1] + "}"); } catch (e) { return null; }
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
// move the old file aside and the new one in (Windows lets an open file be
// renamed when its reader allows it, as Node and most programs do). The target
// is never overwritten in place, so a failure can't truncate it, and the temp
// file is only deleted while the old file is known to be intact.
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
// The target is held by another program and the old version is still in place.
// `userMessage` is the plain sentence build.js and the server show as-is.
function heldError(dest, cause) {
  const name = "“" + path.basename(dest) + "”";
  const e = new Error("Couldn't save " + name + ": another program is holding it open (antivirus, OneDrive or an editor?). " +
    "Close that program and try again — the previous version of " + name + " is unchanged.");
  e.code = (cause && cause.code) || "EBUSY";
  e.path = dest;
  e.userMessage = e.message;
  return e;
}
// A first save (no file at `dest` yet) whose freshly written temp file another
// program won't let go of — usually antivirus scanning it.
function newFileHeldError(dest, cause) {
  const name = "“" + path.basename(dest) + "”";
  const e = new Error("Couldn't save " + name + ": another program (antivirus or a sync app?) is still holding the new file. " +
    "Wait a moment and try again.");
  e.code = (cause && cause.code) || "EBUSY";
  e.path = dest;
  e.userMessage = e.message;
  return e;
}
// Move a finished temp file into place. Returns "renamed" or "swapped".
function replaceFile(tmp, dest, opts) {
  opts = opts || {};
  const rename = opts.rename || fs.renameSync;
  const retries = opts.retries != null ? opts.retries : 8;
  const delay = opts.delayMs != null ? opts.delayMs : 40;
  let last;
  for (let attempt = 0; ; attempt++) {
    try { rename(tmp, dest); return "renamed"; }
    catch (e) {
      if (!RETRY_CODES.has(e.code)) throw e;
      last = e;
      if (attempt >= retries) break;
      sleepSync(delay * (attempt + 1));
    }
  }
  // Fallback: old file aside, new file in, old file deleted.
  const aside = tmpNameFor(dest);
  try { rename(dest, aside); }
  catch (e) {
    // SP7: no old file at all (a first save) — what's held is the NEW file
    // (antivirus scanning it), and there is no previous version to speak of.
    if (e && e.code === "ENOENT" && !fs.existsSync(dest)) throw newFileHeldError(dest, last);
    throw heldError(dest, last);                       // nothing moved: the caller removes tmp
  }
  try { rename(tmp, dest); }
  catch (e) {
    try { rename(aside, dest); }                       // put the old one back
    catch (e2) {
      // Neither could be put back: keep BOTH complete copies and say where.
      const err = new Error("Couldn't save “" + path.basename(dest) + "”: another program is holding it. " +
        "Nothing was lost: the new version is “" + path.basename(tmp) + "” and the previous one “" + path.basename(aside) +
        "”, both in " + path.dirname(dest) + ". Close the other program, then rename one of them to “" + path.basename(dest) + "”.");
      err.code = e.code; err.path = dest; err.userMessage = err.message; err.keepTemp = true;
      throw err;
    }
    throw heldError(dest, e);
  }
  unlinkQuiet(aside);   // a reader still holding it keeps its handle; Windows deletes it on close
  return "swapped";
}
function writeFileAtomic(dest, data, opts) {
  const tmp = tmpNameFor(dest);
  try {
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return replaceFile(tmp, dest, opts);
  } catch (e) {
    if (!e.keepTemp) unlinkQuiet(tmp);
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
    if (!e.keepTemp) unlinkQuiet(tmp);
    throw e;
  }
}

module.exports = { scanExportFile, scanArchiveFile, readArchiveSummary, foldArchive, readArchiveMeta, readExportHead, writeFileAtomic, writeChunksAtomic, replaceFile, TMP_RE };
