#!/bin/sh
# ============================================================================
#  Double-click (macOS) or run to set up the Group Chat Archive.
#  Starts the local server and opens the setup wizard in your browser.
#  Needs Node.js 18 or newer installed (https://nodejs.org). Ctrl+C to stop.
#  First time on macOS/Linux: run `chmod +x start-setup.command` once.
# ============================================================================
cd "$(dirname "$0")" || exit 1

# Run from inside a ZIP / disk-image preview, only this file is there.
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

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >/dev/null 2>&1; then
  echo
  echo "  Your Node.js is too old for the Group Chat Archive: it needs version 18 or newer."
  echo "  Install the current LTS version from https://nodejs.org, then run"
  echo "  start-setup.command again."
  echo
  exit 1
fi

exec node scripts/server.js --open
