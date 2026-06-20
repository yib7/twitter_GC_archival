/*
 * server-core.js — pure, side-effect-free helpers for the setup server.
 *
 * Kept separate from server.js (which opens a listening socket on require) so
 * these can be unit-tested in isolation, mirroring the build.js / build-core.js
 * split.
 */
"use strict";

// Build a native Windows OpenFileDialog filter string for the wizard pickers.
// `which` is "headers" or "group" (anything else → group). The headers glob is
// spelling-agnostic ("*group-headers*.js") because X names that file with the
// singular "message" (direct-message-group-headers.js) while exports/tools
// sometimes use the plural — both must show up in the picker.
function dialogFilter(which) {
  if (which === "headers") {
    return "Group headers (*group-headers*.js)|*group-headers*.js" +
      "|JavaScript (*.js)|*.js|All files (*.*)|*.*";
  }
  return "Group messages (direct-messages-group*.js)|direct-messages-group*.js" +
    "|JavaScript (*.js)|*.js|All files (*.*)|*.*";
}

// Lowercase a display name into a filename-safe slug: any run of characters that
// isn't a-z/0-9 becomes a single underscore; leading/trailing underscores are
// trimmed. Returns "" for empty/blank input.
function sanitizeName(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Pick the on-disk filename for a saved photo. A named person/group becomes
// `<slug>_pfp.<ext>` (easy to find later); an unnamed one keeps the opaque id
// (`<id>.<ext>`). `taken` is a Set of filenames already chosen in this save, so
// two people with the same name don't clobber each other — the later one gets a
// short id suffix.
function pfpFileName(name, id, ext, taken) {
  const slug = sanitizeName(name);
  if (!slug) return id + "." + ext;
  const base = slug + "_pfp";
  let file = base + "." + ext;
  if (taken && taken.has(file)) {
    const id4 = (sanitizeName(String(id)).replace(/^_+/, "").slice(-4)) || "x";
    file = base + "-" + id4 + "." + ext;
    let n = 2;
    while (taken && taken.has(file)) { file = base + "-" + id4 + "-" + n + "." + ext; n++; }
  }
  return file;
}

module.exports = { dialogFilter, sanitizeName, pfpFileName };
