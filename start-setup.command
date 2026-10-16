#!/bin/sh
# ============================================================================
#  Double-click (macOS) or run `sh start-setup.command` (Linux) to set up the
#  Group Chat Archive.
#  Starts the setup server and opens the setup wizard in your browser.
#  Needs Node.js 22.13 or newer installed (https://nodejs.org); Node 23 is
#  not supported. The server stops by itself shortly after you close the
#  browser tab.
#  If double-clicking it doesn't work, run `sh start-setup.command` in a
#  terminal from this folder.
# ============================================================================
cd "$(dirname "$0")" || exit 1

# Started from inside a ZIP or disk-image preview, where only this file is present.
if [ ! -f scripts/server.js ]; then
  echo
  echo "  The Group Chat Archive can't start from inside the ZIP file."
  echo "  Extract it first (double-click the ZIP), then run start-setup.command"
  echo "  from the extracted folder."
  echo
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js isn't installed, or it isn't on your PATH."
  echo "  Install the LTS version from https://nodejs.org (it's free), then run"
  echo "  start-setup.command again."
  echo
  exit 1
fi

# Accepts what package.json "engines" admits: 22.13 or a later 22.x, or 24 and newer.
if ! node -e "var v = process.versions.node.split('.').map(Number); process.exit(v[0] >= 24 ? 0 : v[0] == 22 ? (v[1] >= 13 ? 0 : 1) : 1)" >/dev/null 2>&1; then
  echo
  echo "  This version of Node.js can't run the Group Chat Archive."
  echo "  It needs Node.js 22.13 or newer (Node 23 is not supported)."
  echo "  Install the current LTS version from https://nodejs.org, then run"
  echo "  start-setup.command again."
  echo
  exit 1
fi

exec node scripts/server.js --open
