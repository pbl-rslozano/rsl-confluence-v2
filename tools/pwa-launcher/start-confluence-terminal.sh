#!/bin/sh
# rsL Confluence Terminal - local launcher (macOS / Linux). Needs Node.js 18+.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js 18+ from https://nodejs.org first."; exit 1; }
exec node serve-pwa.mjs --port 8770 --open-browser
