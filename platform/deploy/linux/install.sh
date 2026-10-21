#!/usr/bin/env bash
# YOU HEAL Clinical — host installer for Linux (Debian/Ubuntu, RHEL/Rocky/Alma/Fedora, openSUSE,
# Alpine, Arch) and macOS. Idempotent: re-running converges the host to the requested state.
#
# What it does (each step is skipped when already satisfied):
#   1. detects OS / CPU arch / init system (systemd, OpenRC, launchd) / package manager
#   2. ensures Node.js >= 22.13 (existing, distro package, or the official nodejs.org tarball verified
#      against SHASUMS256.txt; or the runtime inside an --offline-bundle)
#   3. creates the non-login service account (default: youheal)
#   4. installs the app into <prefix>/releases/<version>-<ts>, points <prefix>/current at it
#   5. creates the data dir (0700), master key (0600) and TLS certificate (self-signed unless provided)
#   6. writes <conf-dir>/youheal.env (0640 root:<group>) and the service definition, enables it
#   7. optionally opens the host firewall, runs DB migrations + catalog load, starts, health-checks
#   8. prints the first-run setup URL
#
# Run `install.sh --help` for options. Requires root (re-executes itself via sudo/doas).

set -Eeuo pipefail
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
YH_ORIG_ARGS=("$@")
YH_ORIG_ARGS_STR="$*"

# ------------------------------------------------------------------------------------------------
# Defaults
# ------------------------------------------------------------------------------------------------
SRC_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
PREFIX=""
DATA_DIR=""
CONF_DIR="/etc/youheal"
LOG_DIR=""
SERVICE_USER="youheal"
SERVICE_GROUP=""
BIND_HOST="0.0.0.0"
PORT="8443"
TLS_HOSTNAME=""
TLS_CERT_IN=""
TLS_KEY_IN=""
CERT_ALGO="ec"
CERT_DAYS="825"
EXTRA_SANS=""
REGEN_CERT=0
MASTER_KEY_IN=""
FORCE_KEY=0
TRUST_PROXY=0
PUBLIC_ORIGIN=""
NODE_SOURCE="auto"       # auto | system | distro | tarball
NODE_VERSION=""          # empty = latest v22.x
NODE_BIN_IN=""
NODE_MIRROR="https://nodejs.org/dist"
OFFLINE_BUNDLE=""
OPEN_FIREWALL=0
FIREWALL_SOURCE=""
INIT_OVERRIDE=""
DO_SERVICE=1
DO_START=1
DO_CATALOG=1
DO_MIGRATE=1
KEEP_RELEASES=3
HEALTH_RETRIES=30

usage() {
  cat <<EOF
Usage: sudo $(basename -- "$0") [options]

Install or update ${YH_PRODUCT} as a hardened system service.

Locations
  --prefix DIR            application root (default: /opt/youheal)
  --data-dir DIR          PHI data dir, 0700 (default: /var/lib/youheal; macOS /usr/local/var/youheal)
  --conf-dir DIR          config dir for youheal.env (default: /etc/youheal)
  --log-dir DIR           service log dir for OpenRC/launchd (default: /var/log/youheal)
  --source DIR            app source tree to install (default: this checkout: ${SRC_DIR})
  --user NAME             service account (default: youheal)

Network / TLS
  --host ADDR             listen address (default: 0.0.0.0; use 127.0.0.1 behind a local reverse proxy)
  --port N                listen port (default: 8443)
  --hostname FQDN         certificate CN + first SAN (default: hostname -f)
  --san LIST              extra SANs, comma-separated (e.g. DNS:clinic.lan,IP:192.168.1.20)
  --tls-cert FILE         use this PEM certificate (chain) instead of generating one
  --tls-key FILE          private key for --tls-cert (PEM)
  --cert-algo ec|rsa      self-signed key type: ec = P-256 (default), rsa = RSA-3072
  --cert-days N           self-signed validity in days (default: 825)
  --regen-cert            replace an existing self-signed certificate
  --trust-proxy           set YH_TRUST_PROXY=1 (only behind deploy/reverse-proxy/)
  --public-origin URL     external origin users browse to, e.g. https://clinic.example.org (YH_PUBLIC_ORIGIN)
  --open-firewall         open the port in ufw / firewalld / macOS application firewall
  --firewall-source CIDR  restrict the firewall rule to a source network (recommended, e.g. 192.168.1.0/24)

Keys
  --master-key-file FILE  import an existing master key (base64 of 32 bytes) e.g. for DR to a new host
  --force-key             allow --master-key-file to REPLACE an existing different key (data loss risk)

Node.js runtime
  --node-source MODE      auto (default) | system | distro | tarball
  --node-version X.Y.Z    tarball version (default: latest v22.x from the mirror)
  --node-bin PATH         use this node binary (must be >= ${YH_NODE_MIN})
  --node-mirror URL       HTTPS mirror of nodejs.org/dist (default: ${NODE_MIRROR})
  --offline-bundle PATH   air-gapped install from deploy/offline bundle (.tar.gz or extracted dir)

Behaviour
  --init SYSTEM           force init system: systemd | openrc | launchd | none
  --no-service            do not install/enable a service definition
  --no-start              install everything but do not (re)start the service
  --skip-migrate          do not run DB migrations
  --skip-catalog          do not run the catalog load
  --keep-releases N       old releases kept for rollback (default: 3)
  --log-file FILE         installer log (default: /var/log/youheal-install.log)
  --dry-run               print the plan and every action without changing anything (no root needed)
  -y, --yes               assume "yes" to prompts
  -v, --verbose           more output
  -h, --help              this help

Examples
  sudo ./install.sh --hostname clinic.lan --open-firewall --firewall-source 192.168.1.0/24
  sudo ./install.sh --host 127.0.0.1 --trust-proxy            # behind nginx/Caddy on the same host
  sudo ./install.sh --offline-bundle /media/usb/youheal-1.0.0-linux-x64.tar.gz
  ./install.sh --dry-run
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value (see --help)"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) need_arg "$@"; PREFIX=$2; shift 2 ;;
    --data-dir) need_arg "$@"; DATA_DIR=$2; shift 2 ;;
    --conf-dir) need_arg "$@"; CONF_DIR=$2; shift 2 ;;
    --log-dir) need_arg "$@"; LOG_DIR=$2; shift 2 ;;
    --source) need_arg "$@"; SRC_DIR="$(cd -- "$2" && pwd -P)"; shift 2 ;;
    --user) need_arg "$@"; SERVICE_USER=$2; shift 2 ;;
    --host) need_arg "$@"; BIND_HOST=$2; shift 2 ;;
    --port) need_arg "$@"; PORT=$2; shift 2 ;;
    --hostname) need_arg "$@"; TLS_HOSTNAME=$2; shift 2 ;;
    --san) need_arg "$@"; EXTRA_SANS=$2; shift 2 ;;
    --tls-cert) need_arg "$@"; TLS_CERT_IN=$2; shift 2 ;;
    --tls-key) need_arg "$@"; TLS_KEY_IN=$2; shift 2 ;;
    --cert-algo) need_arg "$@"; CERT_ALGO=$2; shift 2 ;;
    --cert-days) need_arg "$@"; CERT_DAYS=$2; shift 2 ;;
    --regen-cert) REGEN_CERT=1; shift ;;
    --trust-proxy) TRUST_PROXY=1; shift ;;
    --public-origin) need_arg "$@"; PUBLIC_ORIGIN=$2; shift 2 ;;
    --open-firewall) OPEN_FIREWALL=1; shift ;;
    --firewall-source) need_arg "$@"; FIREWALL_SOURCE=$2; shift 2 ;;
    --master-key-file) need_arg "$@"; MASTER_KEY_IN=$2; shift 2 ;;
    --force-key) FORCE_KEY=1; shift ;;
    --node-source) need_arg "$@"; NODE_SOURCE=$2; shift 2 ;;
    --node-version) need_arg "$@"; NODE_VERSION=${2#v}; shift 2 ;;
    --node-bin) need_arg "$@"; NODE_BIN_IN=$2; shift 2 ;;
    --node-mirror) need_arg "$@"; NODE_MIRROR=${2%/}; shift 2 ;;
    --offline-bundle) need_arg "$@"; OFFLINE_BUNDLE=$2; shift 2 ;;
    --init) need_arg "$@"; INIT_OVERRIDE=$2; shift 2 ;;
    --no-service) DO_SERVICE=0; DO_START=0; shift ;;
    --no-start) DO_START=0; shift ;;
    --skip-migrate) DO_MIGRATE=0; shift ;;
    --skip-catalog) DO_CATALOG=0; shift ;;
    --keep-releases) need_arg "$@"; KEEP_RELEASES=$2; shift 2 ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

install_traps
require_root "${YH_ORIG_ARGS[@]+"${YH_ORIG_ARGS[@]}"}"
detect_platform
if [ -n "${INIT_OVERRIDE}" ]; then INIT_SYSTEM="${INIT_OVERRIDE}"; fi

# Platform-dependent defaults
if [ "${OS_KERNEL}" = Darwin ]; then
  PREFIX="${PREFIX:-/opt/youheal}"; DATA_DIR="${DATA_DIR:-/usr/local/var/youheal}"; LOG_DIR="${LOG_DIR:-/usr/local/var/log/youheal}"
  ROOT_GROUP="wheel"; NOLOGIN="/usr/bin/false"
else
  PREFIX="${PREFIX:-/opt/youheal}"; DATA_DIR="${DATA_DIR:-/var/lib/youheal}"; LOG_DIR="${LOG_DIR:-/var/log/youheal}"
  ROOT_GROUP="root"
  NOLOGIN="/usr/sbin/nologin"; [ -x "${NOLOGIN}" ] || NOLOGIN="/sbin/nologin"; [ -x "${NOLOGIN}" ] || NOLOGIN="/bin/false"
fi
SERVICE_GROUP="${SERVICE_GROUP:-${SERVICE_USER}}"
init_logging "${LOG_FILE:-/var/log/youheal-install.log}"

# ------------------------------------------------------------------------------------------------
# Input validation
# ------------------------------------------------------------------------------------------------
for v in PREFIX DATA_DIR CONF_DIR LOG_DIR SERVICE_USER BIND_HOST PORT; do
  validate_value "${v}" "${!v}"
  case "${!v}" in *'|'*|*'@'*|*'#'*) die "invalid character in ${v}: ${!v}";; esac
done
case "${PREFIX}${DATA_DIR}${CONF_DIR}" in *..*) die "paths must not contain '..'";; esac
for v in PREFIX DATA_DIR CONF_DIR LOG_DIR; do case "${!v}" in /*) ;; *) die "${v} must be an absolute path";; esac; done
case "${PORT}" in ''|*[!0-9]*) die "--port must be numeric";; esac
if [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then die "--port out of range"; fi
if [ "${PORT}" -lt 1024 ]; then die "--port ${PORT} is privileged; the service runs with no capabilities. Use >= 1024 and a reverse proxy (deploy/reverse-proxy/) for 443."; fi
case "${SERVICE_USER}" in root|0) die "the service must not run as root";; esac
case "${CERT_ALGO}" in ec|rsa) ;; *) die "--cert-algo must be ec or rsa";; esac
case "${NODE_SOURCE}" in auto|system|distro|tarball) ;; *) die "--node-source must be auto|system|distro|tarball";; esac
case "${INIT_SYSTEM}" in systemd|openrc|launchd|none) ;; *) die "--init must be systemd|openrc|launchd|none";; esac
if [ -n "${TLS_CERT_IN}${TLS_KEY_IN}" ] && { [ -z "${TLS_CERT_IN}" ] || [ -z "${TLS_KEY_IN}" ]; }; then die "--tls-cert and --tls-key must be given together"; fi
if [ "${INIT_SYSTEM}" = systemd ]; then
  for v in PREFIX DATA_DIR; do
    case "${!v}" in /home/*|/root/*|/run/user/*) die "${v}=${!v} is hidden from the service by ProtectHome=yes; choose a path outside /home, /root, /run/user";; esac
  done
fi
[ -f "${SRC_DIR}/package.json" ] || [ -n "${OFFLINE_BUNDLE}" ] || die "no package.json in source dir ${SRC_DIR} (use --source)"

# Auto-detect running from inside an extracted offline bundle (<bundle>/app/deploy/linux/install.sh).
if [ -z "${OFFLINE_BUNDLE}" ] && [ -f "${SRC_DIR}/../BUNDLE.json" ] && [ -f "${SRC_DIR}/../CHECKSUMS.sha256" ]; then
  OFFLINE_BUNDLE="$(cd -- "${SRC_DIR}/.." && pwd -P)"
  log "detected offline bundle at ${OFFLINE_BUNDLE}"
fi

TLS_DIR="${DATA_DIR}/tls"
KEY_FILE="${DATA_DIR}/keys/master.key"
ENV_FILE="${CONF_DIR}/youheal.env"
STATE_FILE="${CONF_DIR}/install.state"
RUNTIME_DIR="${PREFIX}/runtime"
FQDN="${TLS_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
SHORT_HOST="$(hostname -s 2>/dev/null || hostname)"
validate_value "--hostname" "${FQDN}"
if [ -n "${PUBLIC_ORIGIN}" ]; then
  validate_value "--public-origin" "${PUBLIC_ORIGIN}"
  case "${PUBLIC_ORIGIN}" in https://*|http://*) ;; *) die "--public-origin must be an absolute http(s) origin";; esac
fi

# ------------------------------------------------------------------------------------------------
# Plan
# ------------------------------------------------------------------------------------------------
log "${YH_PRODUCT} installer — plan"
cat >&2 <<EOF
    platform      : ${OS_PRETTY} (${OS_KERNEL}/${ARCH_NODE}, libc ${LIBC})
    init system   : ${INIT_SYSTEM}        package manager: ${PKG_MGR}
    source        : ${OFFLINE_BUNDLE:-${SRC_DIR}}
    prefix        : ${PREFIX}   (releases/, current -> active release, runtime/)
    data dir      : ${DATA_DIR} (0700 ${SERVICE_USER})
    config        : ${ENV_FILE} (0640 root:${SERVICE_GROUP})
    service user  : ${SERVICE_USER} (shell ${NOLOGIN})
    listen        : ${BIND_HOST}:${PORT} (TLS)   trust proxy: ${TRUST_PROXY}
    certificate   : ${TLS_CERT_IN:-self-signed ${CERT_ALGO} ${CERT_DAYS}d for ${FQDN}}
    master key    : ${MASTER_KEY_IN:-${KEY_FILE} (generated if absent)}
    node          : source=${NODE_SOURCE} min=${YH_NODE_MIN} ${NODE_VERSION:+version=${NODE_VERSION}}
    firewall      : $( [ "${OPEN_FIREWALL}" = 1 ] && echo "open ${PORT}/tcp ${FIREWALL_SOURCE:+from ${FIREWALL_SOURCE}}" || echo "unchanged")
    service       : install=${DO_SERVICE} start=${DO_START} migrate=${DO_MIGRATE} catalog=${DO_CATALOG}
    log file      : ${LOG_FILE}
    dry run       : ${DRY_RUN}
EOF

# ------------------------------------------------------------------------------------------------
# Offline bundle: extract + verify
# ------------------------------------------------------------------------------------------------
BUNDLE_DIR=""
prepare_bundle() {
  [ -n "${OFFLINE_BUNDLE}" ] || return 0
  make_tmp
  if [ -d "${OFFLINE_BUNDLE}" ]; then
    BUNDLE_DIR="$(cd -- "${OFFLINE_BUNDLE}" && pwd -P)"
  elif [ -f "${OFFLINE_BUNDLE}" ]; then
    log "extracting offline bundle ${OFFLINE_BUNDLE}"
    mkdir -p "${YH_TMP_DIR}/bundle"
    tar -xzf "${OFFLINE_BUNDLE}" -C "${YH_TMP_DIR}/bundle"
    BUNDLE_DIR="$(find "${YH_TMP_DIR}/bundle" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  else
    die "--offline-bundle ${OFFLINE_BUNDLE} not found"
  fi
  [ -f "${BUNDLE_DIR}/CHECKSUMS.sha256" ] || die "bundle has no CHECKSUMS.sha256"
  log "verifying bundle checksums (${BUNDLE_DIR}/CHECKSUMS.sha256)"
  local bad=0 sum path actual
  while read -r sum path; do
    path="${path#\*}"; path="${path#./}"
    [ -n "${sum}" ] || continue
    actual="$(sha256_of "${BUNDLE_DIR}/${path}")"
    if [ "${actual}" != "${sum}" ]; then err "checksum mismatch: ${path}"; bad=1; fi
  done <"${BUNDLE_DIR}/CHECKSUMS.sha256"
  [ "${bad}" = 0 ] || die "offline bundle failed integrity verification — do not install it"
  if [ -f "${BUNDLE_DIR}/CHECKSUMS.sha256.sig" ] || [ -f "${BUNDLE_DIR}/CHECKSUMS.sha256.asc" ]; then
    warn "bundle carries a signature file; verify it out-of-band per ${BUNDLE_DIR}/SIGNATURES.md before trusting this install"
  else
    warn "bundle is UNSIGNED (checksums only protect against corruption, not substitution). See SIGNATURES.md."
  fi
  ok "bundle integrity verified"
  SRC_DIR="${BUNDLE_DIR}/app"
  [ -f "${SRC_DIR}/package.json" ] || die "bundle has no app/package.json"
}

# ------------------------------------------------------------------------------------------------
# Node.js
# ------------------------------------------------------------------------------------------------
NODE_BIN=""
node_version_of() { "$1" --version 2>/dev/null | sed 's/^v//'; }
node_ok() { local v; v="$(node_version_of "$1")" && [ -n "${v}" ] && version_ge "${v}" "${YH_NODE_MIN}"; }
# A node under a home directory (nvm, volta, asdf) is invisible to the sandboxed service.
node_path_ok() {
  local real; real="$(cd -- "$(dirname -- "$1")" && pwd -P)"
  case "${real}" in /home/*|/root/*|/Users/*|/run/user/*) return 1;; esac
  return 0
}
system_node() {
  local sys; sys="$(command -v node 2>/dev/null || true)"
  if [ -n "${sys}" ] && node_ok "${sys}" && node_path_ok "${sys}"; then printf '%s' "${sys}"; fi
  if [ -n "${sys}" ] && node_ok "${sys}" && ! node_path_ok "${sys}"; then
    warn "ignoring ${sys}: it lives under a home directory, which the service cannot (and should not) read"
  fi
  return 0
}

distro_node_candidate() {
  # prints "<package> <version>" of the best distro candidate, or nothing
  local p v
  case "${PKG_MGR}" in
    apt-get)
      v="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"; v="${v#*:}"; v="${v%%[-+~]*}"
      [ -n "${v}" ] && [ "${v}" != "(none)" ] && echo "nodejs ${v}" ;;
    dnf|yum)
      for p in nodejs22 nodejs; do
        v="$("${PKG_MGR}" -q info "${p}" 2>/dev/null | awk -F': *' '/^Version/{print $2}' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
        if [ -n "${v}" ]; then echo "${p} ${v}"; return 0; fi
      done ;;
    zypper)
      for p in nodejs22 nodejs; do
        v="$(zypper --non-interactive info "${p}" 2>/dev/null | awk -F': *' '/^Version/{print $2}')"; v="${v%%-*}"
        if [ -n "${v}" ]; then echo "${p} ${v}"; return 0; fi
      done ;;
    apk)
      v="$(apk policy nodejs 2>/dev/null | sed -n '2p' | tr -d ' :')"; v="${v%%-r*}"
      [ -n "${v}" ] && echo "nodejs ${v}" ;;
    pacman)
      for p in nodejs-lts-jod nodejs; do
        v="$(pacman -Si "${p}" 2>/dev/null | awk -F': *' '/^Version/{print $2}')"; v="${v%%-*}"
        if [ -n "${v}" ]; then echo "${p} ${v}"; return 0; fi
      done ;;
  esac
  return 0
}

install_node_distro() {
  local cand pkg ver
  cand="$(distro_node_candidate)"
  [ -n "${cand}" ] || return 1
  pkg="${cand%% *}"; ver="${cand##* }"
  if ! version_ge "${ver}" "${YH_NODE_MIN}"; then
    log "distro candidate ${pkg} ${ver} is older than ${YH_NODE_MIN}"
    return 1
  fi
  log "installing distro package ${pkg} ${ver} (${PKG_MGR}; signed by the distribution, patched via OS updates)"
  pkg_install "${pkg}"
  if [ "${DRY_RUN}" = 1 ]; then NODE_BIN="/usr/bin/node"; return 0; fi
  local c
  for c in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/bin/node-22 /usr/bin/node22; do
    if [ -n "${c}" ] && [ -x "${c}" ] && node_ok "${c}"; then NODE_BIN="${c}"; return 0; fi
  done
  warn "distro package installed but no node >= ${YH_NODE_MIN} on PATH"
  return 1
}

node_dist_name() {
  # node_dist_name <version> -> official archive base name for this host
  local os ext
  if [ "${OS_KERNEL}" = Darwin ]; then os="darwin"; ext="tar.gz"; else os="linux"; ext="tar.xz"; fi
  if [ "${ext}" = tar.xz ] && ! command -v xz >/dev/null 2>&1; then ext="tar.gz"; fi
  printf 'node-v%s-%s-%s.%s' "$1" "${os}" "${ARCH_NODE}" "${ext}"
}

install_node_tarball() {
  local archive="" sums="" name
  make_tmp
  if [ "${LIBC}" = musl ] && [ -z "${BUNDLE_DIR}" ]; then
    die "official Node.js tarballs are glibc-only; on Alpine/musl use --node-source distro (apk add nodejs) or the Docker image"
  fi
  if [ -n "${BUNDLE_DIR}" ]; then
    archive="$(find "${BUNDLE_DIR}/runtime" -maxdepth 1 -name 'node-v*.tar.*' | head -n 1)"
    sums="${BUNDLE_DIR}/runtime/SHASUMS256.txt"
    if [ -z "${archive}" ] || [ ! -f "${sums}" ]; then die "bundle has no runtime/node-v*.tar.* + SHASUMS256.txt"; fi
    name="$(basename -- "${archive}")"
    NODE_VERSION="$(printf '%s' "${name}" | sed -E 's/^node-v([0-9.]+)-.*/\1/')"
    case "${name}" in *-"${ARCH_NODE}".tar.*|*-"${ARCH_NODE}"-musl.tar.*) ;; *) die "bundle runtime ${name} does not match this host arch (${ARCH_NODE})";; esac
    case "${LIBC}:${name}" in musl:*-musl.tar.*|glibc:*|darwin:*) ;; *) die "bundle runtime ${name} does not match this host's C library (${LIBC})";; esac
    case "${LIBC}:${name}" in glibc:*-musl.tar.*) die "bundle runtime ${name} is for musl; this host uses glibc";; esac
  else
    if [ -z "${NODE_VERSION}" ]; then
      log "resolving latest Node.js v22.x from ${NODE_MIRROR}"
      if [ "${DRY_RUN}" = 1 ] && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then NODE_VERSION="22.x"; else
        fetch "${NODE_MIRROR}/latest-v22.x/SHASUMS256.txt" "${YH_TMP_DIR}/latest.txt"
        NODE_VERSION="$(sed -nE 's/.*node-v(22\.[0-9]+\.[0-9]+)-linux-x64\.tar\.xz$/\1/p' "${YH_TMP_DIR}/latest.txt" | head -n 1)"
        [ -n "${NODE_VERSION}" ] || die "could not resolve the latest v22.x release from ${NODE_MIRROR}"
      fi
    fi
    version_ge "${NODE_VERSION}" "${YH_NODE_MIN}" || die "--node-version ${NODE_VERSION} is older than ${YH_NODE_MIN}"
    name="$(node_dist_name "${NODE_VERSION}")"
    archive="${YH_TMP_DIR}/${name}"; sums="${YH_TMP_DIR}/SHASUMS256.txt"
    log "downloading ${NODE_MIRROR}/v${NODE_VERSION}/${name}"
    run fetch "${NODE_MIRROR}/v${NODE_VERSION}/SHASUMS256.txt" "${sums}"
    run fetch "${NODE_MIRROR}/v${NODE_VERSION}/${name}" "${archive}"
  fi
  local dest="${RUNTIME_DIR}/node-v${NODE_VERSION}-${ARCH_NODE}"
  NODE_BIN="${RUNTIME_DIR}/node/bin/node"
  if [ "${DRY_RUN}" = 1 ]; then
    run verify_sha256 "${archive}" "${sums}"
    run tar -xf "${archive}" -C "${dest}" --strip-components=1
    run ln -sfn "${dest}" "${RUNTIME_DIR}/node"
    return 0
  fi
  verify_sha256 "${archive}" "${sums}"
  if [ -x "${dest}/bin/node" ] && [ "$(node_version_of "${dest}/bin/node")" = "${NODE_VERSION}" ]; then
    ok "Node.js ${NODE_VERSION} already present at ${dest}"
  else
    rm -rf -- "${dest}.partial"; mkdir -p "${dest}.partial"
    tar -xf "${archive}" -C "${dest}.partial" --strip-components=1
    rm -rf -- "${dest}"; mv -- "${dest}.partial" "${dest}"
    chown -R "root:${ROOT_GROUP}" "${dest}"; chmod -R go-w "${dest}"
  fi
  ln -sfn "${dest}" "${RUNTIME_DIR}/node"
  node_ok "${NODE_BIN}" || die "installed node at ${NODE_BIN} does not run or is too old"
  ok "Node.js $(node_version_of "${NODE_BIN}") installed at ${dest} (SHA-256 verified)"
}

verify_sha256() {
  local file=$1 sums=$2 name expected actual
  name="$(basename -- "${file}")"
  expected="$(awk -v n="${name}" '$2==n || $2=="*"n {print $1}' "${sums}" | head -n 1)"
  [ -n "${expected}" ] || die "${name} is not listed in $(basename -- "${sums}")"
  actual="$(sha256_of "${file}")"
  [ "${expected}" = "${actual}" ] || die "SHA-256 mismatch for ${name}: expected ${expected}, got ${actual} — aborting"
  ok "SHA-256 verified: ${name} (${actual})"
}

resolve_node() {
  if [ -n "${NODE_BIN_IN}" ]; then
    node_ok "${NODE_BIN_IN}" || die "--node-bin ${NODE_BIN_IN} is missing or older than ${YH_NODE_MIN}"
    NODE_BIN="${NODE_BIN_IN}"; NODE_SOURCE="explicit"; ok "using node ${NODE_BIN} ($(node_version_of "${NODE_BIN}"))"; return 0
  fi
  # An already-installed private runtime from a previous run satisfies everything.
  if [ "${NODE_SOURCE}" != system ] && [ -x "${RUNTIME_DIR}/node/bin/node" ] && node_ok "${RUNTIME_DIR}/node/bin/node" \
     && { [ -z "${NODE_VERSION}" ] || [ "$(node_version_of "${RUNTIME_DIR}/node/bin/node")" = "${NODE_VERSION}" ]; } && [ -z "${BUNDLE_DIR}" ]; then
    NODE_BIN="${RUNTIME_DIR}/node/bin/node"; NODE_SOURCE="tarball"; ok "using existing runtime ${NODE_BIN} ($(node_version_of "${NODE_BIN}"))"; return 0
  fi
  local sys; sys="$(system_node)"
  if [ -n "${BUNDLE_DIR}" ] && [ "${NODE_SOURCE}" = auto ]; then
    if [ -n "${sys}" ]; then NODE_BIN="${sys}"; NODE_SOURCE="system"; ok "using system node ${sys} ($(node_version_of "${sys}"))"; return 0; fi
    install_node_tarball; NODE_SOURCE="tarball"; return 0
  fi
  case "${NODE_SOURCE}" in
    system)
      if [ -z "${sys}" ]; then die "--node-source system: no usable node >= ${YH_NODE_MIN} on PATH"; fi
      NODE_BIN="${sys}" ;;
    distro)
      install_node_distro || die "no adequate distro Node.js package (need >= ${YH_NODE_MIN}); use --node-source tarball" ;;
    tarball)
      install_node_tarball ;;
    auto)
      if [ -n "${sys}" ]; then NODE_BIN="${sys}"; NODE_SOURCE="system"
      elif install_node_distro; then NODE_SOURCE="distro"
      else install_node_tarball; NODE_SOURCE="tarball"; fi ;;
  esac
  ok "Node.js: ${NODE_BIN} (source: ${NODE_SOURCE}${NODE_BIN:+, $(node_version_of "${NODE_BIN}" || echo planned)})"
}

# ------------------------------------------------------------------------------------------------
# Service account
# ------------------------------------------------------------------------------------------------
free_macos_id() {
  local id used
  used="$( { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}' | sort -n | uniq)"
  for id in $(seq 300 499); do
    if ! printf '%s\n' "${used}" | grep -qx "${id}"; then echo "${id}"; return 0; fi
  done
  die "no free system UID/GID in 300-499"
}
ensure_service_user() {
  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    ok "service account ${SERVICE_USER} exists (uid $(id -u "${SERVICE_USER}"))"
    SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
    return 0
  fi
  log "creating service account ${SERVICE_USER} (system, no login shell, no home)"
  if [ "${OS_KERNEL}" = Darwin ]; then
    local id; id="$(free_macos_id)"
    run dscl . -create "/Groups/${SERVICE_GROUP}"
    run dscl . -create "/Groups/${SERVICE_GROUP}" PrimaryGroupID "${id}"
    run dscl . -create "/Groups/${SERVICE_GROUP}" Password '*'
    run dscl . -create "/Users/${SERVICE_USER}"
    run dscl . -create "/Users/${SERVICE_USER}" UniqueID "${id}"
    run dscl . -create "/Users/${SERVICE_USER}" PrimaryGroupID "${id}"
    run dscl . -create "/Users/${SERVICE_USER}" UserShell "${NOLOGIN}"
    run dscl . -create "/Users/${SERVICE_USER}" NFSHomeDirectory /var/empty
    run dscl . -create "/Users/${SERVICE_USER}" RealName "YOU HEAL Clinical service"
    run dscl . -create "/Users/${SERVICE_USER}" Password '*'
    run dscl . -create "/Users/${SERVICE_USER}" IsHidden 1
  elif command -v useradd >/dev/null 2>&1; then
    if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then run groupadd --system "${SERVICE_GROUP}"; fi
    run useradd --system --gid "${SERVICE_GROUP}" --home-dir "${DATA_DIR}" --no-create-home \
      --shell "${NOLOGIN}" --comment "YOU HEAL Clinical service" "${SERVICE_USER}"
  elif command -v adduser >/dev/null 2>&1; then
    run addgroup -S "${SERVICE_GROUP}" 2>/dev/null || true
    run adduser -S -D -H -h "${DATA_DIR}" -s "${NOLOGIN}" -G "${SERVICE_GROUP}" -g "YOU HEAL Clinical service" "${SERVICE_USER}"
  else
    die "cannot create users: no useradd/adduser/dscl"
  fi
  if [ "${OS_KERNEL}" = Linux ] && [ "${DRY_RUN}" = 0 ] && command -v passwd >/dev/null 2>&1; then passwd -l "${SERVICE_USER}" >/dev/null 2>&1 || true; fi
  ok "service account ${SERVICE_USER} created"
}

# ------------------------------------------------------------------------------------------------
# Application release
# ------------------------------------------------------------------------------------------------
pkg_version() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1; }
APP_EXCLUDES=(--exclude=./data/sources --exclude=./data/db --exclude=./data/keys --exclude=./data/backups
  --exclude=./data/tls --exclude=./node_modules --exclude=./.git --exclude=./tests --exclude=./importer
  --exclude=./dist --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' --exclude=./.env)
tree_digest() {
  # Deterministic digest of the files that would be installed (content + relative path).
  (cd -- "$1" && find . \( -path ./data/sources -o -path ./data/db -o -path ./data/keys -o -path ./data/backups \
      -o -path ./data/tls -o -path ./node_modules -o -path ./.git -o -path ./tests -o -path ./importer -o -path ./dist \) -prune \
      -o -type f ! -name '*.sqlite*' ! -name .env ! -name .youheal-release -print | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s  %s\n' "$(sha256_of "${f}")" "${f}"; done) | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | awk '{print $1}'
}
APP_VERSION=""; RELEASE_DIR=""
install_release() {
  APP_VERSION="$(pkg_version "${SRC_DIR}")"; [ -n "${APP_VERSION}" ] || die "cannot read version from ${SRC_DIR}/package.json"
  local digest current_digest=""
  digest="$(tree_digest "${SRC_DIR}")"
  if [ -L "${PREFIX}/current" ] && [ -f "${PREFIX}/current/.youheal-release" ]; then
    current_digest="$(env_get "${PREFIX}/current/.youheal-release" TREE_SHA256)"
  fi
  if [ "${digest}" = "${current_digest}" ]; then
    RELEASE_DIR="$(cd -- "${PREFIX}/current" && pwd -P)"
    ok "release ${APP_VERSION} already installed and identical (${RELEASE_DIR})"
    return 0
  fi
  RELEASE_DIR="${PREFIX}/releases/${APP_VERSION}-$(date -u +%Y%m%dT%H%M%SZ)"
  log "installing release ${APP_VERSION} -> ${RELEASE_DIR} (tree sha256 ${digest:0:16}...)"
  run mkdir -p "${RELEASE_DIR}"
  if [ "${DRY_RUN}" = 1 ]; then
    run tar -C "${SRC_DIR}" -cf - "${APP_EXCLUDES[@]}" . \| tar -C "${RELEASE_DIR}" -xf -
  else
    tar -C "${SRC_DIR}" -cf - "${APP_EXCLUDES[@]}" . | tar -C "${RELEASE_DIR}" -xf -
    mkdir -p "${RELEASE_DIR}/data"
    printf 'VERSION=%s\nTREE_SHA256=%s\nSOURCE=%s\nINSTALLED_AT=%s\n' "${APP_VERSION}" "${digest}" "${SRC_DIR}" "$(_ts)" >"${RELEASE_DIR}/.youheal-release"
    chown -R "root:${ROOT_GROUP}" "${RELEASE_DIR}"
    chmod -R u=rwX,go=rX "${RELEASE_DIR}"
    chmod 0755 "${RELEASE_DIR}"/deploy/linux/*.sh 2>/dev/null || true
  fi
  switch_current "${RELEASE_DIR}"
}
switch_current() {
  local target=$1
  if [ "${DRY_RUN}" = 1 ]; then run ln -sfn "${target}" "${PREFIX}/current"; return 0; fi
  ln -sfn "${target}" "${PREFIX}/.current.tmp"
  if mv -T "${PREFIX}/.current.tmp" "${PREFIX}/current" 2>/dev/null; then :; else
    rm -f "${PREFIX}/.current.tmp"; rm -f "${PREFIX}/current"; ln -s "${target}" "${PREFIX}/current"; fi
  ok "${PREFIX}/current -> ${target}"
}
prune_releases() {
  [ -d "${PREFIX}/releases" ] || return 0
  local active="" n=0 d
  if [ -d "${PREFIX}/current" ]; then active="$(cd -- "${PREFIX}/current" && pwd -P)"; fi
  # newest first (directory names end in a UTC timestamp; sort on that suffix)
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    n=$((n + 1))
    if [ "${n}" -gt "$((KEEP_RELEASES + 1))" ] && [ "${d}" != "${active}" ]; then run rm -rf -- "${d}"; log "pruned old release ${d}"; fi
  done < <(find "${PREFIX}/releases" -mindepth 1 -maxdepth 1 -type d | awk -F- '{print $NF" "$0}' | sort -r | cut -d' ' -f2-)
}

# ------------------------------------------------------------------------------------------------
# Data dir, master key, TLS
# ------------------------------------------------------------------------------------------------
ensure_data_dir() {
  local d
  for d in "${DATA_DIR}" "${DATA_DIR}/db" "${DATA_DIR}/keys" "${DATA_DIR}/backups" "${TLS_DIR}"; do
    run mkdir -p "${d}"
    run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${d}"
    run chmod 0700 "${d}"
  done
  if [ "${INIT_SYSTEM}" != systemd ]; then
    run mkdir -p "${LOG_DIR}"; run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${LOG_DIR}"; run chmod 0750 "${LOG_DIR}"
  fi
  ok "data dir ${DATA_DIR} (0700 ${SERVICE_USER})"
}
key_valid() { [ -r "$1" ] && "${NODE_BIN}" -e '
  const s = require("node:fs").readFileSync(process.argv[1], "utf8").trim();
  process.exit(/^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, "base64").length === 32 ? 0 : 1);' "$1"; }
key_fpr() { "${NODE_BIN}" -e '
  const s = require("node:fs").readFileSync(process.argv[1], "utf8").trim();
  console.log(require("node:crypto").createHash("sha256").update(Buffer.from(s, "base64")).digest("hex").slice(0, 16));' "$1"; }
ensure_master_key() {
  if [ "${DRY_RUN}" = 1 ]; then
    if [ -n "${MASTER_KEY_IN}" ]; then run install -m 0600 "${MASTER_KEY_IN}" "${KEY_FILE}"
    elif [ -f "${KEY_FILE}" ]; then log "master key exists: ${KEY_FILE} (kept)"
    else run "generate 32 random bytes (base64) -> ${KEY_FILE} (0600 ${SERVICE_USER})"; fi
    return 0
  fi
  if [ -n "${MASTER_KEY_IN}" ]; then
    key_valid "${MASTER_KEY_IN}" || die "--master-key-file ${MASTER_KEY_IN} is not base64 of exactly 32 bytes"
    if [ -f "${KEY_FILE}" ] && ! cmp -s "${MASTER_KEY_IN}" "${KEY_FILE}"; then
      if [ "${FORCE_KEY}" != 1 ]; then die "a DIFFERENT master key already exists at ${KEY_FILE}; replacing it makes existing PHI unreadable. Use --force-key only if you are sure."; fi
      cp -p "${KEY_FILE}" "${KEY_FILE}.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
      warn "existing key preserved as ${KEY_FILE}.replaced-*  (destroy it deliberately once verified)"
    fi
    (umask 077; tr -d ' \r\n\t' <"${MASTER_KEY_IN}" >"${KEY_FILE}.tmp")
    mv -f "${KEY_FILE}.tmp" "${KEY_FILE}"
    log "imported master key from ${MASTER_KEY_IN}"
  elif [ -f "${KEY_FILE}" ]; then
    key_valid "${KEY_FILE}" || die "existing ${KEY_FILE} is not a valid key; refusing to continue (restore it from escrow)"
    ok "master key present (fingerprint $(key_fpr "${KEY_FILE}"))"
  else
    (umask 077; "${NODE_BIN}" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' >"${KEY_FILE}.tmp")
    mv -f "${KEY_FILE}.tmp" "${KEY_FILE}"
    KEY_GENERATED=1
    log "generated NEW master key ${KEY_FILE}"
  fi
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${KEY_FILE}"; chmod 0600 "${KEY_FILE}"
}
KEY_GENERATED=0

gather_sans() {
  local -a dns=() ips=() extra=()
  dns+=("${FQDN}")
  [ "${SHORT_HOST}" != "${FQDN}" ] && dns+=("${SHORT_HOST}")
  dns+=("localhost")
  ips+=("127.0.0.1" "::1")
  local ip
  if [ "${OS_KERNEL}" = Darwin ]; then
    for ip in $(ifconfig 2>/dev/null | awk '/inet6? /{print $2}'); do ips+=("${ip}"); done
  elif command -v ip >/dev/null 2>&1; then
    for ip in $(ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do ips+=("${ip}"); done
  elif hostname -I >/dev/null 2>&1; then
    for ip in $(hostname -I); do ips+=("${ip}"); done
  fi
  local out="" seen=" " n
  for n in "${dns[@]}"; do case "${seen}" in *" DNS:${n} "*) ;; *) out="${out:+${out},}DNS:${n}"; seen="${seen}DNS:${n} ";; esac; done
  for n in "${ips[@]}"; do
    case "${n}" in *%*|fe80:*|127.*) [ "${n}" = 127.0.0.1 ] || continue;; esac
    case "${seen}" in *" IP:${n} "*) ;; *) out="${out},IP:${n}"; seen="${seen}IP:${n} ";; esac
  done
  if [ -n "${EXTRA_SANS}" ]; then IFS=, read -r -a extra <<<"${EXTRA_SANS}"; for n in "${extra[@]}"; do out="${out},${n}"; done; fi
  printf '%s' "${out}"
}
TLS_SELF_SIGNED=1
ensure_openssl() {
  command -v openssl >/dev/null 2>&1 && return 0
  log "openssl not found; installing it"
  case "${PKG_MGR}" in pacman|apk|apt-get|dnf|yum|zypper) pkg_install openssl ;; *) die "openssl is required to generate the TLS certificate";; esac
}
generate_cert() {
  local crt="${TLS_DIR}/cert.pem" key="${TLS_DIR}/key.pem" sans cfg
  sans="$(gather_sans)"
  log "generating self-signed certificate (${CERT_ALGO}, ${CERT_DAYS} days) CN=${FQDN} SAN=${sans}"
  if [ "${DRY_RUN}" = 1 ]; then run openssl req -new -x509 -sha256 -days "${CERT_DAYS}" "(SAN ${sans})" -out "${crt}"; return 0; fi
  ensure_openssl
  make_tmp
  cfg="${YH_TMP_DIR}/openssl.cnf"
  local ku="digitalSignature"     # ECDSA signs only; keyEncipherment applies to RSA key transport
  if [ "${CERT_ALGO}" = rsa ]; then ku="digitalSignature, keyEncipherment"; fi
  cat >"${cfg}" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3
[dn]
CN = ${FQDN}
O = YOU HEAL Clinical (self-signed)
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, ${ku}
extendedKeyUsage = serverAuth
subjectAltName = ${sans}
subjectKeyIdentifier = hash
EOF
  (umask 077
   if [ "${CERT_ALGO}" = rsa ]; then openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${key}.tmp" 2>/dev/null
   else openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "${key}.tmp" 2>/dev/null; fi)
  openssl req -new -x509 -sha256 -days "${CERT_DAYS}" -key "${key}.tmp" -out "${crt}.tmp" -config "${cfg}"
  mv -f "${key}.tmp" "${key}"; mv -f "${crt}.tmp" "${crt}"
  ok "certificate ${crt}; $(openssl x509 -noout -fingerprint -sha256 -in "${crt}")"
}
ensure_tls() {
  local crt="${TLS_DIR}/cert.pem" key="${TLS_DIR}/key.pem"
  if [ -n "${TLS_CERT_IN}" ]; then
    if [ ! -r "${TLS_CERT_IN}" ] || [ ! -r "${TLS_KEY_IN}" ]; then die "cannot read --tls-cert/--tls-key"; fi
    ensure_openssl
    if [ "${DRY_RUN}" = 0 ]; then
      openssl x509 -noout -in "${TLS_CERT_IN}" || die "--tls-cert is not a PEM certificate"
      local a b
      a="$(openssl x509 -noout -pubkey -in "${TLS_CERT_IN}" | openssl pkey -pubin -outform DER 2>/dev/null | sha256_of /dev/stdin)"
      b="$(openssl pkey -in "${TLS_KEY_IN}" -pubout -outform DER 2>/dev/null | sha256_of /dev/stdin)"
      [ "${a}" = "${b}" ] || die "--tls-key does not match --tls-cert"
    fi
    run install -m 0644 "${TLS_CERT_IN}" "${crt}"
    run install -m 0600 "${TLS_KEY_IN}" "${key}"
    TLS_SELF_SIGNED=0
    ok "installed operator-supplied certificate"
  elif [ -s "${crt}" ] && [ -s "${key}" ] && [ "${REGEN_CERT}" = 0 ]; then
    if command -v openssl >/dev/null 2>&1; then
      if [ "$(openssl x509 -noout -subject -in "${crt}" 2>/dev/null | sed 's/^subject=//')" != "$(openssl x509 -noout -issuer -in "${crt}" 2>/dev/null | sed 's/^issuer=//')" ]; then TLS_SELF_SIGNED=0; fi
      openssl x509 -checkend 2592000 -noout -in "${crt}" >/dev/null 2>&1 || warn "${crt} expires within 30 days — re-run with --regen-cert or supply --tls-cert/--tls-key"
    fi
    ok "keeping existing certificate ${crt}"
  else
    generate_cert
  fi
  run chown "${SERVICE_USER}:${SERVICE_GROUP}" "${crt}" "${key}"
  run chmod 0644 "${crt}"; run chmod 0600 "${key}"
}

# ------------------------------------------------------------------------------------------------
# Config + service definition
# ------------------------------------------------------------------------------------------------
write_env_file() {
  local preserved=""
  if [ -f "${ENV_FILE}" ]; then
    preserved="$(sed -n '/^# --- local settings (preserved by install.sh) ---$/,$p' "${ENV_FILE}" | sed '1d')"
    if [ "${DRY_RUN}" = 0 ]; then cp -p "${ENV_FILE}" "${ENV_FILE}.bak"; fi
  fi
  run mkdir -p "${CONF_DIR}"; run chmod 0755 "${CONF_DIR}"
  write_file "${ENV_FILE}" 0640 "root:${SERVICE_GROUP}" <<EOF
# ${YH_PRODUCT} — service environment. Managed by deploy/linux/install.sh (${APP_VERSION}, $(_ts)).
# KEY=value only (no quotes, no spaces): read by systemd EnvironmentFile, OpenRC and the launchd renderer.
# The master key itself is NOT stored here; YH_MASTER_KEY_FILE points at it (0600, service user).
# Other server settings (YH_LOG_LEVEL, YH_SESSION_IDLE_MIN, YH_LOCKOUT_ATTEMPTS ...) go below the marker.
NODE_ENV=production
YH_HOST=${BIND_HOST}
YH_PORT=${PORT}
YH_DATA_DIR=${DATA_DIR}
YH_TLS_CERT=${TLS_DIR}/cert.pem
YH_TLS_KEY=${TLS_DIR}/key.pem
YH_TLS_SELF_SIGNED=${TLS_SELF_SIGNED}
YH_MASTER_KEY_FILE=${KEY_FILE}
YH_CATALOG_DIR=${PREFIX}/current/data/catalog
YH_TRUST_PROXY=${TRUST_PROXY}
${PUBLIC_ORIGIN:+YH_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}}
# --- local settings (preserved by install.sh) ---
${preserved}
EOF
  ok "wrote ${ENV_FILE}"
}
write_state() {
  write_file "${STATE_FILE}" 0644 "root:${ROOT_GROUP}" <<EOF
# ${YH_PRODUCT} install state (no secrets). Read by uninstall/backup/restore/upgrade.
PREFIX=${PREFIX}
DATA_DIR=${DATA_DIR}
CONF_DIR=${CONF_DIR}
LOG_DIR=${LOG_DIR}
SERVICE_USER=${SERVICE_USER}
SERVICE_GROUP=${SERVICE_GROUP}
NODE_BIN=${NODE_BIN}
NODE_SOURCE=${NODE_SOURCE}
INIT_SYSTEM=${INIT_SYSTEM}
HOST=${BIND_HOST}
PORT=${PORT}
FQDN=${FQDN}
FIREWALL=${FIREWALL_KIND}
FIREWALL_SOURCE=${FIREWALL_SOURCE}
VERSION=${APP_VERSION}
INSTALLED_AT=$(_ts)
EOF
}
render() {
  # render <template> : substitute @TOKENS@ (values were validated: no | or @)
  sed -e "s|@PREFIX@|${PREFIX}|g" -e "s|@DATA_DIR@|${DATA_DIR}|g" -e "s|@CONF_DIR@|${CONF_DIR}|g" \
      -e "s|@LOG_DIR@|${LOG_DIR}|g" -e "s|@USER@|${SERVICE_USER}|g" -e "s|@GROUP@|${SERVICE_GROUP}|g" \
      -e "s|@NODE_BIN@|${NODE_BIN}|g" -e "s|@LABEL@|${YH_LAUNCHD_LABEL}|g" "$1"
}
install_service() {
  [ "${DO_SERVICE}" = 1 ] || { log "skipping service definition (--no-service)"; return 0; }
  case "${INIT_SYSTEM}" in
    systemd)
      render "${SCRIPT_DIR}/youheal.service" | write_file "/etc/systemd/system/${YH_SERVICE_NAME}.service" 0644 "root:root"
      run systemctl daemon-reload
      if command -v systemd-analyze >/dev/null 2>&1 && [ "${DRY_RUN}" = 0 ]; then
        systemd-analyze verify "/etc/systemd/system/${YH_SERVICE_NAME}.service" 2>&1 | grep -v '^$' || true
      fi
      service_ctl enable ;;
    openrc)
      render "${SCRIPT_DIR}/youheal.openrc" | write_file "/etc/init.d/${YH_SERVICE_NAME}" 0755 "root:root"
      service_ctl enable ;;
    launchd)
      local dict="" k v
      while IFS='=' read -r k v; do
        [ -n "${k}" ] || continue
        dict="${dict}    <key>${k}</key>
    <string>${v}</string>
"
      done < <(env_args "${ENV_FILE}" 2>/dev/null || true)
      if [ "${DRY_RUN}" = 1 ] && [ -z "${dict}" ]; then dict="    <!-- from ${ENV_FILE} -->"; fi
      local plist="/Library/LaunchDaemons/${YH_LAUNCHD_LABEL}.plist"
      render "${SCRIPT_DIR}/com.youheal.clinical.plist" | awk -v d="${dict}" '{ if ($0 == "@ENV_DICT@") printf "%s", d; else print }' \
        | write_file "${plist}" 0644 "root:wheel"
      if [ "${DRY_RUN}" = 0 ]; then plutil -lint "${plist}" >/dev/null || die "generated plist is invalid"; fi ;;
    none)
      warn "no init system: start manually as ${SERVICE_USER}: (set -a; . ${ENV_FILE}; cd ${PREFIX}/current && ${NODE_BIN} --disable-warning=ExperimentalWarning server/index.js)" ;;
  esac
  ok "service definition installed (${INIT_SYSTEM})"
}

# ------------------------------------------------------------------------------------------------
# Firewall
# ------------------------------------------------------------------------------------------------
FIREWALL_KIND="none"
open_firewall() {
  [ "${OPEN_FIREWALL}" = 1 ] || { FIREWALL_KIND="$( [ -f "${STATE_FILE}" ] && env_get "${STATE_FILE}" FIREWALL none || echo none)"; return 0; }
  if [ "${OS_KERNEL}" = Darwin ]; then
    local fw=/usr/libexec/ApplicationFirewall/socketfilterfw
    if [ -x "${fw}" ]; then run "${fw}" --add "${NODE_BIN}"; run "${fw}" --unblockapp "${NODE_BIN}"; FIREWALL_KIND="socketfilterfw"
      warn "macOS application firewall allows node by binary, not by port; restrict sources with pf if required"; fi
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    if [ -n "${FIREWALL_SOURCE}" ]; then run ufw allow proto tcp from "${FIREWALL_SOURCE}" to any port "${PORT}" comment 'youheal'
    else run ufw allow "${PORT}/tcp" comment 'youheal'; fi
    FIREWALL_KIND="ufw"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if [ -n "${FIREWALL_SOURCE}" ]; then
      local fam=ipv4; case "${FIREWALL_SOURCE}" in *:*) fam=ipv6;; esac
      run firewall-cmd --permanent --add-rich-rule="rule family=${fam} source address=${FIREWALL_SOURCE} port port=${PORT} protocol=tcp accept"
    else run firewall-cmd --permanent --add-port="${PORT}/tcp"; fi
    run firewall-cmd --reload
    FIREWALL_KIND="firewalld"
  else
    warn "--open-firewall: no active ufw/firewalld found; add an nftables/iptables rule for tcp/${PORT} manually"
    return 0
  fi
  ok "firewall (${FIREWALL_KIND}) allows tcp/${PORT}${FIREWALL_SOURCE:+ from ${FIREWALL_SOURCE}}"
}

# ------------------------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------------------------
prepare_bundle
resolve_node
ensure_service_user
install_release
ensure_data_dir
ensure_master_key
ensure_tls
write_env_file
open_firewall
install_service
write_state

APP_DIR="${PREFIX}/current"
WAS_ACTIVE=0
if service_ctl is-active; then WAS_ACTIVE=1; fi
if [ "${WAS_ACTIVE}" = 1 ] && { [ "${DO_MIGRATE}" = 1 ] || [ "${DO_START}" = 1 ]; }; then
  log "stopping running service for migration/restart"
  service_ctl stop
fi
if [ "${DO_MIGRATE}" = 1 ]; then
  log "running database migrations"
  node_script "${NODE_BIN}" "${SERVICE_USER}" "${ENV_FILE}" "${APP_DIR}" migrate
  ok "migrations applied"
fi
if [ "${DO_CATALOG}" = 1 ]; then
  if [ -f "${APP_DIR}/data/catalog/points.json" ] || [ -f "${APP_DIR}/data/catalog/manifest.json" ] || [ "${DRY_RUN}" = 1 ]; then
    log "loading catalog"
    node_script "${NODE_BIN}" "${SERVICE_USER}" "${ENV_FILE}" "${APP_DIR}" catalog:load
    ok "catalog loaded"
  else
    warn "no catalog JSON (points.json/manifest.json) in ${APP_DIR}/data/catalog — skipped catalog load"
  fi
fi
prune_releases

HEALTH="not checked"
if [ "${DO_START}" = 1 ] && [ "${INIT_SYSTEM}" != none ]; then
  service_ctl start
  YH_HEALTH_PROBE="${APP_DIR}/deploy/common/healthcheck.mjs"; export YH_HEALTH_PROBE
  if health_check "${NODE_BIN}" "${ENV_FILE}" "${HEALTH_RETRIES}"; then HEALTH="healthy"; else
    HEALTH="UNHEALTHY"
    err "service did not become healthy; recent logs:"
    case "${INIT_SYSTEM}" in
      systemd) journalctl -u "${YH_SERVICE_NAME}" -n 50 --no-pager 2>/dev/null || true ;;
      *) tail -n 50 "${LOG_DIR}/youheal.log" 2>/dev/null || true ;;
    esac
    exit 1
  fi
fi

FPR=""
if [ "${DRY_RUN}" = 0 ] && command -v openssl >/dev/null 2>&1 && [ -r "${TLS_DIR}/cert.pem" ]; then
  FPR="$(openssl x509 -noout -fingerprint -sha256 -in "${TLS_DIR}/cert.pem" | sed 's/^.*=//')"
fi
cat >&2 <<EOF

============================================================================================
 ${YH_PRODUCT} ${APP_VERSION} $( [ "${DRY_RUN}" = 1 ] && echo "— DRY RUN, nothing was changed" || echo "installed   (health: ${HEALTH})" )
--------------------------------------------------------------------------------------------
 First-run setup (creates the clinic + first admin; accepted from LOOPBACK ONLY):
   on this host:            https://localhost:${PORT}/#/setup
   from your workstation:   ssh -L ${PORT}:127.0.0.1:${PORT} <admin>@${FQDN}
                            then browse https://localhost:${PORT}/#/setup
   or on this host (CLI):   sudo -u ${SERVICE_USER} sh -c 'set -a; . ${ENV_FILE}; cd ${APP_DIR}; ${NODE_BIN} --run create-admin'
 After setup, users sign in at: https://${FQDN}:${PORT}/
 TLS certificate SHA-256 fingerprint (compare in the browser before trusting it):
   ${FPR:-<see ${TLS_DIR}/cert.pem>}
 Master key: ${KEY_FILE}$( [ "${KEY_GENERATED}" = 1 ] && printf '\n   NEW KEY — escrow it OFFLINE now (two sealed copies). Without it, PHI and backups are unrecoverable.' )
 Config: ${ENV_FILE}     Logs: $( [ "${INIT_SYSTEM}" = systemd ] && echo "journalctl -u ${YH_SERVICE_NAME}" || echo "${LOG_DIR}/youheal.log" )
 Backups: ${APP_DIR}/deploy/linux/backup.sh --install-cron     Runbook: ${APP_DIR}/docs/OPERATIONS.md
 Installer log: ${LOG_FILE}
============================================================================================
EOF
