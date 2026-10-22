# shellcheck shell=bash
# shellcheck disable=SC2034  # variables defined here are consumed by the scripts that source this file
# YOU HEAL Clinical — shared helpers for deploy/linux/*.sh (Linux + macOS, bash >= 3.2).
#
# Sourced, never executed. Callers must already have `set -Eeuo pipefail`.
# Provides: logging (console + file), ERR/EXIT traps, dry-run aware execution, privilege elevation
# (sudo/doas re-exec), OS/arch/init/package-manager detection, env-file parsing, run-as-service-user,
# health checks, and service control across systemd / OpenRC / launchd.

# ----------------------------------------------------------------------------------------------
# Defaults (every one is overridable by a CLI flag in the calling script)
# ----------------------------------------------------------------------------------------------
YH_PRODUCT="YOU HEAL Clinical"
YH_SERVICE_NAME="${YH_SERVICE_NAME:-youheal}"
YH_LAUNCHD_LABEL="${YH_LAUNCHD_LABEL:-com.youheal.clinical}"
YH_NODE_MIN="22.13.0"
DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
VERBOSE="${VERBOSE:-0}"
LOG_FILE="${LOG_FILE:-}"
YH_TMP_DIR=""

# ----------------------------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------------------------
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# All output (ours and that of every child command) goes to the console AND the log file once
# init_logging has run (stdout/stderr are tee'd), so these helpers only print.
log()   { printf '%s INFO  %s\n' "$(_ts)" "$*" >&2; }
ok()    { printf '%s OK    %s\n' "$(_ts)" "$*" >&2; }
warn()  { printf '%s WARN  %s\n' "$(_ts)" "$*" >&2; }
err()   { printf '%s ERROR %s\n' "$(_ts)" "$*" >&2; }
debug() { if [ "${VERBOSE}" = 1 ]; then printf '%s DEBUG %s\n' "$(_ts)" "$*" >&2; fi; }
die()   { err "$*"; exit 1; }

# init_logging <default-path>: pick a writable log file (falls back to $TMPDIR), make it 0600, and
# tee stdout+stderr into it for the rest of the run.
init_logging() {
  local wanted="${LOG_FILE:-$1}"
  if ! { mkdir -p -- "$(dirname -- "${wanted}")" 2>/dev/null && touch -- "${wanted}" 2>/dev/null; }; then
    wanted="${TMPDIR:-/tmp}/$(basename -- "${wanted}")"
    touch -- "${wanted}"
  fi
  chmod 0600 -- "${wanted}" 2>/dev/null || true
  LOG_FILE="${wanted}"
  printf '%s ----- %s (pid %s, uid %s) args: %s -----\n' "$(_ts)" "$(basename -- "$0")" "$$" "$(id -u)" "${YH_ORIG_ARGS_STR:-}" >>"${LOG_FILE}"
  exec > >(tee -a -- "${LOG_FILE}") 2>&1
}

# ----------------------------------------------------------------------------------------------
# Traps
# ----------------------------------------------------------------------------------------------
_on_err() {
  local rc=$1 line=$2 cmd=$3
  err "command failed (exit ${rc}) at line ${line}: ${cmd}"
  if [ -n "${LOG_FILE}" ]; then err "full log: ${LOG_FILE}"; fi
}
_on_exit() {
  local rc=$?
  # hook first (rollback may need files in the temp dir), then clean up
  if declare -F on_exit_hook >/dev/null 2>&1; then on_exit_hook "${rc}" || true; fi
  if [ -n "${YH_TMP_DIR}" ] && [ -d "${YH_TMP_DIR}" ]; then rm -rf -- "${YH_TMP_DIR}"; fi
  if [ -n "${LOG_FILE}" ]; then printf '%s ----- exit %s -----\n' "$(_ts)" "${rc}" >&2; fi
  exit "${rc}"
}
install_traps() {
  trap '_on_err $? $LINENO "$BASH_COMMAND"' ERR
  trap _on_exit EXIT
  trap 'err "interrupted"; exit 130' INT
  trap 'err "terminated"; exit 143' TERM
}
make_tmp() {
  if [ -z "${YH_TMP_DIR}" ]; then
    YH_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/youheal.XXXXXXXX")"
    chmod 0700 "${YH_TMP_DIR}"
  fi
}

# ----------------------------------------------------------------------------------------------
# Dry-run aware execution
# ----------------------------------------------------------------------------------------------
# run <cmd...>: execute (logging the command) or, in dry-run, only print it.
run() {
  if [ "${DRY_RUN}" = 1 ]; then
    printf '%s DRY   %s\n' "$(_ts)" "$*" >&2
    return 0
  fi
  debug "exec: $*"
  "$@"
}
# write_file <path> <mode> <owner:group|-> : content from stdin; atomic replace; dry-run prints it.
write_file() {
  local path=$1 mode=$2 owner=$3 tmp
  if [ "${DRY_RUN}" = 1 ]; then
    printf '%s DRY   write %s (mode %s, owner %s):\n' "$(_ts)" "${path}" "${mode}" "${owner}" >&2
    sed 's/^/        | /' >&2
    return 0
  fi
  mkdir -p -- "$(dirname -- "${path}")"
  tmp="$(mktemp "$(dirname -- "${path}")/.$(basename -- "${path}").XXXXXX")"
  cat >"${tmp}"
  chmod "${mode}" "${tmp}"
  if [ "${owner}" != "-" ]; then chown "${owner}" "${tmp}"; fi
  mv -f -- "${tmp}" "${path}"
  debug "wrote ${path} (${mode} ${owner})"
}
confirm() {
  # confirm "<question>" : returns 0 if yes. --yes auto-confirms. Non-interactive without --yes => no.
  local q=$1 ans
  if [ "${ASSUME_YES}" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then warn "non-interactive and --yes not given: treating '${q}' as NO"; return 1; fi
  printf '%s [y/N] ' "${q}" >&2
  read -r ans || return 1
  case "${ans}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ----------------------------------------------------------------------------------------------
# Privilege elevation: re-exec this script as root via sudo or doas (args preserved).
# Usage (in caller, BEFORE parsing args mutates "$@"):  require_root "$@"
# ----------------------------------------------------------------------------------------------
require_root() {
  if [ "$(id -u)" -eq 0 ]; then return 0; fi
  if [ "${DRY_RUN}" = 1 ]; then
    warn "not running as root; continuing because --dry-run makes no changes (detection may be incomplete)"
    return 0
  fi
  local self
  self="$(cd -- "$(dirname -- "${BASH_SOURCE[${#BASH_SOURCE[@]}-1]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[${#BASH_SOURCE[@]}-1]}")"
  local reason="${YH_ELEVATION_REASON:-install/manage the ${YH_PRODUCT} system service}"
  if command -v sudo >/dev/null 2>&1; then
    log "Administrator rights are required to ${reason}."
    log "Re-running with sudo; you may be prompted for YOUR password (not root's)."
    exec sudo -p "[youheal] sudo password for %u: " -- env "YH_ELEVATED=1" bash "${self}" "$@"
  elif command -v doas >/dev/null 2>&1; then
    log "Administrator rights are required to ${reason}. Re-running with doas."
    exec doas -- env "YH_ELEVATED=1" bash "${self}" "$@"
  else
    die "this script must run as root and neither sudo nor doas is available. Re-run as root: su -c 'bash ${self} $*'"
  fi
}

# ----------------------------------------------------------------------------------------------
# Platform detection
# ----------------------------------------------------------------------------------------------
OS_KERNEL=""; OS_ID=""; OS_LIKE=""; OS_VERSION=""; OS_PRETTY=""; ARCH_NODE=""; INIT_SYSTEM=""; PKG_MGR=""; LIBC="glibc"
detect_platform() {
  OS_KERNEL="$(uname -s)"
  case "${OS_KERNEL}" in
    Linux)
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        OS_ID="$(. /etc/os-release && printf '%s' "${ID:-linux}")"
        OS_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
        OS_VERSION="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
        OS_PRETTY="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-Linux}")"
      else
        OS_ID="linux"; OS_PRETTY="Linux"
      fi
      if ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then LIBC="musl"; fi
      ;;
    Darwin)
      OS_ID="macos"; OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"; OS_PRETTY="macOS ${OS_VERSION}"; LIBC="darwin"
      ;;
    *) die "unsupported OS kernel: ${OS_KERNEL} (supported: Linux, macOS; Windows: deploy/windows/Install-YouHeal.ps1)";;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH_NODE="x64" ;;
    aarch64|arm64) ARCH_NODE="arm64" ;;
    armv7l|armv7*) ARCH_NODE="armv7l" ;;
    ppc64le) ARCH_NODE="ppc64le" ;;
    s390x) ARCH_NODE="s390x" ;;
    *) die "unsupported CPU architecture: $(uname -m)";;
  esac
  if [ "${OS_KERNEL}" = Darwin ]; then
    INIT_SYSTEM="launchd"
  elif [ -d /run/systemd/system ]; then
    INIT_SYSTEM="systemd"
  elif { command -v openrc-run >/dev/null 2>&1 || [ -x /sbin/openrc-run ]; } && command -v rc-service >/dev/null 2>&1; then
    INIT_SYSTEM="openrc"
  else
    INIT_SYSTEM="none"
  fi
  for pm in apt-get dnf yum zypper apk pacman; do
    if command -v "${pm}" >/dev/null 2>&1; then PKG_MGR="${pm}"; break; fi
  done
  if [ "${OS_KERNEL}" = Darwin ]; then PKG_MGR="none"; fi
  [ -n "${PKG_MGR}" ] || PKG_MGR="none"
  debug "platform: ${OS_PRETTY} kernel=${OS_KERNEL} id=${OS_ID} like=${OS_LIKE} arch=${ARCH_NODE} libc=${LIBC} init=${INIT_SYSTEM} pkg=${PKG_MGR}"
}

pkg_install() {
  # pkg_install <pkg...> : install distro packages with the detected package manager.
  [ "$#" -gt 0 ] || return 0
  case "${PKG_MGR}" in
    apt-get) run env DEBIAN_FRONTEND=noninteractive apt-get update -qq; run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf)     run dnf install -y -q "$@" ;;
    yum)     run yum install -y -q "$@" ;;
    zypper)  run zypper --non-interactive install --no-recommends "$@" ;;
    apk)     run apk add --no-cache "$@" ;;
    pacman)  run pacman -S --noconfirm --needed "$@" ;;
    *) die "no supported package manager to install: $* (install it manually and re-run)";;
  esac
}

# version_ge A B : true if dotted version A >= B
version_ge() {
  local a b i
  IFS=. read -r -a a <<<"${1#v}"; IFS=. read -r -a b <<<"${2#v}"
  for i in 0 1 2; do
    local x=${a[$i]:-0} y=${b[$i]:-0}
    x=${x%%[!0-9]*}; y=${y%%[!0-9]*}; x=${x:-0}; y=${y:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r -- "$1" | awk '{print $1}'
  else die "no SHA-256 tool (sha256sum, shasum or openssl) available"; fi
}

# fetch <url> <dest> : HTTPS download with TLS verification (curl or wget). Never disables verification.
fetch() {
  local url=$1 dest=$2
  case "${url}" in https://*) ;; *) die "refusing non-HTTPS download: ${url}";; esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "${dest}" -- "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "${dest}" -- "${url}"
  else
    die "neither curl nor wget is available to download ${url}"
  fi
}

# ----------------------------------------------------------------------------------------------
# Env file (KEY=value, no quoting, no spaces) — the same file feeds systemd, OpenRC and launchd.
# ----------------------------------------------------------------------------------------------
# env_get <file> <KEY> [default]
env_get() {
  local file=$1 key=$2 def=${3:-} line
  if [ -r "${file}" ]; then
    line="$(grep -E "^${key}=" "${file}" | tail -n 1 || true)"
    if [ -n "${line}" ]; then printf '%s' "${line#*=}"; return 0; fi
  fi
  printf '%s' "${def}"
}
# env_args <file> : prints KEY=value lines suitable for `env` (comments/blank lines dropped).
# Allow-list: only YH_* and NODE_ENV are ever exported to processes the scripts start (some as root),
# so an edited env file cannot inject NODE_OPTIONS, LD_PRELOAD, PATH, etc.
env_args() { grep -E '^(YH_[A-Z0-9_]+|NODE_ENV)=' "$1" || true; }

# validate_value <name> <value> : env/plist safe (no whitespace, quotes, $, `, \, <, >, &).
validate_value() {
  case "$2" in
    *[[:space:]]*|*\"*|*\'*|*\$*|*\`*|*\\*|*\<*|*\>*|*\&*) die "invalid value for $1: '$2' (whitespace, quotes and shell/XML metacharacters are not allowed)";;
  esac
}

# ----------------------------------------------------------------------------------------------
# Run a command as the service user (runuser > setpriv > sudo > su), with the env file applied.
# ----------------------------------------------------------------------------------------------
# run_as <user> <envfile|-> <workdir> <cmd...>
run_as() {
  local user=$1 envfile=$2 wd=$3; shift 3
  local -a envs=()
  if [ "${envfile}" != "-" ] && [ -r "${envfile}" ]; then
    while IFS= read -r l; do envs+=("${l}"); done < <(env_args "${envfile}")
  fi
  envs+=("HOME=${wd}" "NODE_ENV=production")
  if [ "${DRY_RUN}" = 1 ]; then
    printf '%s DRY   (as %s in %s) %s\n' "$(_ts)" "${user}" "${wd}" "$*" >&2; return 0
  fi
  debug "as ${user} in ${wd}: $*"
  if [ "$(id -un)" = "${user}" ]; then
    (cd -- "${wd}" && env "${envs[@]}" "$@")
  elif command -v runuser >/dev/null 2>&1; then
    (cd -- "${wd}" && runuser -u "${user}" -- env "${envs[@]}" "$@")
  elif command -v setpriv >/dev/null 2>&1 && [ "${OS_KERNEL}" = Linux ]; then
    local uid gid
    uid="$(id -u "${user}")"; gid="$(id -g "${user}")"
    (cd -- "${wd}" && setpriv --reuid="${uid}" --regid="${gid}" --init-groups -- env "${envs[@]}" "$@")
  elif command -v sudo >/dev/null 2>&1; then
    (cd -- "${wd}" && sudo -n -u "${user}" -- env "${envs[@]}" "$@")
  else
    local q; q="$(printf '%q ' env "${envs[@]}" "$@")"
    (cd -- "${wd}" && su -s /bin/sh "${user}" -c "${q}")
  fi
}

# ----------------------------------------------------------------------------------------------
# Safe handling of the SERVICE-OWNED data directory (finding F-03).
# The service account can create entries in <data>; anything root does there could be redirected by a
# planted symlink. Rules: root never writes, chmods or chowns *inside* <data>; it refuses symlinks and
# delegates all writes to the service account (which can only damage what it already owns).
# Root only touches <data> itself (parent is root-owned) with `chown -h`.
# ----------------------------------------------------------------------------------------------
# assert_no_symlink <path...> : die if any existing path is a symlink
assert_no_symlink() {
  local p
  for p in "$@"; do
    if [ -L "${p}" ]; then die "refusing to operate on symlink ${p} (possible symlink attack; investigate before continuing)"; fi
  done
}
# assert_tree_no_symlinks <dir> : die if <dir> contains any symlink (checked before root operations on it)
assert_tree_no_symlinks() {
  [ -d "$1" ] || return 0
  assert_no_symlink "$1"
  local found
  found="$(find "$1" -type l -print 2>/dev/null | head -n 5 || true)"
  if [ -n "${found}" ]; then die "refusing to continue: symlinks found inside $1: ${found//$'\n'/ }"; fi
}
# svc_exec <user> <cmd...> : run a command as the service account (no env file), cwd /
svc_exec() { local u=$1; shift; run_as "${u}" - / "$@"; }
# svc_mkdir <user> <dir> [mode] : create (as the service account) a 0700 dir inside the data dir
svc_mkdir() {
  local u=$1 d=$2 m=${3:-0700}
  assert_no_symlink "${d}"
  svc_exec "${u}" mkdir -p -- "${d}"
  svc_exec "${u}" chmod "${m}" -- "${d}"
}
# svc_write <user> <path> [mode] : stdin -> <path>, written by the service account (temp + rename)
svc_write() {
  local u=$1 path=$2 m=${3:-0600}
  assert_no_symlink "${path}"
  if [ "${DRY_RUN}" = 1 ]; then printf '%s DRY   (as %s) write %s mode %s\n' "$(_ts)" "${u}" "${path}" "${m}" >&2; cat >/dev/null; return 0; fi
  # shellcheck disable=SC2016  # expanded by the inner shell, which runs as the service account
  run_as "${u}" - / sh -c 'umask 077; t="$1.tmp.$$"; cat > "$t" && chmod "$2" "$t" && mv -f "$t" "$1"' _ "${path}" "${m}"
}
# root_dir <path> <owner:group> <mode> : create/fix a directory whose PARENT is root-owned
# (e.g. <data> itself, /var/log/youheal). Never follows symlinks.
root_dir() {
  local d=$1 o=$2 m=$3
  assert_no_symlink "${d}"
  run mkdir -p -- "${d}"
  assert_no_symlink "${d}"
  run chown -h "${o}" "${d}"
  run chmod "${m}" "${d}"
}

# node_script <node-bin> <user> <envfile> <appdir> <script-name> [args...] : runs a package.json script
# with `node --run` (no npm needed; distro Node packages often ship without npm).
node_script() {
  local node=$1 user=$2 envfile=$3 app=$4 name=$5; shift 5
  local help; help="$("${node}" --help 2>/dev/null || true)"
  if case "${help}" in *--run*) true;; *) false;; esac; then
    if [ "$#" -gt 0 ]; then
      run_as "${user}" "${envfile}" "${app}" env "PATH=$(dirname -- "${node}"):/usr/bin:/bin" "${node}" --run "${name}" -- "$@"
    else
      run_as "${user}" "${envfile}" "${app}" env "PATH=$(dirname -- "${node}"):/usr/bin:/bin" "${node}" --run "${name}"
    fi
  else
    local npm; npm="$(dirname -- "${node}")/npm"
    [ -x "${npm}" ] || npm="$(command -v npm || true)"
    [ -n "${npm}" ] || die "cannot run package script '${name}': node lacks --run and npm is missing"
    run_as "${user}" "${envfile}" "${app}" env "PATH=$(dirname -- "${node}"):/usr/bin:/bin" "${npm}" run --silent "${name}" -- "$@"
  fi
}

# ----------------------------------------------------------------------------------------------
# Service control (systemd / OpenRC / launchd)
# ----------------------------------------------------------------------------------------------
service_ctl() {
  # service_ctl <start|stop|restart|enable|disable|status|is-active>
  local action=$1
  case "${INIT_SYSTEM}" in
    systemd)
      case "${action}" in
        is-active) systemctl is-active --quiet "${YH_SERVICE_NAME}" ;;
        status) systemctl --no-pager status "${YH_SERVICE_NAME}" || true ;;
        enable) run systemctl enable "${YH_SERVICE_NAME}" ;;
        disable) run systemctl disable "${YH_SERVICE_NAME}" || true ;;
        *) run systemctl "${action}" "${YH_SERVICE_NAME}" ;;
      esac ;;
    openrc)
      case "${action}" in
        is-active) rc-service "${YH_SERVICE_NAME}" status >/dev/null 2>&1 ;;
        status) rc-service "${YH_SERVICE_NAME}" status || true ;;
        enable) run rc-update add "${YH_SERVICE_NAME}" default ;;
        disable) run rc-update del "${YH_SERVICE_NAME}" default || true ;;
        *) run rc-service "${YH_SERVICE_NAME}" "${action}" ;;
      esac ;;
    launchd)
      local plist="/Library/LaunchDaemons/${YH_LAUNCHD_LABEL}.plist"
      case "${action}" in
        is-active) launchctl print "system/${YH_LAUNCHD_LABEL}" 2>/dev/null | grep -q 'state = running' ;;
        status) launchctl print "system/${YH_LAUNCHD_LABEL}" 2>/dev/null | sed -n '1,25p' || true ;;
        enable) run launchctl enable "system/${YH_LAUNCHD_LABEL}" ;;
        disable) run launchctl disable "system/${YH_LAUNCHD_LABEL}" || true ;;
        start)
          if launchctl print "system/${YH_LAUNCHD_LABEL}" >/dev/null 2>&1; then run launchctl kickstart "system/${YH_LAUNCHD_LABEL}"
          else run launchctl bootstrap system "${plist}"; fi ;;
        stop) run launchctl bootout "system/${YH_LAUNCHD_LABEL}" 2>/dev/null || true ;;
        restart)
          if launchctl print "system/${YH_LAUNCHD_LABEL}" >/dev/null 2>&1; then run launchctl kickstart -k "system/${YH_LAUNCHD_LABEL}"
          else run launchctl bootstrap system "${plist}"; fi ;;
      esac ;;
    none)
      case "${action}" in
        is-active) return 1 ;;
        *) warn "no supported init system detected; '${action}' must be done manually" ;;
      esac ;;
  esac
}

# health_check <node-bin> <envfile> [retries] : runs deploy/common/healthcheck.mjs with the env file.
health_check() {
  local node=$1 envfile=$2 retries=${3:-30} probe ca
  probe="${YH_HEALTH_PROBE:-}"
  [ -n "${probe}" ] || die "YH_HEALTH_PROBE not set (path to deploy/common/healthcheck.mjs)"
  if [ "${DRY_RUN}" = 1 ]; then run "${node}" "${probe}" --retries "${retries}"; return 0; fi
  local -a envs=()
  while IFS= read -r l; do envs+=("${l}"); done < <(env_args "${envfile}")
  ca="$(env_get "${envfile}" YH_TLS_CERT)"
  if [ -n "${ca}" ] && [ -r "${ca}" ] && [ ! -L "${ca}" ] && [ "$(env_get "${envfile}" YH_TLS_SELF_SIGNED 0)" = 1 ]; then
    env "${envs[@]}" "${node}" "${probe}" --ca "${ca}" --retries "${retries}" --interval 2000
  else
    env "${envs[@]}" "${node}" "${probe}" --retries "${retries}" --interval 2000
  fi
}

# load_install_state <conf-dir> : reads ${conf}/install.state written by install.sh
# (PREFIX, DATA_DIR, SERVICE_USER, NODE_BIN, INIT_SYSTEM, PORT ...) into STATE_* variables.
load_install_state() {
  local f="$1/install.state"
  [ -r "${f}" ] || die "install state ${f} not found — is ${YH_PRODUCT} installed? (use --conf-dir to point at it)"
  STATE_PREFIX="$(env_get "${f}" PREFIX)"
  STATE_DATA_DIR="$(env_get "${f}" DATA_DIR)"
  STATE_SERVICE_USER="$(env_get "${f}" SERVICE_USER youheal)"
  STATE_NODE_BIN="$(env_get "${f}" NODE_BIN)"
  STATE_INIT_SYSTEM="$(env_get "${f}" INIT_SYSTEM)"
  STATE_LOG_DIR="$(env_get "${f}" LOG_DIR)"
  STATE_PORT="$(env_get "${f}" PORT 8443)"
  STATE_FIREWALL="$(env_get "${f}" FIREWALL none)"
  export STATE_PREFIX STATE_DATA_DIR STATE_SERVICE_USER STATE_NODE_BIN STATE_INIT_SYSTEM STATE_LOG_DIR STATE_PORT STATE_FIREWALL
}
