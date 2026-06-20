#!/bin/sh
# ============================================================================
#  Double-click (macOS) or run to set up the Group Chat Archive.
#  Starts the local server and opens the setup wizard in your browser.
#  Needs Node.js installed (https://nodejs.org). Ctrl+C to stop.
#  First time on macOS/Linux: run `chmod +x start-setup.command` once.
# ============================================================================
cd "$(dirname "$0")" || exit 1
node scripts/server.js --open
