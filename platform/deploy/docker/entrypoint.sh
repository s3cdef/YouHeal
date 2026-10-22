#!/bin/sh
# YOU HEAL Clinical — container entrypoint.
#
# POSIX sh on purpose: the image ships no bash (smaller attack surface). busybox ash supports
# `set -o pipefail`; `set -E` / ERR traps are bash-only, so failures are handled with `set -e` + an
# EXIT trap that reports the failing step.
#
# Responsibilities (idempotent, run on every start, as uid 10001 — never as root):
#   1. Resolve the master key: $YH_MASTER_KEY  >  secret file ($YH_MASTER_KEY_FILE, default
#      /run/secrets/yh_master_key; passed to the server by path, never copied into the env)  >
#      /data/keys/master.key  >  (only if YH_GENERATE_MASTER_KEY=1) generate /data/keys/master.key.
#      Otherwise FAIL CLOSED (the server itself would silently generate one).
#   2. Resolve TLS: $YH_TLS_CERT/$YH_TLS_KEY  >  /run/secrets/yh_tls_cert + yh_tls_key  >
#      /data/tls/{cert,key}.pem  >  generate a self-signed cert (P-256 default, 825 days, SAN).
#      YH_TLS_DISABLE=1 serves plain HTTP (ONLY behind a TLS-terminating proxy on a private network).
#   3. Run DB migrations (YH_AUTO_MIGRATE, default 1) and catalog load (YH_AUTO_CATALOG, default 1).
#   4. exec the CMD (node server/index.js) so tini -> node receives signals directly.
#
# Usage: youheal-entrypoint [--help | --dry-run | <command> [args...]]
#   --dry-run   print the resolved plan (no key material) and exit 0 without changing anything.
# Log: stderr (container log driver) and /data/logs/entrypoint.log.

set -eu
# shellcheck disable=SC3040  # busybox ash and dash >= 0.5.11 support pipefail; ignored elsewhere
set -o pipefail 2>/dev/null || true
umask 077

DATA_DIR="${YH_DATA_DIR:-/data}"
APP_DIR="${YH_APP_DIR:-/app}"
LOG_DIR="${DATA_DIR}/logs"
LOG_FILE="${YH_ENTRYPOINT_LOG:-${LOG_DIR}/entrypoint.log}"
DRY_RUN=0
STEP="init"

log() {
  _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _line="${_ts} [entrypoint] $*"
  printf '%s\n' "${_line}" >&2
  if [ "${DRY_RUN}" = 0 ] && [ -d "${LOG_DIR}" ] && [ -w "${LOG_DIR}" ]; then
    printf '%s\n' "${_line}" >>"${LOG_FILE}" 2>/dev/null || true
  fi
}
die() { log "FATAL: $*"; exit 1; }
on_exit() {
  _rc=$?
  if [ "${_rc}" -ne 0 ]; then log "failed during step '${STEP}' (exit ${_rc})"; fi
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --dry-run) DRY_RUN=1; shift ;;
esac
if [ "$#" -eq 0 ]; then
  set -- node --disable-warning=ExperimentalWarning server/index.js
fi

is_true() { case "${1:-}" in 1|true|TRUE|yes|YES|on|ON) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------------------------------------
STEP="preflight"
if [ "$(id -u)" = "0" ] && ! is_true "${YH_ALLOW_ROOT:-0}"; then
  die "refusing to run as root (uid 0). Run as uid 10001 (the image default) or set YH_ALLOW_ROOT=1 for debugging only."
fi
[ -d "${DATA_DIR}" ] || die "data directory ${DATA_DIR} does not exist; mount a volume at ${DATA_DIR}."
if [ "${DRY_RUN}" = 0 ]; then
  [ -w "${DATA_DIR}" ] || die "data directory ${DATA_DIR} is not writable by uid $(id -u). Fix volume ownership: chown -R 10001:10001 <volume>."
  mkdir -p "${DATA_DIR}/keys" "${DATA_DIR}/tls" "${DATA_DIR}/db" "${DATA_DIR}/backups" "${LOG_DIR}"
  chmod 0700 "${DATA_DIR}" "${DATA_DIR}/keys" "${DATA_DIR}/tls" "${DATA_DIR}/db" "${DATA_DIR}/backups" "${LOG_DIR}" 2>/dev/null || true
fi
log "YOU HEAL Clinical entrypoint (node $(node --version), uid $(id -u), data ${DATA_DIR}, dry-run=${DRY_RUN})"

# Validate a base64 master key read from stdin (never via argv, which is visible in /proc).
valid_key_stdin() {
  node -e '
    let s = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", d => s += d).on("end", () => {
      const b = Buffer.from(s.trim(), "base64");
      process.exit(b.length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(s.trim()) ? 0 : 1);
    });'
}

# ---------------------------------------------------------------------------------------------
STEP="master-key"
KEY_FILE_DEFAULT="${DATA_DIR}/keys/master.key"
SECRET_KEY_FILE="${YH_MASTER_KEY_FILE:-/run/secrets/yh_master_key}"
if [ -n "${YH_MASTER_KEY:-}" ]; then
  printf '%s' "${YH_MASTER_KEY}" | valid_key_stdin || die "YH_MASTER_KEY is not base64 of exactly 32 bytes."
  log "master key: from YH_MASTER_KEY environment variable"
elif [ -f "${SECRET_KEY_FILE}" ]; then
  [ -r "${SECRET_KEY_FILE}" ] || die "secret ${SECRET_KEY_FILE} exists but is not readable by uid $(id -u). On the host: chown 10001:10001 <file> && chmod 0400 <file> (compose file-secrets are bind mounts and keep host ownership)."
  valid_key_stdin <"${SECRET_KEY_FILE}" || die "secret ${SECRET_KEY_FILE} is not base64 of exactly 32 bytes (generate with: openssl rand -base64 32)."
  _mode="$(stat -c %a "${SECRET_KEY_FILE}" 2>/dev/null || echo 600)"
  case "${_mode}" in *00) ;; *) die "secret ${SECRET_KEY_FILE} has mode ${_mode}; the server requires no group/other access. On the host: chmod 0400 <file>." ;; esac
  # The server reads the key file itself (YH_MASTER_KEY_FILE); the key never enters the environment.
  YH_MASTER_KEY_FILE="${SECRET_KEY_FILE}"
  export YH_MASTER_KEY_FILE
  log "master key: secret file ${SECRET_KEY_FILE}"
elif [ -f "${KEY_FILE_DEFAULT}" ]; then
  unset YH_MASTER_KEY_FILE
  valid_key_stdin <"${KEY_FILE_DEFAULT}" || die "${KEY_FILE_DEFAULT} is not base64 of exactly 32 bytes."
  log "master key: key file ${KEY_FILE_DEFAULT} (co-located with data; prefer a Docker secret)"
elif is_true "${YH_GENERATE_MASTER_KEY:-0}"; then
  unset YH_MASTER_KEY_FILE
  if [ "${DRY_RUN}" = 1 ]; then
    log "[dry-run] would generate ${KEY_FILE_DEFAULT}"
  else
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' >"${KEY_FILE_DEFAULT}.tmp"
    chmod 0600 "${KEY_FILE_DEFAULT}.tmp"
    mv -f "${KEY_FILE_DEFAULT}.tmp" "${KEY_FILE_DEFAULT}"
    log "WARNING: generated a NEW master key at ${KEY_FILE_DEFAULT}. It is stored on the same volume as the data."
    log "WARNING: escrow it offline NOW (docker compose cp youheal:${KEY_FILE_DEFAULT} ./master.key) — without it backups are unrecoverable."
  fi
else
  die "no master key. Provide a Docker secret 'yh_master_key' (see deploy/docker/compose.yaml), set YH_MASTER_KEY, or set YH_GENERATE_MASTER_KEY=1 for a throwaway/dev instance."
fi

# ---------------------------------------------------------------------------------------------
STEP="tls"
gen_self_signed() {
  _crt="$1"; _key="$2"
  _cn="${YH_TLS_HOSTNAME:-$(hostname 2>/dev/null || echo localhost)}"
  _san="DNS:${_cn},DNS:localhost,IP:127.0.0.1,IP:::1"
  if [ -n "${YH_TLS_SAN:-}" ]; then _san="${_san},${YH_TLS_SAN}"; fi
  # ECDSA keys sign only; keyEncipherment is meaningful for RSA key transport.
  case "${YH_TLS_KEY_ALG:-ec}" in rsa|RSA) _ku="digitalSignature, keyEncipherment" ;; *) _ku="digitalSignature" ;; esac
  _cfg="$(mktemp /tmp/yh-openssl.XXXXXX)"
  cat >"${_cfg}" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3
[dn]
CN = ${_cn}
O = YOU HEAL Clinical (self-signed)
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, ${_ku}
extendedKeyUsage = serverAuth
subjectAltName = ${_san}
subjectKeyIdentifier = hash
EOF
  case "${YH_TLS_KEY_ALG:-ec}" in
    rsa|RSA) openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${_key}.tmp" 2>/dev/null ;;
    *)       openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "${_key}.tmp" 2>/dev/null ;;
  esac
  chmod 0600 "${_key}.tmp"
  openssl req -new -x509 -sha256 -days "${YH_TLS_DAYS:-825}" -key "${_key}.tmp" -out "${_crt}.tmp" -config "${_cfg}"
  rm -f "${_cfg}"
  chmod 0644 "${_crt}.tmp"
  mv -f "${_key}.tmp" "${_key}"
  mv -f "${_crt}.tmp" "${_crt}"
  log "generated self-signed TLS certificate ${_crt} (CN=${_cn}; SAN=${_san}; $(openssl x509 -noout -fingerprint -sha256 -in "${_crt}"))"
}

if is_true "${YH_TLS_DISABLE:-0}"; then
  unset YH_TLS_CERT YH_TLS_KEY
  log "WARNING: TLS disabled (YH_TLS_DISABLE=1). Only acceptable behind a TLS-terminating reverse proxy on a private network; set YH_TRUST_PROXY=1 and YH_HEALTH_SCHEME=http."
elif [ -n "${YH_TLS_CERT:-}" ] || [ -n "${YH_TLS_KEY:-}" ]; then
  [ -r "${YH_TLS_CERT:-/nonexistent}" ] || die "YH_TLS_CERT='${YH_TLS_CERT:-}' is not readable."
  [ -r "${YH_TLS_KEY:-/nonexistent}" ] || die "YH_TLS_KEY='${YH_TLS_KEY:-}' is not readable."
  log "TLS: operator-supplied certificate ${YH_TLS_CERT}"
elif [ -r /run/secrets/yh_tls_cert ] && [ -r /run/secrets/yh_tls_key ]; then
  export YH_TLS_CERT=/run/secrets/yh_tls_cert YH_TLS_KEY=/run/secrets/yh_tls_key
  log "TLS: certificate from Docker secrets yh_tls_cert / yh_tls_key"
else
  export YH_TLS_CERT="${DATA_DIR}/tls/cert.pem" YH_TLS_KEY="${DATA_DIR}/tls/key.pem"
  if [ -s "${YH_TLS_CERT}" ] && [ -s "${YH_TLS_KEY}" ]; then
    if ! openssl x509 -checkend 2592000 -noout -in "${YH_TLS_CERT}" >/dev/null 2>&1; then
      log "WARNING: ${YH_TLS_CERT} expires within 30 days (or is invalid). Delete it to regenerate, or mount a replacement."
    fi
    log "TLS: existing certificate ${YH_TLS_CERT}"
  elif [ "${DRY_RUN}" = 1 ]; then
    log "[dry-run] would generate a self-signed certificate at ${YH_TLS_CERT}"
  else
    gen_self_signed "${YH_TLS_CERT}" "${YH_TLS_KEY}"
  fi
fi

# ---------------------------------------------------------------------------------------------
cd "${APP_DIR}"
run_script() {
  # `node --run` executes package.json scripts without npm (npm is removed from the image).
  if [ "${DRY_RUN}" = 1 ]; then log "[dry-run] would run: node --run $*"; return 0; fi
  log "running: node --run $*"
  node --run "$@"
}

STEP="migrate"
if is_true "${YH_AUTO_MIGRATE:-1}"; then run_script migrate; else log "skipping migrations (YH_AUTO_MIGRATE=0)"; fi

STEP="catalog"
if is_true "${YH_AUTO_CATALOG:-1}"; then
  _cat="${YH_CATALOG_DIR:-${APP_DIR}/data/catalog}"
  if [ -f "${_cat}/points.json" ] || [ -f "${_cat}/manifest.json" ]; then
    run_script catalog:load
  else
    log "WARNING: no catalog JSON in ${_cat} (points.json/manifest.json); catalog load skipped."
  fi
else
  log "skipping catalog load (YH_AUTO_CATALOG=0)"
fi

STEP="exec"
if [ "${DRY_RUN}" = 1 ]; then log "[dry-run] would exec: $*"; exit 0; fi
log "starting: $*"
trap - EXIT INT TERM
exec "$@"
