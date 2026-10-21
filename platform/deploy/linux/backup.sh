#!/usr/bin/env bash
# YOU HEAL Clinical — encrypted backup with rotation (Linux/macOS).
#
# Wraps the application's own backup command (`npm run backup` == `node --run backup`), which writes an
# AES-256-GCM encrypted archive (key derived from the master key; CONTRACT §7, CP-9, SC-28). This script
# adds: a predictable file name, a .sha256 sidecar, retention (--keep N), an optional second copy
# (--copy-to, e.g. a mounted offsite/USB volume), and cron scheduling.
#
# The backup is useless without the master key, and the master key is deliberately NOT in the backup.
# Escrow the key separately (docs/OPERATIONS.md §6).
#
# Arguments after `--` are passed unchanged to the application's backup command.

set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
YH_ORIG_ARGS=("$@"); YH_ORIG_ARGS_STR="$*"

CONF_DIR="/etc/youheal"
OUT_DIR=""
KEEP=14
COPY_TO=""
CRON_ACTION=""
CRON_SCHEDULE="17 2 * * *"
EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: sudo $(basename -- "$0") [options] [-- <args for the app backup command>]

Create an encrypted ${YH_PRODUCT} backup and apply retention.

  --conf-dir DIR        install config dir (default: /etc/youheal; reads install.state + youheal.env)
  --out-dir DIR         where backups are written (default: <data-dir>/backups)
  --keep N              keep the N newest backups in --out-dir and --copy-to (default: 14; 0 = keep all)
  --copy-to DIR         also copy the backup + .sha256 to DIR (offsite/removable media) and verify it
  --install-cron [SCHED] install a root cron job (default schedule: "${CRON_SCHEDULE}") running this
                        script with the same --keep/--copy-to/--out-dir options, then exit
  --remove-cron         remove the cron job, then exit
  --log-file FILE       log file (default: /var/log/youheal-backup.log)
  --dry-run             show what would happen
  -v, --verbose         more output
  -h, --help            this help

Example:  sudo $(basename -- "$0") --keep 30 --copy-to /mnt/offsite/youheal
          sudo $(basename -- "$0") --install-cron "17 2 * * *" --keep 30 --copy-to /mnt/offsite/youheal
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --conf-dir) need_arg "$@"; CONF_DIR=$2; shift 2 ;;
    --out-dir) need_arg "$@"; OUT_DIR=$2; shift 2 ;;
    --keep) need_arg "$@"; KEEP=$2; shift 2 ;;
    --copy-to) need_arg "$@"; COPY_TO=$2; shift 2 ;;
    --install-cron)
      CRON_ACTION=install
      if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; then CRON_SCHEDULE=$2; shift 2; else shift; fi ;;
    --remove-cron) CRON_ACTION=remove; shift ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
case "${KEEP}" in ''|*[!0-9]*) die "--keep must be a non-negative integer";; esac

install_traps
YH_ELEVATION_REASON="read the PHI data directory and master key" require_root "${YH_ORIG_ARGS[@]+"${YH_ORIG_ARGS[@]}"}"
detect_platform
init_logging "${LOG_FILE:-/var/log/youheal-backup.log}"
load_install_state "${CONF_DIR}"
INIT_SYSTEM="${STATE_INIT_SYSTEM:-${INIT_SYSTEM}}"
ENV_FILE="${CONF_DIR}/youheal.env"
APP_DIR="${STATE_PREFIX}/current"
OUT_DIR="${OUT_DIR:-${STATE_DATA_DIR}/backups}"
SELF="${APP_DIR}/deploy/linux/backup.sh"

# ------------------------------------------------------------------------------------------------
CRON_TAG="# youheal-backup (managed by backup.sh)"
cron_line() {
  local args="--conf-dir ${CONF_DIR} --keep ${KEEP} --out-dir ${OUT_DIR} --log-file ${LOG_FILE}"
  if [ -n "${COPY_TO}" ]; then args="${args} --copy-to ${COPY_TO}"; fi
  printf '%s' "${args}"
}
if [ "${CRON_ACTION}" = install ]; then
  validate_value "schedule" "${CRON_SCHEDULE// /_}"
  if [ -d /etc/cron.d ] && [ "${OS_KERNEL}" = Linux ]; then
    write_file /etc/cron.d/youheal-backup 0644 "root:root" <<EOF
${CRON_TAG}
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${CRON_SCHEDULE} root ${SELF} $(cron_line) >/dev/null 2>&1
EOF
  else
    # busybox crond (Alpine) and macOS cron: root's crontab
    current="$(crontab -l 2>/dev/null | grep -v 'youheal-backup' || true)"
    newtab="$(printf '%s\n%s\n' "${current}" "${CRON_SCHEDULE} ${SELF} $(cron_line) >/dev/null 2>&1 ${CRON_TAG}" | sed '/^$/d')"
    if [ "${DRY_RUN}" = 1 ]; then run "crontab <<< '${newtab}'"; else printf '%s\n' "${newtab}" | crontab -; fi
    if [ "${OS_KERNEL}" = Darwin ]; then warn "macOS: grant 'Full Disk Access' to /usr/sbin/cron if the data dir is protected"; fi
  fi
  ok "backup scheduled: '${CRON_SCHEDULE}' -> ${SELF} $(cron_line)"
  exit 0
elif [ "${CRON_ACTION}" = remove ]; then
  run rm -f /etc/cron.d/youheal-backup
  if crontab -l >/dev/null 2>&1; then
    if [ "${DRY_RUN}" = 1 ]; then run "crontab -l | grep -v youheal-backup | crontab -"
    else crontab -l | grep -v 'youheal-backup' | crontab - || true; fi
  fi
  ok "backup schedule removed"
  exit 0
fi

# ------------------------------------------------------------------------------------------------
[ -x "${STATE_NODE_BIN}" ] || [ "${DRY_RUN}" = 1 ] || die "node runtime ${STATE_NODE_BIN} not found"
run mkdir -p "${OUT_DIR}"
run chown "${STATE_SERVICE_USER}:$(id -gn "${STATE_SERVICE_USER}" 2>/dev/null || echo "${STATE_SERVICE_USER}")" "${OUT_DIR}"
run chmod 0700 "${OUT_DIR}"

HOST_TAG="$(hostname -s 2>/dev/null || hostname)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/youheal-${HOST_TAG}-${TS}.yhbak"
make_tmp
MARKER="${YH_TMP_DIR}/start.marker"; touch "${MARKER}"

log "creating encrypted backup -> ${FILE}"
node_script "${STATE_NODE_BIN}" "${STATE_SERVICE_USER}" "${ENV_FILE}" "${APP_DIR}" backup --out "${FILE}" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

if [ "${DRY_RUN}" = 0 ]; then
  if [ ! -s "${FILE}" ]; then
    # Fallback: the app wrote to its default directory (<data-dir>/backups) and ignored --out.
    newest="$(find "${STATE_DATA_DIR}/backups" "${OUT_DIR}" -maxdepth 1 -type f -newer "${MARKER}" ! -name '*.sha256' 2>/dev/null | head -n 1 || true)"
    [ -n "${newest}" ] || die "backup command finished but produced no file"
    mv -f -- "${newest}" "${FILE}"
  fi
  SUM="$(sha256_of "${FILE}")"
  printf '%s  %s\n' "${SUM}" "$(basename -- "${FILE}")" >"${FILE}.sha256"
  chown "${STATE_SERVICE_USER}" "${FILE}" "${FILE}.sha256"; chmod 0600 "${FILE}" "${FILE}.sha256"
  ok "backup written: ${FILE} ($(wc -c <"${FILE}" | tr -d ' ') bytes, sha256 ${SUM})"
fi
log "verifying backup (GCM authentication tag) with the application"
node_script "${STATE_NODE_BIN}" "${STATE_SERVICE_USER}" "${ENV_FILE}" "${APP_DIR}" backup --verify "${FILE}"
ok "backup verified"

if [ -n "${COPY_TO}" ]; then
  run mkdir -p "${COPY_TO}"; run chmod 0700 "${COPY_TO}"
  run cp -p -- "${FILE}" "${FILE}.sha256" "${COPY_TO}/"
  if [ "${DRY_RUN}" = 0 ]; then
    [ "$(sha256_of "${COPY_TO}/$(basename -- "${FILE}")")" = "${SUM}" ] || die "copy verification failed in ${COPY_TO}"
    ok "verified copy in ${COPY_TO}"
  fi
fi

rotate() {
  local dir=$1 n=0 f
  [ "${KEEP}" -gt 0 ] || return 0
  [ -d "${dir}" ] || return 0
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    n=$((n + 1))
    if [ "${n}" -gt "${KEEP}" ]; then run rm -f -- "${f}" "${f}.sha256"; log "rotated out $(basename -- "${f}")"; fi
  done < <(find "${dir}" -maxdepth 1 -type f -name 'youheal-*.yhbak' | LC_ALL=C sort -r)
}
rotate "${OUT_DIR}"
if [ -n "${COPY_TO}" ]; then rotate "${COPY_TO}"; fi
ok "backup complete (retention: ${KEEP})"
