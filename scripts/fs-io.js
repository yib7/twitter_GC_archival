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
const { createExportScanner, createArchiveScanner, parseManifest, exportFamilies } = require("./build-core.js");

const DEFAULT_CHUNK = 1 << 20;   // 1 MiB

// Feed a file to a streaming scanner in `chunkSize`-byte reads, so the file is
// never one giant string. A StringDecoder keeps multi-byte UTF-8
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
 * Stream a previously built data.js, one conversation at a time (the
 * accumulated history can outgrow V8's ~512 MB string limit).
 * @returns {{meta: object, conversations: number}}
 */
function scanArchiveFile(file, handlers, opts) {
  return feedFile(file, createArchiveScanner(handlers), opts);
}
// what the setup server needs to know about a built archive, read without
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
// run collectors (message(conv, msg) / conversation(conv) / result(),
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

/* ---- find the export inside a picked archive folder ------------------ */
const MANIFEST_MAX = 8 * 1048576;   // a real manifest is a few KB
const isWithin = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const statOr = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };
/**
 * The user picked their unzipped Twitter/X archive (its root, its data/ folder,
 * or any file in either). Find the group messages files (every part, in
 * order), the group headers file(s) and the group media folder — from
 * data/manifest.js when it is there and usable, else by file name.
 * Nothing outside the picked folder is ever used: manifest paths with "..",
 * absolute paths, and anything that resolves (through a symlink or junction)
 * outside it are skipped and reported.
 * @returns {{picked, root, dataDir, via: "manifest"|"scan", messages: string[], headers: string[], mediaDir: string|null,
 *            notes: Array<{code: string, files?: string[], text?: string}>} | {error: string}}
 */
function locateExport(pickedIn) {
  const st0 = statOr(pickedIn);
  if (!st0) return { error: "Archive folder not found: " + pickedIn + "." };
  const picked = path.resolve(st0.isDirectory() ? pickedIn : path.dirname(pickedIn));
  let fence;
  try { fence = fs.realpathSync(picked); } catch (e) { return { error: "The archive folder couldn't be opened: " + pickedIn + "." }; }
  const isDir = (p) => { const s = statOr(p); return !!s && s.isDirectory(); };
  const isFile = (p) => { const s = statOr(p); return !!s && s.isFile(); };
  // Inside the picked folder, after following every link?
  const realInside = (p) => { try { return isWithin(fs.realpathSync(p), fence); } catch (e) { return false; } };

  let root = picked, dataDir = isDir(path.join(picked, "data")) ? path.join(picked, "data") : picked, manifestFile = null;
  if (isFile(path.join(picked, "data", "manifest.js"))) manifestFile = path.join(picked, "data", "manifest.js");
  else if (isFile(path.join(picked, "manifest.js"))) {
    // the data/ folder itself was picked: manifest paths ("data/…") are
    // relative to its parent, but must still land inside the picked folder
    manifestFile = path.join(picked, "manifest.js");
    dataDir = picked; root = path.dirname(picked);
  }

  const notes = [], unsafe = [], missing = [];
  // A manifest path → an existing file/folder inside the picked folder, or null.
  function resolveRel(raw, wantDir) {
    const s = String(raw);
    const norm = s.replace(/\\/g, "/");
    if (!norm || norm.indexOf("\0") !== -1 || path.win32.isAbsolute(s) || path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) {
      unsafe.push(s); return null;
    }
    const parts = norm.split("/").filter((x) => x && x !== ".");
    const tries = [path.join(root, ...parts)];
    if (parts[0] === "data" && parts.length > 1) tries.push(path.join(dataDir, ...parts.slice(1)));
    tries.push(path.join(dataDir, ...parts));
    let outside = false;
    for (const p of tries) {
      if (!isWithin(path.resolve(p), picked)) continue;         // never even look outside
      let ls;
      try { ls = fs.lstatSync(p); } catch (e) { continue; }
      if (!realInside(p)) { outside = true; continue; }          // a link pointing out
      const ok = wantDir ? isDir(p) : (ls.isFile() || isFile(p));
      if (ok) return p;
    }
    (outside ? unsafe : missing).push(s);
    return null;
  }

  let via = "scan", messages = [], headers = [], mediaDir = null, dmFiles = 0;
  if (manifestFile) {
    const sz = statOr(manifestFile).size;
    let m;
    if (!realInside(manifestFile)) m = { ok: false, error: "manifest.js points outside the archive folder" };
    else if (sz > MANIFEST_MAX) m = { ok: false, error: "manifest.js is too large to be an archive manifest" };
    else {
      try { m = parseManifest(fs.readFileSync(manifestFile, "utf8")); }
      catch (e) { m = { ok: false, error: "manifest.js couldn't be read" }; }
    }
    if (!m.ok) notes.push({ code: "manifest-unreadable", text: m.error });
    else {
      dmFiles = m.dmFiles;
      messages = m.messages.map((r) => resolveRel(r, false)).filter(Boolean);
      headers = m.headers.map((r) => resolveRel(r, false)).filter(Boolean);
      for (const d of m.mediaDirs) { const p = resolveRel(d, true); if (p) { mediaDir = p; break; } }
      if (messages.length) via = "manifest";
      else notes.push({ code: "manifest-no-groups" });
    }
  }
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((n) => isFile(path.join(dataDir, n))); } catch (e) { /* unreadable: nothing found */ }
  const fam = exportFamilies(names);
  const inside = (n) => realInside(path.join(dataDir, n));
  if (via === "scan") {
    messages = fam.messages.filter(inside).map((n) => path.join(dataDir, n));
    headers = fam.headers.filter(inside).map((n) => path.join(dataDir, n));
  } else {
    // the manifest isn't taken as the complete list — a
    // stale one can leave out a part that is right there. Export-named files
    // in the data folder it doesn't list are added, in part order.
    const key = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
    const partOf = (p) => { const m = /[-_.]part(\d+)\.js$/i.exec(path.basename(p)); return m ? Number(m[1]) : 0; };
    const extra = [];
    const unite = (list, scanned) => {
      const have = new Set(list.map(key));
      const add = scanned.filter(inside).map((n) => path.join(dataDir, n)).filter((p) => !have.has(key(p)));
      if (!add.length) return list;
      extra.push(...add.map((p) => path.basename(p)));
      return list.concat(add).map((p, i) => ({ p, i, n: partOf(p) })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.p);
    };
    messages = unite(messages, fam.messages);
    headers = unite(headers, fam.headers);
    if (extra.length) notes.push({ code: "manifest-extra", files: extra });
  }
  if (!mediaDir) {
    const std = path.join(dataDir, "direct_messages_group_media");
    if (isDir(std) && realInside(std)) mediaDir = std;
  }
  if (missing.length) notes.push({ code: "manifest-missing", files: missing.map((f) => f.replace(/\\/g, "/").split("/").pop()) });
  if (unsafe.length) notes.push({ code: "manifest-unsafe", files: unsafe });
  if (dmFiles || names.some((n) => /^direct-messages?(?:[-_.]part\d+)?\.js$/i.test(n))) notes.push({ code: "dm-file" });
  if (!messages.length) {
    return { error: "No group chat files were found in “" + path.basename(picked) + "”. Pick the folder you unzipped your Twitter/X archive into " +
      "(the one with “Your archive.html” and a data folder), or its data folder." };
  }
  return { picked, root, dataDir, via, messages, headers, mediaDir, notes };
}

/* ---- crash-safe writes --------------------------------------------- */
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
    // no old file at all (a first save) — what's held is the NEW file
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
// fs.writeSync may write only part of a buffer (POSIX, a nearly full disk)
// without an error: write the rest, and treat no progress at all as a full
// disk, so a cut-off file is never saved over a good one.
function writeAll(fd, data) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  for (let off = 0; off < buf.length;) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw Object.assign(new Error("ENOSPC: the disk took no more data"), { code: "ENOSPC" });
    off += n;
  }
}
// Same, for content produced piece by piece (data.js from archiveChunks), so
// the whole archive never has to exist as one string.
function writeChunksAtomic(dest, chunks, opts) {
  const tmp = tmpNameFor(dest);
  try {
    const fd = fs.openSync(tmp, "wx");
    try {
      for (const c of chunks) if (c) writeAll(fd, c);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return replaceFile(tmp, dest, opts);
  } catch (e) {
    if (!e.keepTemp) unlinkQuiet(tmp);
    throw e;
  }
}

module.exports = { locateExport, scanExportFile, scanArchiveFile, readArchiveSummary, foldArchive, readArchiveMeta, readExportHead, writeFileAtomic, writeChunksAtomic, replaceFile, TMP_RE };
