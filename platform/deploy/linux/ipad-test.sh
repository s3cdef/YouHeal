#!/usr/bin/env bash
# YOU HEAL Clinical — start an iPad/tablet TEST instance from this Linux/macOS computer (fictitious data only).
#   deploy/linux/ipad-test.sh [--open-firewall] [any tools/ipad-test.mjs options, e.g. --mode tailscale --reset]
# Runs as the invoking user (no root needed). With --open-firewall it elevates via sudo/doas ONLY to allow the
# test ports through ufw/firewalld; nothing else runs privileged.
set -Eeuo pipefail
trap 'echo "[ipad-test] failed at line $LINENO" >&2' ERR
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; APP="$(cd "$HERE/../.." && pwd)"
OPEN_FW=0; PASS=(); PORT=8443; CA_PORT=8099
while (($#)); do
  case "$1" in
    --open-firewall) OPEN_FW=1 ;;
    --port) PORT="$2"; PASS+=("$1" "$2"); shift ;;
    --ca-port) CA_PORT="$2"; PASS+=("$1" "$2"); shift ;;
    -h|--help) sed -n '2,6p' "$0"; exec node "$APP/tools/ipad-test.mjs" --help ;;
    *) PASS+=("$1") ;;
  esac; shift
done
command -v node >/dev/null || { echo "[ipad-test] Node.js >= 22.13 is required" >&2; exit 1; }
if ((OPEN_FW)); then
  SUDO=""; if [ "$(id -u)" -ne 0 ]; then if command -v sudo >/dev/null; then SUDO=sudo; elif command -v doas >/dev/null; then SUDO=doas; else echo "[ipad-test] need sudo/doas to open the firewall" >&2; exit 1; fi; fi
  if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
    $SUDO ufw allow "$PORT/tcp" comment 'youheal ipad test'; $SUDO ufw allow "$CA_PORT/tcp" comment 'youheal ipad test CA'
  elif command -v firewall-cmd >/dev/null && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    $SUDO firewall-cmd --add-port="$PORT/tcp" --add-port="$CA_PORT/tcp"   # runtime only: gone after reboot
  else echo "[ipad-test] no active ufw/firewalld found — nothing to open (macOS: allow 'node' when prompted)"; fi
fi
exec node "$APP/tools/ipad-test.mjs" "${PASS[@]}"
