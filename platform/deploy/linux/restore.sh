#!/usr/bin/env bash
# YOU HEAL Clinical — restore an encrypted backup (Linux/macOS), with automatic rollback.
#
# Flow: verify the backup (.sha256 sidecar) -> confirm -> stop service -> cold safety snapshot of
# <data-dir>/db and keys -> [import master key for DR] -> app restore command (`node --run restore`)
# -> start -> health check. Any failure after the snapshot restores it and restarts the old state.
#
# Arguments after `--` are passed unchanged to the application's restore command.

set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
YH_ORIG_ARGS=("$@"); YH_ORIG_ARGS_STR="$*"

CONF_DIR="/etc/youheal"
IN_FILE=""
MASTER_KEY_IN=""
SAFETY=1
HEALTH_RETRIES=30
EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: sudo $(basename -- "$0") --in FILE [options] [-- <args for the app restore command>]

Restore ${YH_PRODUCT} from an encrypted backup. The CURRENT database is replaced.

  --in FILE               backup file (*.yhbak) to restore
  --master-key-file FILE  install this master key first (disaster recovery onto a new host); the
                          backup can only be decrypted with the key that was current when it was made
                          (or a retired key kept in <data-dir>/keys/retired/)
  --conf-dir DIR          install config dir (default: /etc/youheal)
  --no-safety-backup      skip the pre-restore snapshot (NOT recommended; disables rollback)
  --health-retries N      health probe attempts, 2 s apart (default: 30)
  --log-file FILE         log file (default: /var/log/youheal-restore.log)
  --dry-run               show what would happen
  -y, --yes               do not ask for confirmation
  -v, --verbose           more output
  -h, --help              this help
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --in) need_arg "$@"; IN_FILE=$2; shift 2 ;;
    --master-key-file) need_arg "$@"; MASTER_KEY_IN=$2; shift 2 ;;
    --conf-dir) need_arg "$@"; CONF_DIR=$2; shift 2 ;;
    --no-safety-backup) SAFETY=0; shift ;;
    --health-retries) need_arg "$@"; HEALTH_RETRIES=$2; shift 2 ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[ -n "${IN_FILE}" ] || { usage >&2; die "--in FILE is required"; }

install_traps
YH_ELEVATION_REASON="replace the PHI database" require_root "${YH_ORIG_ARGS[@]+"${YH_ORIG_ARGS[@]}"}"
detect_platform
init_logging "${LOG_FILE:-/var/log/youheal-restore.log}"
load_install_state "${CONF_DIR}"
INIT_SYSTEM="${STATE_INIT_SYSTEM:-${INIT_SYSTEM}}"
ENV_FILE="${CONF_DIR}/youheal.env"
APP_DIR="${STATE_PREFIX}/current"
DATA_DIR="${STATE_DATA_DIR}"
SVC_USER="${STATE_SERVICE_USER}"
SVC_GROUP="$(id -gn "${SVC_USER}" 2>/dev/null || echo "${SVC_USER}")"
YH_HEALTH_PROBE="${APP_DIR}/deploy/common/healthcheck.mjs"; export YH_HEALTH_PROBE

[ -r "${IN_FILE}" ] || die "cannot read ${IN_FILE}"
IN_FILE="$(cd -- "$(dirname -- "${IN_FILE}")" && pwd -P)/$(basename -- "${IN_FILE}")"
if [ -f "${IN_FILE}.sha256" ]; then
  expected="$(awk '{print $1}' "${IN_FILE}.sha256")"
  actual="$(sha256_of "${IN_FILE}")"
  [ "${expected}" = "${actual}" ] || die "SHA-256 mismatch for ${IN_FILE} (expected ${expected}, got ${actual}) — refusing to restore"
  ok "backup integrity verified (sha256 ${actual})"
else
  warn "no ${IN_FILE}.sha256 sidecar; integrity is checked only by the application's authenticated decryption"
fi

log "restore plan: ${IN_FILE} -> ${DATA_DIR}/db (service: ${INIT_SYSTEM}, safety snapshot: ${SAFETY})"
confirm "This REPLACES the current ${YH_PRODUCT} database on $(hostname). Continue?" || die "aborted by operator"

SNAP=""
ROLLBACK_ARMED=0
rollback() {
  [ "${ROLLBACK_ARMED}" = 1 ] || return 0
  ROLLBACK_ARMED=0
  err "restore failed — rolling back to the pre-restore snapshot ${SNAP}"
  service_ctl stop || true
  if [ -n "${SNAP}" ] && [ -f "${SNAP}" ]; then
    rm -rf -- "${DATA_DIR}/db" "${DATA_DIR}/keys"
    tar -xzf "${SNAP}" -C "${DATA_DIR}"
    chown -R "${SVC_USER}:${SVC_GROUP}" "${DATA_DIR}/db" "${DATA_DIR}/keys"
  fi
  service_ctl start || true
  if health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}"; then warn "rolled back; service is healthy on the previous data"
  else err "rollback finished but the service is NOT healthy — see docs/OPERATIONS.md §7"; fi
}
on_exit_hook() { if [ "$1" -ne 0 ]; then rollback; fi; }

service_ctl stop
if [ "${SAFETY}" = 1 ]; then
  SNAP="${DATA_DIR}/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  log "safety snapshot (cold copy of db/ and keys/) -> ${SNAP}"
  run tar -czf "${SNAP}" -C "${DATA_DIR}" db keys
  run chmod 0600 "${SNAP}"
  ROLLBACK_ARMED=1
fi

if [ -n "${MASTER_KEY_IN}" ]; then
  [ -r "${MASTER_KEY_IN}" ] || die "cannot read ${MASTER_KEY_IN}"
  KEY_FILE="$(env_get "${ENV_FILE}" YH_MASTER_KEY_FILE "${DATA_DIR}/keys/master.key")"
  if [ -f "${KEY_FILE}" ] && ! cmp -s "${MASTER_KEY_IN}" "${KEY_FILE}"; then
    run mkdir -p "${DATA_DIR}/keys/retired"
    run cp -p "${KEY_FILE}" "${DATA_DIR}/keys/retired/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).key"
    warn "previous master key kept as a retired (decrypt-only) key in ${DATA_DIR}/keys/retired/"
  fi
  run install -m 0600 -o "${SVC_USER}" -g "${SVC_GROUP}" "${MASTER_KEY_IN}" "${KEY_FILE}"
  ok "master key installed for restore"
fi

# Stage the backup where the (unprivileged) service user can read it.
STAGED="${DATA_DIR}/backups/.restore-$(basename -- "${IN_FILE}")"
run cp -- "${IN_FILE}" "${STAGED}"
run chown "${SVC_USER}:${SVC_GROUP}" "${STAGED}"
log "running application restore"
node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${APP_DIR}" restore --in "${STAGED}" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
run rm -f -- "${STAGED}"

log "applying migrations (backup may predate the installed release)"
node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${APP_DIR}" migrate

service_ctl start
if [ "${INIT_SYSTEM}" != none ]; then
  health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}" || die "service unhealthy after restore"
fi
ROLLBACK_ARMED=0
ok "restore complete. Verify: sign in, open a known patient, and run Audit -> Verify chain (GET /api/v1/audit/verify)."
if [ -n "${SNAP}" ]; then log "pre-restore snapshot retained at ${SNAP} (contains PHI + keys; delete it once satisfied)"; fi
