#!/usr/bin/env bash
# YOU HEAL Clinical — in-place upgrade with automatic rollback (Linux/macOS).
#
#   1. preflight: new source/bundle integrity, version, Node engine requirement
#   2. encrypted backup (backup.sh) — the offline recovery point
#   3. stop service; cold snapshot of <data-dir>/db (fast rollback: migrations are forward-only)
#   4. stage the new release with ITS OWN install.sh (idempotent; --skip-migrate --no-start), which
#      switches <prefix>/current and refreshes the env file / service definition
#   5. migrate + catalog load as the service user
#   6. start + health check
#   on failure in 4-6: stop -> point current back at the previous release -> restore the db snapshot,
#   env file, install.state and service definition -> start -> health check.
#
# Releases are kept side by side under <prefix>/releases/, so rollback never needs the network.

set -Eeuo pipefail
umask 022
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
YH_ORIG_ARGS=("$@"); YH_ORIG_ARGS_STR="$*"

CONF_DIR="/etc/youheal"
FROM=""
DO_BACKUP=1
HEALTH_RETRIES=45
KEEP_RELEASES=3
INSTALL_EXTRA=()

usage() {
  cat <<EOF
Usage: sudo $(basename -- "$0") --from PATH [options] [-- <extra install.sh options>]

Upgrade an installed ${YH_PRODUCT} to the release at PATH, rolling back automatically on failure.

  --from PATH           new release: a source tree (with package.json), an offline bundle directory,
                        or an offline bundle archive (youheal-<ver>-<os>-<arch>.tar.gz)
  --conf-dir DIR        install config dir (default: /etc/youheal)
  --skip-backup         do not take an encrypted backup first (NOT recommended)
  --health-retries N    health probe attempts, 2 s apart (default: ${HEALTH_RETRIES})
  --keep-releases N     previous releases kept on disk (default: ${KEEP_RELEASES})
  --log-file FILE       log file (default: /var/log/youheal-upgrade.log)
  --dry-run             show what would happen
  -y, --yes             do not ask for confirmation
  -v, --verbose         more output
  -h, --help            this help
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) need_arg "$@"; FROM=$2; shift 2 ;;
    --conf-dir) need_arg "$@"; CONF_DIR=$2; shift 2 ;;
    --skip-backup) DO_BACKUP=0; shift ;;
    --health-retries) need_arg "$@"; HEALTH_RETRIES=$2; shift 2 ;;
    --keep-releases) need_arg "$@"; KEEP_RELEASES=$2; shift 2 ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; INSTALL_EXTRA=("$@"); break ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[ -n "${FROM}" ] || { usage >&2; die "--from PATH is required"; }

install_traps
YH_ELEVATION_REASON="replace the installed application" require_root "${YH_ORIG_ARGS[@]+"${YH_ORIG_ARGS[@]}"}"
detect_platform
init_logging "${LOG_FILE:-/var/log/youheal-upgrade.log}"
load_install_state "${CONF_DIR}"
INIT_SYSTEM="${STATE_INIT_SYSTEM:-${INIT_SYSTEM}}"
ENV_FILE="${CONF_DIR}/youheal.env"
PREFIX="${STATE_PREFIX}"
DATA_DIR="${STATE_DATA_DIR}"
SVC_USER="${STATE_SERVICE_USER}"

[ -L "${PREFIX}/current" ] || die "${PREFIX}/current is not a symlink; was this host installed with install.sh?"
OLD_RELEASE="$(cd -- "${PREFIX}/current" && pwd -P)"
OLD_VERSION="$(env_get "${OLD_RELEASE}/.youheal-release" VERSION unknown)"

# ------------------------------------------------------------------------------------------------
# 1. Preflight
# ------------------------------------------------------------------------------------------------
make_tmp
BUNDLE_ARG=()
if [ -f "${FROM}" ]; then
  log "extracting ${FROM}"
  mkdir -p "${YH_TMP_DIR}/new"
  tar -xzf "${FROM}" -C "${YH_TMP_DIR}/new"
  FROM="$(find "${YH_TMP_DIR}/new" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
fi
[ -d "${FROM}" ] || die "--from ${FROM} is not a file or directory"
FROM="$(cd -- "${FROM}" && pwd -P)"
if [ -f "${FROM}/BUNDLE.json" ]; then
  NEW_SRC="${FROM}/app"; BUNDLE_ARG=(--offline-bundle "${FROM}")
else
  NEW_SRC="${FROM}"
fi
if [ ! -f "${NEW_SRC}/package.json" ] || [ ! -f "${NEW_SRC}/deploy/linux/install.sh" ]; then
  die "${NEW_SRC} does not look like a ${YH_PRODUCT} release (package.json + deploy/linux/install.sh)"
fi
NEW_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${NEW_SRC}/package.json" | head -n 1)"
NEED_NODE="$(sed -n 's/^[[:space:]]*"node"[[:space:]]*:[[:space:]]*">=\{0,1\}[[:space:]]*\([0-9.]*\)".*/\1/p' "${NEW_SRC}/package.json" | head -n 1)"
CUR_NODE="$("${STATE_NODE_BIN}" --version 2>/dev/null | sed 's/^v//' || echo 0)"
log "upgrade plan: ${OLD_VERSION} (${OLD_RELEASE}) -> ${NEW_VERSION} (${NEW_SRC})"
log "node: installed ${CUR_NODE}, release requires >= ${NEED_NODE:-?}"
NODE_ARG=()
if [ -n "${NEED_NODE}" ] && version_ge "${CUR_NODE}" "${NEED_NODE}"; then
  NODE_ARG=(--node-bin "${STATE_NODE_BIN}")
else
  warn "installed Node ${CUR_NODE} does not satisfy >= ${NEED_NODE}; install.sh will provision a newer runtime"
fi
if [ "${NEW_VERSION}" = "${OLD_VERSION}" ]; then warn "new version equals installed version (${NEW_VERSION}); proceeding (content may differ)"; fi
confirm "Upgrade ${YH_PRODUCT} on $(hostname) from ${OLD_VERSION} to ${NEW_VERSION}? The service will be briefly stopped." || die "aborted by operator"

# Carry over settings that install.sh regenerates in the managed part of the env file.
HOST="$(env_get "${ENV_FILE}" YH_HOST 0.0.0.0)"
PORT="$(env_get "${ENV_FILE}" YH_PORT 8443)"
TRUST="$(env_get "${ENV_FILE}" YH_TRUST_PROXY 0)"
ORIGIN="$(env_get "${ENV_FILE}" YH_PUBLIC_ORIGIN "")"
CARRY=(--prefix "${PREFIX}" --data-dir "${DATA_DIR}" --conf-dir "${CONF_DIR}" --user "${SVC_USER}"
       --host "${HOST}" --port "${PORT}" --init "${INIT_SYSTEM}" --keep-releases "${KEEP_RELEASES}"
       --skip-migrate --skip-catalog --no-start --yes)
if [ -n "${STATE_LOG_DIR}" ]; then CARRY+=(--log-dir "${STATE_LOG_DIR}"); fi
if [ "${TRUST}" != 0 ]; then CARRY+=(--trust-proxy); fi
TPROX="$(env_get "${ENV_FILE}" YH_TRUSTED_PROXIES "")"
if [ -n "${TPROX}" ]; then CARRY+=(--trusted-proxies "${TPROX}"); fi
if [ -n "${ORIGIN}" ]; then CARRY+=(--public-origin "${ORIGIN}"); fi
FQDN_STATE="$(env_get "${CONF_DIR}/install.state" FQDN "")"
if [ -n "${FQDN_STATE}" ]; then CARRY+=(--hostname "${FQDN_STATE}"); fi
if [ "${DRY_RUN}" = 1 ]; then CARRY+=(--dry-run); fi

# NEW-4: this release rejects unknown Host headers unless listed in YH_ALLOWED_HOSTS.
host_check() {
  local h a o
  h="$(env_get "${ENV_FILE}" YH_HOST 0.0.0.0)"; a="$(env_get "${ENV_FILE}" YH_ALLOWED_HOSTS "")"; o="$(env_get "${ENV_FILE}" YH_PUBLIC_ORIGIN "")"
  case "${h}" in 127.*|localhost|::1) return 0 ;; esac
  if [ -z "${a}" ] && [ -z "${o}" ]; then
    warn "YH_ALLOWED_HOSTS and YH_PUBLIC_ORIGIN are both empty on non-loopback bind ${h}: browsers using any name/IP other than"
    warn "localhost, the machine hostname or the bound IP will get 'Host not allowed'. Add YH_ALLOWED_HOSTS (docs/OPERATIONS.md §8)."
    return 1
  fi
  return 0
}
host_check || log "the new installer derives YH_ALLOWED_HOSTS from the certificate SANs during step 4; verify it afterwards"

# ------------------------------------------------------------------------------------------------
# 2. Backup
# ------------------------------------------------------------------------------------------------
if [ "${DO_BACKUP}" = 1 ]; then
  log "step 2/6: encrypted backup"
  BK_ARGS=(--conf-dir "${CONF_DIR}" --keep 0 --log-file "${LOG_FILE%.log}-backup.log")
  if [ "${DRY_RUN}" = 1 ]; then BK_ARGS+=(--dry-run); fi
  bash "${OLD_RELEASE}/deploy/linux/backup.sh" "${BK_ARGS[@]}" >/dev/null 2>&1 \
    || die "pre-upgrade backup failed (see ${LOG_FILE%.log}-backup.log); nothing was changed"
  ok "pre-upgrade backup written (log: ${LOG_FILE%.log}-backup.log)"
else
  warn "step 2/6: backup skipped (--skip-backup)"
fi

# ------------------------------------------------------------------------------------------------
# 3. Stop + snapshot (+ save config artefacts for rollback)
# ------------------------------------------------------------------------------------------------
log "step 3/6: stop service and snapshot"
SAVE="${YH_TMP_DIR}/saved"; mkdir -p "${SAVE}"
cp -p "${ENV_FILE}" "${SAVE}/youheal.env"
cp -p "${CONF_DIR}/install.state" "${SAVE}/install.state"
UNIT=""
case "${INIT_SYSTEM}" in
  systemd) UNIT="/etc/systemd/system/${YH_SERVICE_NAME}.service" ;;
  openrc)  UNIT="/etc/init.d/${YH_SERVICE_NAME}" ;;
  launchd) UNIT="/Library/LaunchDaemons/${YH_LAUNCHD_LABEL}.plist" ;;
esac
if [ -n "${UNIT}" ] && [ -f "${UNIT}" ]; then cp -p "${UNIT}" "${SAVE}/unit"; fi

assert_tree_no_symlinks "${DATA_DIR}"
service_ctl stop
# F-03/F-18: snapshot written by the service account (0600), db/ only (no keys), removed on success.
SNAP="${DATA_DIR}/backups/pre-upgrade-${OLD_VERSION}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
assert_no_symlink "${SNAP}"
# shellcheck disable=SC2016  # expanded by the inner shell (service account)
svc_exec "${SVC_USER}" sh -c 'umask 077; tar -czf "$1" -C "$2" db' _ "${SNAP}" "${DATA_DIR}"

ROLLBACK_ARMED=1
rollback() {
  [ "${ROLLBACK_ARMED}" = 1 ] || return 0
  ROLLBACK_ARMED=0
  if [ "${DRY_RUN}" = 1 ]; then return 0; fi
  err "upgrade failed — rolling back to ${OLD_VERSION} (${OLD_RELEASE})"
  service_ctl stop || true
  ln -sfn "${OLD_RELEASE}" "${PREFIX}/.current.tmp"
  mv -T "${PREFIX}/.current.tmp" "${PREFIX}/current" 2>/dev/null || { rm -f "${PREFIX}/current" "${PREFIX}/.current.tmp"; ln -s "${OLD_RELEASE}" "${PREFIX}/current"; }
  if [ -f "${SNAP}" ] && [ ! -L "${SNAP}" ]; then
    svc_exec "${SVC_USER}" rm -rf -- "${DATA_DIR}/db"
    svc_exec "${SVC_USER}" tar -xzf "${SNAP}" -C "${DATA_DIR}"
    warn "pre-upgrade snapshot KEPT for analysis: ${SNAP} (PHI ciphertext; delete when done)"
  fi
  cp -p "${SAVE}/youheal.env" "${ENV_FILE}"
  cp -p "${SAVE}/install.state" "${CONF_DIR}/install.state"
  if [ -n "${UNIT}" ] && [ -f "${SAVE}/unit" ]; then
    cp -p "${SAVE}/unit" "${UNIT}"
    if [ "${INIT_SYSTEM}" = systemd ]; then systemctl daemon-reload; fi
  fi
  service_ctl start || true
  YH_HEALTH_PROBE="${OLD_RELEASE}/deploy/common/healthcheck.mjs"; export YH_HEALTH_PROBE
  if [ "${INIT_SYSTEM}" = none ]; then
    warn "ROLLED BACK files/DB to ${OLD_VERSION}; no init system — start the service manually and verify health."
  elif health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}"; then
    warn "ROLLED BACK: ${OLD_VERSION} is running and healthy. The failed release remains under ${PREFIX}/releases for analysis."
  else
    err "ROLLBACK INCOMPLETE: service unhealthy. Restore from the encrypted backup (restore.sh) — docs/OPERATIONS.md §8."
  fi
}
on_exit_hook() { if [ "$1" -ne 0 ]; then rollback; fi; }

# ------------------------------------------------------------------------------------------------
# 4. Stage + switch (new release's own installer)
# ------------------------------------------------------------------------------------------------
log "step 4/6: install release ${NEW_VERSION}"
INSTALL_CMD=(bash "${NEW_SRC}/deploy/linux/install.sh" --source "${NEW_SRC}" "${CARRY[@]}"
  ${BUNDLE_ARG[@]+"${BUNDLE_ARG[@]}"} ${NODE_ARG[@]+"${NODE_ARG[@]}"} ${INSTALL_EXTRA[@]+"${INSTALL_EXTRA[@]}"}
  --log-file "${LOG_FILE%.log}-install.log")
if [ "${DRY_RUN}" = 1 ]; then
  "${INSTALL_CMD[@]}"     # dry-run: show the nested plan inline
elif ! "${INSTALL_CMD[@]}" >/dev/null 2>&1; then
  err "install step failed; see ${LOG_FILE%.log}-install.log"; tail -n 30 "${LOG_FILE%.log}-install.log" >&2 || true; exit 1
fi
ok "release staged (installer log: ${LOG_FILE%.log}-install.log)"
load_install_state "${CONF_DIR}"     # NODE_BIN may have changed
NEW_RELEASE="$(cd -- "${PREFIX}/current" && pwd -P)"

host_check || true

# ------------------------------------------------------------------------------------------------
# 5. Migrate + catalog
# ------------------------------------------------------------------------------------------------
log "step 5/6: migrations + catalog"
node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${PREFIX}/current" migrate
if [ -f "${PREFIX}/current/data/catalog/points.json" ] || [ -f "${PREFIX}/current/data/catalog/manifest.json" ] || [ "${DRY_RUN}" = 1 ]; then
  node_script "${STATE_NODE_BIN}" "${SVC_USER}" "${ENV_FILE}" "${PREFIX}/current" catalog:load
else
  warn "no catalog JSON in the new release — catalog load skipped"
fi

# ------------------------------------------------------------------------------------------------
# 6. Start + verify
# ------------------------------------------------------------------------------------------------
log "step 6/6: start and health check"
service_ctl start
YH_HEALTH_PROBE="${PREFIX}/current/deploy/common/healthcheck.mjs"; export YH_HEALTH_PROBE
if [ "${INIT_SYSTEM}" != none ]; then
  health_check "${STATE_NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}" || die "new release failed its health check"
fi
ROLLBACK_ARMED=0
ok "upgraded ${OLD_VERSION} -> ${NEW_VERSION} (${NEW_RELEASE})"
svc_exec "${SVC_USER}" rm -f -- "${SNAP}"
log "pre-upgrade DB snapshot removed (upgrade succeeded); the encrypted pre-upgrade backup remains in <data>/backups"
log "manual rollback if needed later: see docs/OPERATIONS.md §8 (previous release + encrypted pre-upgrade backup are on disk)"
