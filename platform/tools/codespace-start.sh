#!/usr/bin/env bash
# YOU HEAL Clinical — (re)start the TEST instance inside a GitHub Codespace and report its status.
#   bash platform/tools/codespace-start.sh            (from the repository root, in the codespace Terminal)
# Runs as the codespace user; no elevation is needed (port 8080, files under the repository).
set -Eeuo pipefail
trap 'echo "[codespace-start] failed at line $LINENO" >&2' ERR
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-8080}"; LOG="${LOG:-/tmp/youheal-test.log}"

need_major=22; need_minor=13
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node')"; local ma="${v%%.*}" mi; mi="$(echo "$v" | cut -d. -f2)"
  [ "$ma" -gt "$need_major" ] || { [ "$ma" -eq "$need_major" ] && [ "$mi" -ge "$need_minor" ]; }
}
if ! node_ok; then
  echo "[codespace-start] Node $(node -v 2>/dev/null || echo 'missing') is too old (need >= ${need_major}.${need_minor}); switching to Node 22 via nvm…"
  for f in "${NVM_DIR:-}/nvm.sh" /usr/local/share/nvm/nvm.sh "$HOME/.nvm/nvm.sh"; do
    # shellcheck disable=SC1090
    [ -s "$f" ] && { . "$f"; break; }
  done
  command -v nvm >/dev/null 2>&1 || { echo "[codespace-start] nvm not found. Fix: ☰ → View → Command Palette → 'Codespaces: Rebuild Container' (uses .devcontainer with Node 22)." >&2; exit 1; }
  nvm install 22 >/dev/null && nvm use 22 >/dev/null
  node_ok || { echo "[codespace-start] could not activate Node >= 22.13" >&2; exit 1; }
fi
echo "[codespace-start] Node $(node -v)"

# stop any previous instance
pkill -f "tools/ipad-test.mjs" 2>/dev/null || true
pkill -f "platform/server/index.js" 2>/dev/null || true
sleep 1

cd "$ROOT/platform"
setsid nohup node tools/ipad-test.mjs --mode codespaces --port "$PORT" > "$LOG" 2>&1 &
for _ in $(seq 1 90); do
  grep -q "Stop with Ctrl+C" "$LOG" 2>/dev/null && break
  grep -qE "ERROR|failed at line" "$LOG" 2>/dev/null && break
  sleep 1
done

if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" -H "Host: localhost" >/dev/null 2>&1; then
  echo "[codespace-start] app is RUNNING on port ${PORT}"
  if [ -n "${CODESPACE_NAME:-}" ]; then
    echo "[codespace-start] open in Safari: https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  fi
  [ -f "$ROOT/platform/data-ipad-test/DEMO-CREDENTIALS.txt" ] && echo "[codespace-start] sign-in accounts: platform/data-ipad-test/DEMO-CREDENTIALS.txt"
else
  echo "[codespace-start] app did NOT start — last log lines:" >&2
  tail -n 25 "$LOG" >&2 || true
  exit 1
fi
