#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if /usr/bin/curl -fsS "http://127.0.0.1:4178/api/status" >/dev/null 2>&1; then
  /usr/bin/open "http://127.0.0.1:4178"
  exit 0
fi
if [ ! -d node_modules ]; then
  npm install
fi
npm start
