#!/usr/bin/env bash
# YOU HEAL Clinical — build an air-gapped install bundle (on a connected build machine).
#
# Output: <out-dir>/youheal-<version>-<os>-<arch>.tar.gz   (linux, darwin)
#         <out-dir>/youheal-<version>-win-<arch>.zip        (win)
#         + <archive>.sha256
#
# Layout inside the archive:
#   youheal-<version>-<os>-<arch>/
#     BUNDLE.json            manifest (version, target, Node runtime + hash, source tree hash, build info)
#     CHECKSUMS.sha256       SHA-256 of every file in the bundle (verified by the installers)
#     SIGNATURES.md          how to sign/verify CHECKSUMS.sha256 (placeholder: no signature is produced)
#     README-OFFLINE.txt     install instructions
#     app/                   the application (no PHI, keys, licensed PDFs, tests or importer)
#     runtime/               official Node.js archive/MSI for the target + SHASUMS256.txt (+ .asc if available)
#     winsw/                 (win only) WinSW.NET461.exe, hash-pinned
#
# Runs UNPRIVILEGED on purpose (least privilege: building needs no root). It never elevates and warns if
# started as root. Install the bundle with deploy/linux/install.sh --offline-bundle <archive> or
# deploy/windows/Install-YouHeal.ps1 -OfflineBundle <zip>.

set -Eeuo pipefail
umask 022
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=../linux/lib/common.sh
. "${SCRIPT_DIR}/../linux/lib/common.sh"
YH_ORIG_ARGS_STR="$*"

SRC_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
TARGET_OS=""
TARGET_ARCH=""
NODE_VERSION=""
NODE_MIRROR="https://nodejs.org/dist"
NODE_FILE=""
SHASUMS_FILE=""
WINSW_FILE=""
OUT_DIR="${SRC_DIR}/dist"
ALLOW_INTERNAL=0

usage() {
  cat <<EOF
Usage: $(basename -- "$0") --os linux|linux-musl|darwin|win --arch x64|arm64 [options]

Build an air-gapped ${YH_PRODUCT} install bundle for the given target.

  --os OS               linux | linux-musl (unofficial-builds.nodejs.org) | darwin | win
  --arch ARCH           x64 | arm64 (win also: x86)
  --node-version X.Y.Z  Node.js version (default: latest v22.x on the mirror)
  --node-mirror URL     HTTPS mirror of nodejs.org/dist (default: ${NODE_MIRROR})
  --node-file FILE      use a pre-downloaded Node archive/MSI (requires --shasums)
  --shasums FILE        SHASUMS256.txt matching --node-file
  --winsw-file FILE     use a pre-downloaded WinSW.NET461.exe (verified against the pinned hash)
  --source DIR          application tree (default: ${SRC_DIR})
  --out-dir DIR         output directory (default: <source>/dist)
  --allow-internal-use  do not fail when the catalog contains 'internal-use' licensed content
                        (only for bundles that stay inside the licensed organization; see docs/REGULATORY.md)
  --log-file FILE       log file (default: <out-dir>/build-bundle.log)
  --dry-run             show what would happen
  -v, --verbose         more output
  -h, --help            this help

Example: $(basename -- "$0") --os linux --arch x64
         $(basename -- "$0") --os win --arch x64 --node-version 22.23.4
EOF
}

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "option $1 requires a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --os) need_arg "$@"; TARGET_OS=$2; shift 2 ;;
    --arch) need_arg "$@"; TARGET_ARCH=$2; shift 2 ;;
    --node-version) need_arg "$@"; NODE_VERSION=${2#v}; shift 2 ;;
    --node-mirror) need_arg "$@"; NODE_MIRROR=${2%/}; shift 2 ;;
    --node-file) need_arg "$@"; NODE_FILE=$2; shift 2 ;;
    --shasums) need_arg "$@"; SHASUMS_FILE=$2; shift 2 ;;
    --winsw-file) need_arg "$@"; WINSW_FILE=$2; shift 2 ;;
    --source) need_arg "$@"; SRC_DIR="$(cd -- "$2" && pwd -P)"; shift 2 ;;
    --out-dir) need_arg "$@"; OUT_DIR=$2; shift 2 ;;
    --allow-internal-use) ALLOW_INTERNAL=1; shift ;;
    --log-file) need_arg "$@"; LOG_FILE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

install_traps
case "${TARGET_OS}" in linux|linux-musl|darwin|win) ;; *) usage >&2; die "--os is required (linux|linux-musl|darwin|win)";; esac
case "${TARGET_OS}:${TARGET_ARCH}" in
  linux:x64|linux:arm64|linux-musl:x64|linux-musl:arm64|darwin:x64|darwin:arm64|win:x64|win:arm64|win:x86) ;;
  *) die "unsupported target ${TARGET_OS}/${TARGET_ARCH}";;
esac
if [ -n "${NODE_FILE}" ] && [ -z "${SHASUMS_FILE}" ]; then die "--node-file requires --shasums"; fi
[ -f "${SRC_DIR}/package.json" ] || die "no package.json in ${SRC_DIR}"
if [ "$(id -u)" -eq 0 ]; then warn "running as root is unnecessary for building a bundle (least privilege)"; fi
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd -- "${OUT_DIR}" && pwd -P)"
init_logging "${LOG_FILE:-${OUT_DIR}/build-bundle.log}"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/package.json" | head -n 1)"
[ -n "${VERSION}" ] || die "cannot read version from package.json"
NAME="youheal-${VERSION}-${TARGET_OS}-${TARGET_ARCH}"
STAGE="${OUT_DIR}/${NAME}"
log "building ${NAME} from ${SRC_DIR} -> ${OUT_DIR}"

# ---- licensing gate (ADR-007) ------------------------------------------------------------------
SOURCES_JSON="${SRC_DIR}/data/catalog/sources.json"
if [ -f "${SOURCES_JSON}" ] && grep -q '"internal-use"' "${SOURCES_JSON}"; then
  if [ "${ALLOW_INTERNAL}" = 1 ]; then
    warn "catalog contains 'internal-use' content (e.g. GOIZ guides). This bundle must NOT leave the licensed organization."
  else
    die "catalog contains 'internal-use' content (ADR-007). Distribution requires a license — see docs/REGULATORY.md. Re-run with --allow-internal-use for an internal bundle."
  fi
fi

# ---- stage ---------------------------------------------------------------------------------------
make_tmp
run rm -rf -- "${STAGE}"
run mkdir -p "${STAGE}/app" "${STAGE}/runtime"
if [ "${DRY_RUN}" = 1 ]; then
  run tar -C "${SRC_DIR}" -cf - "(excludes)" . \| tar -C "${STAGE}/app" -xf -
else
  tar -C "${SRC_DIR}" -cf - --exclude=./data/sources --exclude=./data/db --exclude=./data/keys --exclude=./data/backups \
    --exclude=./data/tls --exclude=./data/i18n/_work --exclude=./node_modules --exclude=./.git --exclude=./tests --exclude=./importer --exclude=./dist \
    --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' --exclude=./.env --exclude='*.yhbak' . \
    | tar -C "${STAGE}/app" -xf -
fi

# ---- Node runtime -----------------------------------------------------------------------------------
mirror="${NODE_MIRROR}"
case "${TARGET_OS}" in
  linux) node_name() { printf 'node-v%s-linux-%s.tar.xz' "$1" "${TARGET_ARCH}"; } ;;
  linux-musl)
    mirror="https://unofficial-builds.nodejs.org/download/release"
    warn "linux-musl uses unofficial-builds.nodejs.org (community builds, not covered by the Node.js release signing keys)"
    node_name() { printf 'node-v%s-linux-%s-musl.tar.xz' "$1" "${TARGET_ARCH}"; } ;;
  darwin) node_name() { printf 'node-v%s-darwin-%s.tar.gz' "$1" "${TARGET_ARCH}"; } ;;
  win) node_name() { printf 'node-v%s-%s.msi' "$1" "${TARGET_ARCH}"; } ;;
esac
if [ -n "${NODE_FILE}" ]; then
  NODE_BASENAME="$(basename -- "${NODE_FILE}")"
  NODE_VERSION="$(printf '%s' "${NODE_BASENAME}" | sed -E 's/^node-v([0-9.]+)-.*/\1/')"
  run cp -- "${NODE_FILE}" "${STAGE}/runtime/"
  run cp -- "${SHASUMS_FILE}" "${STAGE}/runtime/SHASUMS256.txt"
else
  if [ -z "${NODE_VERSION}" ]; then
    fetch "${mirror}/latest-v22.x/SHASUMS256.txt" "${YH_TMP_DIR}/latest.txt" 2>/dev/null \
      || fetch "${NODE_MIRROR}/latest-v22.x/SHASUMS256.txt" "${YH_TMP_DIR}/latest.txt"
    NODE_VERSION="$(sed -nE 's/.*node-v(22\.[0-9]+\.[0-9]+)-.*/\1/p' "${YH_TMP_DIR}/latest.txt" | head -n 1)"
    [ -n "${NODE_VERSION}" ] || die "could not resolve latest Node.js v22.x"
  fi
  version_ge "${NODE_VERSION}" "${YH_NODE_MIN}" || die "Node ${NODE_VERSION} < ${YH_NODE_MIN}"
  NODE_BASENAME="$(node_name "${NODE_VERSION}")"
  log "Node.js ${NODE_VERSION}: ${mirror}/v${NODE_VERSION}/${NODE_BASENAME}"
  run fetch "${mirror}/v${NODE_VERSION}/SHASUMS256.txt" "${STAGE}/runtime/SHASUMS256.txt"
  if [ "${TARGET_OS}" != linux-musl ]; then
    # Detached clearsigned checksums for out-of-band GPG verification against the Node.js release keys.
    if [ "${DRY_RUN}" = 0 ]; then fetch "${mirror}/v${NODE_VERSION}/SHASUMS256.txt.asc" "${STAGE}/runtime/SHASUMS256.txt.asc" || warn "SHASUMS256.txt.asc not available"; fi
  fi
  run fetch "${mirror}/v${NODE_VERSION}/${NODE_BASENAME}" "${STAGE}/runtime/${NODE_BASENAME}"
fi
NODE_SHA=""
if [ "${DRY_RUN}" = 0 ]; then
  NODE_SHA="$(sha256_of "${STAGE}/runtime/${NODE_BASENAME}")"
  expected="$(awk -v n="${NODE_BASENAME}" '$2==n || $2=="*"n {print $1}' "${STAGE}/runtime/SHASUMS256.txt" | head -n 1)"
  [ -n "${expected}" ] || die "${NODE_BASENAME} not listed in SHASUMS256.txt"
  [ "${expected}" = "${NODE_SHA}" ] || die "SHA-256 mismatch for ${NODE_BASENAME}"
  ok "Node.js runtime verified (${NODE_SHA})"
  if command -v gpg >/dev/null 2>&1 && [ -f "${STAGE}/runtime/SHASUMS256.txt.asc" ]; then
    if gpg --batch --verify "${STAGE}/runtime/SHASUMS256.txt.asc" >/dev/null 2>&1; then ok "SHASUMS256.txt.asc signature verified with the local keyring"
    else warn "could not verify SHASUMS256.txt.asc (import the Node.js release keys: https://github.com/nodejs/node#release-keys)"; fi
  fi
fi

# ---- WinSW ----------------------------------------------------------------------------------------
if [ "${TARGET_OS}" = win ]; then
  MODULE="${SRC_DIR}/deploy/windows/YouHeal.Common.psm1"
  WINSW_URL="$(sed -n "s/^\$script:YHWinSWUrl = '\(.*\)'.*/\1/p" "${MODULE}")"
  WINSW_SHA="$(sed -n "s/^\$script:YHWinSWSha256 = '\(.*\)'.*/\1/p" "${MODULE}" | tr 'A-F' 'a-f')"
  if [ -z "${WINSW_URL}" ] || [ -z "${WINSW_SHA}" ]; then die "cannot read the pinned WinSW URL/hash from ${MODULE}"; fi
  run mkdir -p "${STAGE}/winsw"
  if [ -n "${WINSW_FILE}" ]; then run cp -- "${WINSW_FILE}" "${STAGE}/winsw/WinSW.NET461.exe"
  else run fetch "${WINSW_URL}" "${STAGE}/winsw/WinSW.NET461.exe"; fi
  if [ "${DRY_RUN}" = 0 ]; then
    [ "$(sha256_of "${STAGE}/winsw/WinSW.NET461.exe")" = "${WINSW_SHA}" ] || die "WinSW hash mismatch (expected ${WINSW_SHA})"
    ok "WinSW verified (${WINSW_SHA})"
  fi
fi

# ---- manifest, docs, checksums -----------------------------------------------------------------------
TREE_SHA="$( (cd -- "${SRC_DIR}" && git rev-parse HEAD 2>/dev/null) || echo "no-git")"
DIRTY="$( (cd -- "${SRC_DIR}" && git status --porcelain 2>/dev/null | head -n 1) || true)"
write_file "${STAGE}/BUNDLE.json" 0644 - <<EOF
{
  "name": "${NAME}",
  "product": "YOU HEAL Clinical",
  "version": "${VERSION}",
  "target": { "os": "${TARGET_OS}", "arch": "${TARGET_ARCH}" },
  "node": { "version": "${NODE_VERSION}", "file": "runtime/${NODE_BASENAME}", "sha256": "${NODE_SHA}", "source": "${mirror}" },
  "winsw": $( [ "${TARGET_OS}" = win ] && printf '{ "file": "winsw/WinSW.NET461.exe", "sha256": "%s" }' "${WINSW_SHA:-}" || printf 'null' ),
  "build": { "at": "$(_ts)", "host": "$(hostname)", "vcsRevision": "${TREE_SHA}", "vcsDirty": $( [ -n "${DIRTY}" ] && echo true || echo false ) },
  "signature": { "status": "unsigned", "see": "SIGNATURES.md" }
}
EOF
# Single source shared with build-bundle.ps1
write_file "${STAGE}/SIGNATURES.md" 0644 - <"${SCRIPT_DIR}/SIGNATURES.template.md"
write_file "${STAGE}/README-OFFLINE.txt" 0644 - <<EOF
YOU HEAL Clinical ${VERSION} - offline install bundle for ${TARGET_OS}/${TARGET_ARCH}

1. Verify the archive hash against the value published by your release manager:
     sha256sum ${NAME}.$( [ "${TARGET_OS}" = win ] && echo zip || echo tar.gz )        (Windows: Get-FileHash -Algorithm SHA256)
2. (Recommended) Verify CHECKSUMS.sha256 signature - see SIGNATURES.md.
3. Install:
     Linux/macOS:  sudo ./app/deploy/linux/install.sh --offline-bundle "\$(pwd)"
     Windows:      powershell -ExecutionPolicy Bypass -File .\\app\\deploy\\windows\\Install-YouHeal.ps1 -OfflineBundle "\$PWD"
   The installers verify every file against CHECKSUMS.sha256 before using it.
4. Follow app/docs/OPERATIONS.md (first-run setup, key escrow, backups).
EOF

log "computing CHECKSUMS.sha256"
if [ "${DRY_RUN}" = 0 ]; then
  (cd -- "${STAGE}" && find . -type f ! -name 'CHECKSUMS.sha256' ! -name 'CHECKSUMS.sha256.*' | LC_ALL=C sort | while IFS= read -r f; do
     printf '%s  %s\n' "$(sha256_of "${f}")" "${f#./}"; done) >"${YH_TMP_DIR}/CHECKSUMS.sha256"
  mv -f "${YH_TMP_DIR}/CHECKSUMS.sha256" "${STAGE}/CHECKSUMS.sha256"
  chmod 0644 "${STAGE}/CHECKSUMS.sha256"
  ok "$(wc -l <"${STAGE}/CHECKSUMS.sha256" | tr -d ' ') files checksummed"
fi

# ---- archive ------------------------------------------------------------------------------------------
if [ "${TARGET_OS}" = win ]; then
  ARCHIVE="${OUT_DIR}/${NAME}.zip"
  run rm -f -- "${ARCHIVE}"
  if [ "${DRY_RUN}" = 1 ]; then run zip -r "${ARCHIVE}" "${NAME}"
  elif command -v zip >/dev/null 2>&1; then (cd -- "${OUT_DIR}" && zip -q -r -X "${ARCHIVE}" "${NAME}")
  elif command -v bsdtar >/dev/null 2>&1; then (cd -- "${OUT_DIR}" && bsdtar -a -cf "${ARCHIVE}" "${NAME}")
  elif command -v python3 >/dev/null 2>&1; then (cd -- "${OUT_DIR}" && python3 -I -m zipfile -c "${ARCHIVE}" "${NAME}")
  else die "need zip, bsdtar or python3 to create a .zip"; fi
else
  ARCHIVE="${OUT_DIR}/${NAME}.tar.gz"
  run tar -C "${OUT_DIR}" -czf "${ARCHIVE}" "${NAME}"
fi
if [ "${DRY_RUN}" = 0 ]; then
  ASUM="$(sha256_of "${ARCHIVE}")"
  printf '%s  %s\n' "${ASUM}" "$(basename -- "${ARCHIVE}")" >"${ARCHIVE}.sha256"
  rm -rf -- "${STAGE}"
  ok "bundle: ${ARCHIVE}"
  ok "sha256: ${ASUM}  (publish this value out-of-band; sign CHECKSUMS.sha256 per SIGNATURES.md)"
fi
