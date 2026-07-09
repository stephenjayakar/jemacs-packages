#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
JEMACS_DIR="${JEMACS_DIR:-${HOME}/.jemacs}"
PACKAGES_PATH="${JEMACS_PACKAGES:-${JEMACS_DIR}/packages}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
export JEMACS_HOME="${JEMACS_HOME:-${DATA_HOME}/jemacs}"

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  else
    npx bun "$@"
  fi
}

if [[ ! -f "${JEMACS_HOME}/packages/jemacs-core/package.json" ]]; then
  echo "jemacs packages: core is not installed at ${JEMACS_HOME}" >&2
  echo "Run scripts/install.sh from the core checkout first, or set JEMACS_HOME." >&2
  exit 1
fi

cd "${PACKAGES_REPO}"
run_bun install
run_bun run check || echo "warn: typecheck reported errors"
if [[ "${JEMACS_PACKAGES_INSTALL_SKIP_TEST:-}" != "1" ]]; then
  run_bun test || echo "warn: some tests failed (set JEMACS_PACKAGES_INSTALL_SKIP_TEST=1 to skip)"
fi

mkdir -p "$(dirname "${PACKAGES_PATH}")"
if [[ -e "${PACKAGES_PATH}" && ! -L "${PACKAGES_PATH}" ]]; then
  if [[ "$(cd "${PACKAGES_PATH}" 2>/dev/null && pwd -P)" != "$(cd "${PACKAGES_REPO}" && pwd -P)" ]]; then
    echo "jemacs packages: refusing to replace ${PACKAGES_PATH}; move it or set JEMACS_PACKAGES" >&2
    exit 1
  fi
else
  ln -sfn "${PACKAGES_REPO}" "${PACKAGES_PATH}"
fi

echo "Installed Jemacs packages:"
echo "  ${PACKAGES_PATH} -> ${PACKAGES_REPO}"
echo "  @jemacs/core -> ${JEMACS_HOME}/packages/jemacs-core"
