#!/usr/bin/env bash
# YOU HEAL Clinical — uninstaller (Linux/macOS).
#
# Default: removes the service, application releases, private Node runtime, config, firewall rule and
# backup schedule, but KEEPS the data directory (database, master key, TLS, backups) so the clinic can
# reinstall or migrate. --purge additionally CRYPTO-ERASES and deletes all data:
#   1. the master key and every retired key are overwritten and removed FIRST, which renders every
#      PHI ciphertext and every encrypted backup — including copies elsewhere — undecryptable
#      (NIST SP 800-88 Rev. 1 "cryptographic erase"; escrowed key copies must be destroyed too);
#   2. then the data directory and logs are deleted.
# --purge requires typing a confirmation phrase unless --force is also given.

set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
YH_ORIG_ARGS=("$@"); YH_ORIG_ARGS_STR="$*"

CONF_DIR="/etc/youheal"
PURGE=0
FORCE=0
REMOVE_USER=0
KEEP_RUNTIME=0

usage() {
  cat <<EOF
Usage: sudo $(basename -- "$0") [options]

Remove ${YH_PRODUCT} from this host. Data is KEPT unless --purge is given.

  --conf-dir DIR     install config dir (default: /etc/youheal)
  --purge            crypto-erase (destroy master + retired keys) and delete the data directory
  --force            with --purge: skip the typed confirmation (automation only)
  --remove-user      also delete the service account (implied by --purge)
  --keep-runtime     keep <prefix>/runtime (private Node.js)
  --log-file FILE    log file (default: /var/log/youheal-uninstall.log)
  --dry-run          show what would happen
  -y, --yes          do not ask for the (non-purge) confirmation
  -v, --verbose      more output
  -h, --help         this help
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --conf-dir) need_arg "$@"; CONF_DIR=$2; shift 2 ;;
    --purge) PURGE=1; REMOVE_USER=1; shift ;;
    --force) FORCE=1; shift ;;
    --remove-user) REMOVE_USER=1; shift ;;
    --keep-runtime) KEEP_RUNTIME=1; shift ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

install_traps
YH_ELEVATION_REASON="remove the ${YH_PRODUCT} system service" require_root "${YH_ORIG_ARGS[@]+"${YH_ORIG_ARGS[@]}"}"
detect_platform
init_logging "${LOG_FILE:-/var/log/youheal-uninstall.log}"
load_install_state "${CONF_DIR}"
INIT_SYSTEM="${STATE_INIT_SYSTEM:-${INIT_SYSTEM}}"
PREFIX="${STATE_PREFIX}"; DATA_DIR="${STATE_DATA_DIR}"; SVC_USER="${STATE_SERVICE_USER}"; PORT="${STATE_PORT}"
FW_SOURCE="$(env_get "${CONF_DIR}/install.state" FIREWALL_SOURCE "")"
KEY_FILE_ENV="$(env_get "${CONF_DIR}/youheal.env" YH_MASTER_KEY_FILE "")"

# Guard rails against catastrophic rm -rf on a mangled state file.
for p in "${PREFIX}" "${DATA_DIR}" "${CONF_DIR}"; do
  case "${p}" in ""|/|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/sbin|/sys|/usr|/usr/local|/var|/var/lib|/Users|/Library|/System)
    die "refusing to operate on suspicious path '${p}' from install.state";; esac
done

cat >&2 <<EOF
    remove service   : ${INIT_SYSTEM} (${YH_SERVICE_NAME})
    remove app       : ${PREFIX}$( [ "${KEEP_RUNTIME}" = 1 ] && echo " (keeping runtime/)" )
    remove config    : ${CONF_DIR}
    firewall rule    : ${STATE_FIREWALL} tcp/${PORT}
    data dir         : ${DATA_DIR} -> $( [ "${PURGE}" = 1 ] && echo "CRYPTO-ERASE + DELETE" || echo "KEPT" )
    service account  : ${SVC_USER} -> $( [ "${REMOVE_USER}" = 1 ] && echo "deleted" || echo "kept" )
EOF

if [ "${PURGE}" = 1 ] && [ "${FORCE}" = 0 ] && [ "${DRY_RUN}" = 0 ]; then
  phrase="PURGE $(hostname -s 2>/dev/null || hostname)"
  [ -t 0 ] || die "--purge needs an interactive confirmation (or --force for automation)"
  warn "--purge permanently destroys ALL patient data on this host and makes every backup undecryptable."
  printf 'Type "%s" to continue: ' "${phrase}" >&2
  read -r answer
  [ "${answer}" = "${phrase}" ] || die "confirmation phrase did not match; nothing was changed"
elif [ "${PURGE}" = 0 ]; then
  confirm "Uninstall ${YH_PRODUCT} (data in ${DATA_DIR} is kept)?" || die "aborted by operator"
fi

# --- service ---------------------------------------------------------------------------------------
service_ctl stop || true
service_ctl disable || true
case "${INIT_SYSTEM}" in
  systemd) run rm -f "/etc/systemd/system/${YH_SERVICE_NAME}.service"; run systemctl daemon-reload; run systemctl reset-failed "${YH_SERVICE_NAME}" 2>/dev/null || true ;;
  openrc)  run rm -f "/etc/init.d/${YH_SERVICE_NAME}" ;;
  launchd) run rm -f "/Library/LaunchDaemons/${YH_LAUNCHD_LABEL}.plist" ;;
esac
ok "service removed"

# --- firewall --------------------------------------------------------------------------------------
case "${STATE_FIREWALL}" in
  ufw)
    if [ -n "${FW_SOURCE}" ]; then run ufw delete allow proto tcp from "${FW_SOURCE}" to any port "${PORT}" || true
    else run ufw delete allow "${PORT}/tcp" || true; fi ;;
  firewalld)
    if [ -n "${FW_SOURCE}" ]; then
      fam=ipv4; case "${FW_SOURCE}" in *:*) fam=ipv6;; esac
      run firewall-cmd --permanent --remove-rich-rule="rule family=${fam} source address=${FW_SOURCE} port port=${PORT} protocol=tcp accept" || true
    else run firewall-cmd --permanent --remove-port="${PORT}/tcp" || true; fi
    run firewall-cmd --reload || true ;;
  socketfilterfw) run /usr/libexec/ApplicationFirewall/socketfilterfw --remove "${STATE_NODE_BIN}" || true ;;
esac

# --- backup schedule -------------------------------------------------------------------------------
run rm -f /etc/cron.d/youheal-backup
if crontab -l 2>/dev/null | grep -q youheal-backup; then
  if [ "${DRY_RUN}" = 1 ]; then run "crontab -l | grep -v youheal-backup | crontab -"; else crontab -l | grep -v youheal-backup | crontab - || true; fi
fi

# --- application + config --------------------------------------------------------------------------
if [ "${KEEP_RUNTIME}" = 1 ]; then
  run rm -rf -- "${PREFIX}/releases" "${PREFIX}/current" "${PREFIX}/.current.tmp"
else
  run rm -rf -- "${PREFIX}"
fi
if [ "${PURGE}" = 0 ] && [ -d "${DATA_DIR}" ]; then
  # keep a copy of the (secret-free) config next to the data for a later reinstall
  run mkdir -p "${DATA_DIR}/uninstalled-config"
  run cp -p "${CONF_DIR}/youheal.env" "${CONF_DIR}/install.state" "${DATA_DIR}/uninstalled-config/" || true
fi
run rm -rf -- "${CONF_DIR}"
ok "application and configuration removed"

# --- data ------------------------------------------------------------------------------------------
shred_file() {
  local f=$1
  if command -v shred >/dev/null 2>&1; then run shred -f -z -u -n 3 -- "${f}"
  else
    local size; size="$(wc -c <"${f}" | tr -d ' ')"
    run dd if=/dev/urandom of="${f}" bs=1 count="${size}" conv=notrunc 2>/dev/null
    run rm -f -- "${f}"
  fi
}
if [ "${PURGE}" = 1 ]; then
  log "crypto-erase: destroying master and retired keys"
  if [ -d "${DATA_DIR}/keys" ]; then
    while IFS= read -r f; do shred_file "${f}"; done < <(find "${DATA_DIR}/keys" -type f)
  fi
  if [ -n "${KEY_FILE_ENV}" ] && [ -f "${KEY_FILE_ENV}" ]; then shred_file "${KEY_FILE_ENV}"; fi
  run sync
  ok "keys destroyed — remaining ciphertext (db, backups, offsite copies) is now undecryptable"
  run rm -rf -- "${DATA_DIR}"
  if [ -n "${STATE_LOG_DIR}" ] && [ -d "${STATE_LOG_DIR}" ]; then run rm -rf -- "${STATE_LOG_DIR}"; fi
  warn "SSDs/copy-on-write filesystems may retain old blocks: crypto-erase is what protects them. Destroy ALL escrowed key copies and record the sanitization (MP-6) per docs/OPERATIONS.md §11."
else
  log "data kept in ${DATA_DIR} (master key: ${DATA_DIR}/keys). Reinstall with install.sh --data-dir ${DATA_DIR}."
fi

# --- account ---------------------------------------------------------------------------------------
if [ "${REMOVE_USER}" = 1 ] && id "${SVC_USER}" >/dev/null 2>&1; then
  if [ "${OS_KERNEL}" = Darwin ]; then
    run dscl . -delete "/Users/${SVC_USER}" || true
    run dscl . -delete "/Groups/${SVC_USER}" || true
  elif command -v userdel >/dev/null 2>&1; then
    run userdel "${SVC_USER}" || true
    if getent group "${SVC_USER}" >/dev/null 2>&1; then run groupdel "${SVC_USER}" || true; fi
  elif command -v deluser >/dev/null 2>&1; then
    run deluser "${SVC_USER}" || true
    run delgroup "${SVC_USER}" 2>/dev/null || true
  fi
  ok "service account ${SVC_USER} removed"
fi
ok "${YH_PRODUCT} uninstalled$( [ "${PURGE}" = 1 ] && echo " and data crypto-erased" )"
