#!/bin/bash
# Ultracraft - double-click launcher (Linux).
#
# Starts the bundled static server and opens the game. No Node? It falls back
# to Ultracraft.html, the single-file build, which needs nothing at all.
set -u
cd "$(dirname "$0")" || exit 1

echo ""
echo "  ULTRACRAFT"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js not found - opening the single-file build instead."
  echo "  (Install Node from https://nodejs.org for the full version.)"
  echo ""
  xdg-open "Ultracraft.html" 2>/dev/null || echo "  Open Ultracraft.html in your browser."
  exit 0
fi

PORT=$(node -e '
const net = require("net");
let p = 8080;
function free(port, done) {
  const s = net.createServer();
  s.once("error", () => done(false));
  s.once("listening", () => s.close(() => done(true)));
  s.listen(port, "127.0.0.1");
}
(function next() {
  if (p > 8120) { console.log(p); return; }
  free(p, (ok) => { if (ok) console.log(p); else { p++; next(); } });
})();
')

node tools/serve.js "$PORT" &
SERVER=$!
cleanup() { kill "$SERVER" 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "  starting on http://localhost:$PORT/ ..."
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://localhost:$PORT/index.html"; then break; fi
  sleep 0.25
done

xdg-open "http://localhost:$PORT/" 2>/dev/null || true
echo ""
echo "  Ultracraft is running at http://localhost:$PORT/"
echo "  Press Ctrl+C (or close this window) to stop the server."
echo ""

wait "$SERVER"
