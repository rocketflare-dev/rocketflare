#!/usr/bin/env bash
# Prerequisites for `scripts/bootstrap.mjs`, then exec it. This is the entry point for a machine
# that may have no Node or pnpm yet (`bash scripts/bootstrap.sh`, and what install.sh execs).
# It only ever installs through a version manager that is already present (fnm or nvm) or through
# corepack/npm — it never pipes a URL into a shell. Exit 3 with a one-line fix hint on any miss.
# Bash 3.2 (macOS) compatible: no mapfile, no ${var,,}, ${1+"$@"} for the empty-argument case.
set -euo pipefail

fail() { printf '✖ %s\n  fix: %s\n' "$1" "$2" >&2; exit 3; }
ok() { printf '✔ %s\n' "$1"; }
# WSL detection, Windows-PATH filtering and the platform fix lines (scripts/lib/prereqs.sh).
. "$(dirname "$0")/lib/prereqs.sh"

WSL=0
case "$(uname -s)" in
  Darwin) ok "os Darwin" ;;
  Linux)
    if is_wsl; then WSL=1; ok "os Linux (WSL: ${WSL_DISTRO_NAME:-unknown distro})"; else ok "os Linux"; fi ;;
  *) fail "unsupported OS $(uname -s)" "macOS or Linux (Windows: WSL2)" ;;
esac
# A container whose commands all run as root (a coding sandbox) opts in with ROCKETFLARE_ALLOW_ROOT=1.
if [ "${EUID:-$(id -u)}" -eq 0 ] && [ "${ROCKETFLARE_ALLOW_ROOT:-}" != 1 ]; then
  if [ "$WSL" = 1 ]; then
    wsl_root_hint >&2
    fail "running as root in WSL" "create a normal user and open the distro as them (steps above)"
  fi
  fail "running as root" "run as your own user (no sudo); a container: ROCKETFLARE_ALLOW_ROOT=1"
fi

cd "$(dirname "$0")/.."
NODE_MAJOR="$(sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p' .nvmrc | head -1)"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"

command -v git >/dev/null 2>&1 || fail "git not found" "install git (xcode-select --install / apt install git)"
ok "git $(git --version | awk '{print $3}')"

# `--db-url <url>` bootstraps against a database this checkout does not run (a Neon branch in a
# sandbox with no Docker), so Docker is not a prerequisite then.
EXTERNAL_DB=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --db-url|--db-url=*) EXTERNAL_DB=1 ;;
  esac
done

if [ "$EXTERNAL_DB" = 1 ]; then
  ok "docker skipped (--db-url)"
else
  # A Windows `docker.exe` on WSL's shared PATH is not the Linux CLI the compose scripts call.
  if ! linux_command docker >/dev/null; then
    if [ "$WSL" = 1 ]; then
      wsl_docker_hint >&2
      fail "docker not found inside WSL" "turn on Docker Desktop's WSL integration for this distro, then quit and restart Docker Desktop"
    elif [ "$(uname -s)" = Darwin ]; then
      fail "docker not found" "brew install colima docker && colima start"
    else
      fail "docker not found" "install Docker Engine and add your user to the docker group"
    fi
  fi
  ok "docker $(docker --version | sed 's/,.*//' | awk '{print $3}')"
fi

# A Windows `node` on WSL's shared PATH does not count (linux_command).
node_ok() { linux_command node >/dev/null && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge "$NODE_MAJOR" ]; }
if ! node_ok; then
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
    fnm use --install-if-missing >/dev/null      # reads .nvmrc
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    set +u; . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"; nvm install >/dev/null; set -u   # reads .nvmrc
  else
    node_install_hint "$NODE_MAJOR" >&2
    fail "node >= $NODE_MAJOR not found, and no fnm or nvm to install it" "install a version manager (above), then re-run"
  fi
  node_ok || fail "node $(node -v 2>/dev/null || echo missing) < $NODE_MAJOR after install" "open a new shell and run: nvm install $NODE_MAJOR (or fnm install $NODE_MAJOR)"
fi
ok "node $(node -v)"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm comes from the ACTIVE Node's own bin directory: its corepack when it ships one (Node 26 does
# not), else its npm. Never a `corepack` or `pnpm` found elsewhere on PATH — under WSL that is
# Windows' copy on /mnt/c, a CRLF script that dies with "/bin/sh^M: bad interpreter".
NODE_BIN="$(dirname "$(linux_command node)")"
pnpm_ok() { local p; p="$(linux_command pnpm)" && "$p" -v 2>/dev/null | grep -q '^10\.'; }
if ! pnpm_ok; then
  windows_pnpm="$(command -v pnpm 2>/dev/null || true)"
  if is_windows_path "$windows_pnpm"; then
    printf '  ignoring the Windows pnpm on the shared PATH: %s\n' "$windows_pnpm"
  fi
  if [ -x "$NODE_BIN/corepack" ] && "$NODE_BIN/corepack" enable >/dev/null 2>&1 && pnpm_ok; then
    :
  else
    "$NODE_BIN/npm" i -g "pnpm@$PNPM_VERSION" >/dev/null \
      || fail "npm i -g pnpm@$PNPM_VERSION failed" "$NODE_BIN/npm i -g pnpm@$PNPM_VERSION and read its error"
  fi
fi
pnpm_ok || fail "pnpm 10.x not found ($(pnpm -v 2>/dev/null || echo missing))" "$NODE_BIN/npm i -g pnpm@$PNPM_VERSION, then open a new shell"
ok "pnpm $(pnpm -v)"

exec node scripts/bootstrap.mjs ${1+"$@"}
