#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
JEMACS_HOME="${JEMACS_HOME:-${DATA_HOME}/jemacs}"
CORE_PACKAGE="${JEMACS_HOME}/packages/jemacs-core"
LINK="${PACKAGES_REPO}/node_modules/@jemacs/core"

if [[ ! -f "${CORE_PACKAGE}/package.json" ]]; then
  echo "jemacs packages: @jemacs/core not found at ${CORE_PACKAGE}" >&2
  echo "Install the core first or set JEMACS_HOME to its checkout." >&2
  exit 1
fi

mkdir -p "$(dirname "${LINK}")"
if [[ -e "${LINK}" || -L "${LINK}" ]]; then
  rm -rf "${LINK}"
fi
ln -s "${CORE_PACKAGE}" "${LINK}"
