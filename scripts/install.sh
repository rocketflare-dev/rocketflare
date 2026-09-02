#!/usr/bin/env bash
# Canonical file: scripts/install.sh in https://github.com/rocketflare-dev/rocketflare — a byte
# copy is served from https://rocketflare.dev/install.sh. It does nothing the README's clone path
# does not: clone, detach the kit's history (README / docs/ADAPTING.md §0), then hand over to
# scripts/bootstrap.sh. No sudo, no version-manager downloads, no writes outside the target dir.
#
#   curl -fsSL https://rocketflare.dev/install.sh | bash -s -- [dir] [bootstrap options]
#
# Default dir: rocketflare-app. Piped through `bash -s`, stdin is the script, so the interactive
# bootstrap is re-attached to /dev/tty when there is one; otherwise it runs --no-dev --yes.
set -euo pipefail

# Wrapped in a function so bash parses the WHOLE file before running anything: piped through
# `bash -s`, a child that reads stdin would otherwise swallow the rest of the script.
main() {
REPO="https://github.com/rocketflare-dev/rocketflare.git"
DIR="rocketflare-app"
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then DIR="$1"; shift; fi

[ "${EUID:-$(id -u)}" -ne 0 ] || { echo "install: refusing to run as root — run as your own user" >&2; exit 3; }
command -v git >/dev/null 2>&1 || { echo "install: git is required (xcode-select --install / apt install git)" >&2; exit 3; }
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "install: $DIR exists and is not empty — pick another directory: bash -s -- <dir>" >&2; exit 3
fi

echo "Cloning Rocketflare into $DIR …"
git clone --depth 1 "$REPO" "$DIR"
cd "$DIR"
KIT_COMMIT="$(git rev-parse --short HEAD)"
# Your history starts here (README / docs/ADAPTING.md §0). The kit commit is recorded in the message.
rm -rf .git && git init -q && git add -A
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo Rocketflare)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo rocketflare@localhost)}" \
    commit -q -m "Start from Rocketflare" -m "Kit commit: $KIT_COMMIT"
echo "✔ cloned and detached from the kit's history (kit commit $KIT_COMMIT)"

if [ -r /dev/tty ]; then
  exec bash scripts/bootstrap.sh ${1+"$@"} </dev/tty
fi
bash scripts/bootstrap.sh --no-dev --yes ${1+"$@"} </dev/null
echo
echo "Next, in $DIR:"
echo "  pnpm dev                      # then http://localhost:3000/login?as=owner@example.test"
echo "  pnpm cli login --server http://localhost:3001"
}

main ${1+"$@"}
