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

module.exports = { dialogFilter };
