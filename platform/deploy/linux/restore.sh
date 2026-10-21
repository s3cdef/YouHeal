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
KEY_FILE=""
OLD_KEY_COPY=""
# F-03: all reads/writes inside the service-owned data dir run as the service account; symlinks abort.
# F-18: the safety snapshot holds db/ only (never keys/), is 0600 and service-owned, and is deleted
#       after a successful restore (kept only when the restore fails, for analysis).
rollback() {
  [ "${ROLLBACK_ARMED}" = 1 ] || return 0
  ROLLBACK_ARMED=0
  err "restore failed — rolling back to the pre-restore snapshot ${SNAP}"
  service_ctl stop || true
  if [ -n "${SNAP}" ] && [ -f "${SNAP}" ] && [ ! -L "${SNAP}" ]; then
    svc_exec "${SVC_USER}" rm -rf -- "${DATA_DIR}/db"
    svc_exec "${SVC_USER}" tar -xzf "${SNAP}" -C "${DATA_DIR}"
  fi
  if [ -n "${OLD_KEY_COPY}" ] && [ -f "${OLD_KEY_COPY}" ]; then
    svc_exec "${SVC_USER}" cp -- "${OLD_KEY_COPY}" "${KEY_FILE}"
    warn "previous master key reinstated from ${OLD_KEY_COPY}"
  fi
  service_ctl start || true
  if [ "${INIT_SYSTEM}" = none ]; then warn "rolled back; no init system — start the service manually"
  elif health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}"; then warn "rolled back; service is healthy on the previous data"
  else err "rollback finished but the service is NOT healthy — see docs/OPERATIONS.md §7"; fi
  if [ -n "${SNAP}" ]; then warn "pre-restore snapshot KEPT for analysis: ${SNAP} (PHI ciphertext; delete when done)"; fi
}
on_exit_hook() { if [ "$1" -ne 0 ]; then rollback; fi; }

assert_tree_no_symlinks "${DATA_DIR}"
service_ctl stop
if [ "${SAFETY}" = 1 ]; then
  SNAP="${DATA_DIR}/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  assert_no_symlink "${SNAP}"
  log "safety snapshot (cold copy of db/, keys excluded) -> ${SNAP}"
  # shellcheck disable=SC2016  # expanded by the inner shell (service account)
  svc_exec "${SVC_USER}" sh -c 'umask 077; tar -czf "$1" -C "$2" db' _ "${SNAP}" "${DATA_DIR}"
  ROLLBACK_ARMED=1
fi

if [ -n "${MASTER_KEY_IN}" ]; then
  [ -r "${MASTER_KEY_IN}" ] || die "cannot read ${MASTER_KEY_IN}"
  KEY_FILE="$(env_get "${ENV_FILE}" YH_MASTER_KEY_FILE "${DATA_DIR}/keys/master.key")"
  assert_no_symlink "${KEY_FILE}"
  if [ -f "${KEY_FILE}" ] && ! svc_exec "${SVC_USER}" cat -- "${KEY_FILE}" | tr -d ' \r\n\t' | cmp -s - <(tr -d ' \r\n\t' <"${MASTER_KEY_IN}"); then
    OLD_KEY_COPY="${DATA_DIR}/keys/retired/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).key"
    svc_mkdir "${SVC_USER}" "${DATA_DIR}/keys/retired" 0700
    svc_exec "${SVC_USER}" cp -- "${KEY_FILE}" "${OLD_KEY_COPY}"
    warn "previous master key kept as a retired (decrypt-only) key: ${OLD_KEY_COPY}"
  fi
  tr -d ' \r\n\t' <"${MASTER_KEY_IN}" | svc_write "${SVC_USER}" "${KEY_FILE}" 0600
  ok "master key installed for restore"
fi

# Stage the backup where the (unprivileged) service user can read it: root reads the operator's file,
# the service account writes the staged copy.
STAGED="${DATA_DIR}/backups/.restore-$(basename -- "${IN_FILE}")"
svc_write "${SVC_USER}" "${STAGED}" 0600 <"${IN_FILE}"
log "running application restore"
# Backend contract: `npm run restore -- <file.yhbak> --yes` (verifies the GCM tag + SQLite integrity before
# replacing the DB, refuses while the server pid file is live, and keeps its own .pre-restore copy).
node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${APP_DIR}" restore "${STAGED}" --yes ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
svc_exec "${SVC_USER}" rm -f -- "${STAGED}"

log "applying migrations (backup may predate the installed release)"
node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${APP_DIR}" migrate

service_ctl start
if [ "${INIT_SYSTEM}" != none ]; then
  health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}" || die "service unhealthy after restore"
fi
ROLLBACK_ARMED=0
if [ -n "${SNAP}" ]; then svc_exec "${SVC_USER}" rm -f -- "${SNAP}"; log "safety snapshot removed (restore succeeded)"; fi
ok "restore complete. Verify: sign in, open a known patient, and run Audit -> Verify chain (GET /api/v1/audit/verify)."
log "the application kept the replaced database as <data>/db/*.pre-restore-* — delete it once satisfied (PHI ciphertext)"
