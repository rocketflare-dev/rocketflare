#!/usr/bin/env bash
# Prerequisites for `scripts/bootstrap.mjs`, then exec it. This is the entry point for a machine
# that may have no Node or pnpm yet (`bash scripts/bootstrap.sh`, and what install.sh execs).
# It only ever installs through a version manager that is already present (fnm or nvm) or through
# corepack/npm — it never pipes a URL into a shell. Exit 3 with a one-line fix hint on any miss.
# Bash 3.2 (macOS) compatible: no mapfile, no ${var,,}, ${1+"$@"} for the empty-argument case.
set -euo pipefail

fail() { printf '✖ %s\n  fix: %s\n' "$1" "$2" >&2; exit 3; }
ok() { printf '✔ %s\n' "$1"; }

case "$(uname -s)" in
  Darwin|Linux) ok "os $(uname -s)" ;;
  *) fail "unsupported OS $(uname -s)" "macOS or Linux (Windows: WSL2)" ;;
esac
[ "${EUID:-$(id -u)}" -ne 0 ] || fail "running as root" "run as your own user (no sudo)"

cd "$(dirname "$0")/.."
NODE_MAJOR="$(sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p' .nvmrc | head -1)"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"

command -v git >/dev/null 2>&1 || fail "git not found" "install git (xcode-select --install / apt install git)"
ok "git $(git --version | awk '{print $3}')"

if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then
    fail "docker not found" "brew install colima docker && colima start"
  else
    fail "docker not found" "install Docker Engine and add your user to the docker group"
  fi
fi
ok "docker $(docker --version | sed 's/,.*//' | awk '{print $3}')"

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge "$NODE_MAJOR" ]; }
if ! node_ok; then
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
    fnm use --install-if-missing >/dev/null      # reads .nvmrc
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    set +u; . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"; nvm install >/dev/null; set -u   # reads .nvmrc
  else
    fail "node >= $NODE_MAJOR not found" "brew install fnm && fnm install $NODE_MAJOR  —  or install nvm, then: nvm install $NODE_MAJOR"
  fi
  node_ok || fail "node $(node -v 2>/dev/null || echo missing) < $NODE_MAJOR after install" "open a new shell and run: nvm install $NODE_MAJOR (or fnm install $NODE_MAJOR)"
fi
ok "node $(node -v)"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! command -v pnpm >/dev/null 2>&1 || ! pnpm -v 2>/dev/null | grep -q '^10\.'; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || fail "corepack enable failed" "npm i -g pnpm@$PNPM_VERSION"
  else
    npm i -g "pnpm@$PNPM_VERSION" >/dev/null || fail "npm i -g pnpm failed" "install pnpm 10: https://pnpm.io/installation"
  fi
fi
pnpm -v 2>/dev/null | grep -q '^10\.' || fail "pnpm 10.x not found ($(pnpm -v 2>/dev/null || echo missing))" "corepack enable  (or npm i -g pnpm@$PNPM_VERSION)"
ok "pnpm $(pnpm -v)"

exec node scripts/bootstrap.mjs ${1+"$@"}
