#!/usr/bin/env bash
# Detach a fresh clone of the kit from the kit's history, and remember where it came from.
#
#   bash scripts/detach.sh
#
# Run from the root of the clone. Records the kit commit in `.rocketflare.json` (what
# `pnpm kit:upgrade` diffs against) and in the first commit's message (for a human), then replaces
# the history with one commit, "Start from Rocketflare". Used by `scripts/install.sh`, `/rf-start`
# and `/rf-setup` step 0, so the three can never disagree about what a detached copy looks like.
#
# Destructive: every commit is gone afterwards. It refuses unless the tree is the kit's own clone
# (an `origin` naming rocketflare-dev/rocketflare, or `--force` for a mirror) and clean, and it
# refuses when the history already starts with "Start from Rocketflare".
#
# Node may not be installed yet, so this is bash and sed on one known line. The literal kit name
# is safe: this runs before any rename, `.rocketflare.json` is on the rename's preserved list, and
# the file is kit-only, so a copy never carries it.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

[ -f .rocketflare.json ] || { echo "detach: run this from the root of a kit clone" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "detach: not a git repository" >&2; exit 2; }

FIRST="$(git log --reverse --format=%s | head -1)"
if [ "$FIRST" = "Start from Rocketflare" ]; then
  echo "detach: already detached (the first commit is \"Start from Rocketflare\") — nothing to do"
  exit 0
fi
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in
  *rocketflare-dev/rocketflare|*rocketflare-dev/rocketflare.git) ;;
  *)
    if [ "$FORCE" -ne 1 ]; then
      echo "detach: origin is '${ORIGIN:-none}', not the kit's repository." >&2
      echo "        If this is a clone of a mirror, re-run with --force. If it is the kit itself, stop." >&2
      exit 3
    fi
    ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "detach: the tree has changes; detach a fresh clone, before editing anything" >&2
  exit 3
fi

KIT_COMMIT="$(git rev-parse HEAD)"
# Only the FIRST `"commit": null`, the kit block's. A vendored plugin's `source.commit` further down
# stays null (it has no release chain of its own).
awk -v c="$KIT_COMMIT" '!done && /"commit": null/ { sub(/"commit": null/, "\"commit\": \"" c "\""); done = 1 } { print }' \
  .rocketflare.json > .rocketflare.json.tmp && mv .rocketflare.json.tmp .rocketflare.json
grep -q "\"commit\": \"$KIT_COMMIT\"" .rocketflare.json || {
  echo "detach: could not record the kit commit in .rocketflare.json (no \"commit\": null line)" >&2
  exit 1
}
rm -rf .git && git init -q && git add -A
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo Rocketflare)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo rocketflare@localhost)}" \
    commit -q -m "Start from Rocketflare" -m "Kit commit: $KIT_COMMIT"
echo "✔ detached from the kit's history (kit commit ${KIT_COMMIT:0:12}, recorded in .rocketflare.json)"
