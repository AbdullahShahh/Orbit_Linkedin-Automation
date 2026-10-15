#!/bin/zsh
# Double-click to start the dashboard server, then opens it in Chrome.
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/app"
if lsof -i :4000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Server already running."
else
  node --no-warnings src/server.js &
  sleep 2
fi
open -a "Google Chrome" http://localhost:4000
wait
