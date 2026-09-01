#!/usr/bin/env bash
# Provision the Cloudflare resources one environment of this kit needs, and print the ids to paste
# into the matching wrangler toml. Idempotent-ish: existing resources are detected by name and
# reused rather than duplicated.
#
#   NEON_DATABASE_URL='postgresql://…' pnpm provision <staging|production> [app-name]      # from the repo root
#   NEON_DATABASE_URL='postgresql://…' bash apps/web/scripts/cf-provision.sh <staging|production>
#
#   <staging|production>  which toml the ids belong to (wrangler.staging.toml / wrangler.toml)
#   [app-name]            worker base name; defaults to `name` in wrangler.toml (gmgo-starter)
#
# Working directory: this file lives in apps/web/scripts inside the pnpm workspace. The root
# `pnpm provision` script runs it with apps/web as cwd, and the script ALSO `cd`s to apps/web itself
# (resolved from its own location), so every relative path below — `wrangler.toml`,
# `wrangler.staging.toml`, `pnpm exec wrangler` (the apps/web devDependency) — works whether it is
# invoked from the root, from apps/web, or by absolute path.
#
# Requires: pnpm, an authenticated wrangler session (`pnpm --filter @gmgo/web exec wrangler login`
# from the root), and NEON_DATABASE_URL — the DIRECT (non `-pooler`) host of that environment's
# Neon branch. Hyperdrive pools itself; see docs/DEPLOY.md → Neon.
#
# Creates (Phase 0):   Hyperdrive config   <app>-<env>            → [[hyperdrive]] id
#                      KV namespace        <APP>_RATE_LIMIT[_STAGING] → [[kv_namespaces]] id
# Later phases (uncomment when the toml gains the binding — keep BOTH tomls in step):
#                      Queue               <app>-jobs[-staging]
#                      R2 bucket           <app>-files[-staging]
# Workflows and Durable Objects need no create step: they are declared in the toml. Workflow
# names are ACCOUNT-scoped, so the staging toml MUST use `<app>-agent-run-staging`.
#
# Nothing here writes to the tomls or to git. The secret connection string is passed to
# wrangler only; it is never echoed.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging|production) ;;
  *) echo "usage: NEON_DATABASE_URL=… bash $0 <staging|production> [app-name]" >&2; exit 2 ;;
esac

# apps/web — the package that owns the tomls and the wrangler devDependency (NOT the workspace root).
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WEB_DIR"

APP="${2:-$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)}"
if [ -z "$APP" ]; then echo "could not read \`name\` from wrangler.toml; pass [app-name]" >&2; exit 2; fi
APP_UPPER="$(printf '%s' "$APP" | tr '[:lower:]-' '[:upper:]_')"

if [ "$ENV_NAME" = "staging" ]; then
  TOML="wrangler.staging.toml"; SUFFIX="-staging"; KV_SUFFIX="_STAGING"; ID_TAG="_STAGING"
else
  TOML="wrangler.toml"; SUFFIX=""; KV_SUFFIX=""; ID_TAG=""
fi

HYPERDRIVE_NAME="${APP}-${ENV_NAME}"
KV_NAME="${APP_UPPER}_RATE_LIMIT${KV_SUFFIX}"
QUEUE_NAME="${APP}-jobs${SUFFIX}"
BUCKET_NAME="${APP}-files${SUFFIX}"

wr() { pnpm exec wrangler "$@"; }

# ---- preflight ------------------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then echo "pnpm not found (corepack enable)" >&2; exit 1; fi
if ! wr whoami >/dev/null 2>&1; then
  echo "wrangler is not authenticated. Run: pnpm --filter @gmgo/web exec wrangler login   (or export CLOUDFLARE_API_TOKEN)" >&2
  exit 1
fi
if [ -z "${NEON_DATABASE_URL:-}" ]; then
  echo "NEON_DATABASE_URL is required (direct host of the ${ENV_NAME} Neon branch)." >&2
  exit 1
fi
case "$NEON_DATABASE_URL" in
  *-pooler.*) echo "warning: NEON_DATABASE_URL uses the -pooler host; Hyperdrive should point at the DIRECT host." >&2 ;;
esac

echo "== ${APP} / ${ENV_NAME} → ${TOML}"
echo

# ---- Hyperdrive -----------------------------------------------------------------------------
# `wrangler hyperdrive list` prints a table; match the name column and take the id column.
HD_ID="$(wr hyperdrive list 2>/dev/null | awk -v n="$HYPERDRIVE_NAME" '$0 ~ "[| ]"n"[| ]" { for (i=1;i<=NF;i++) if ($i ~ /^[0-9a-f]{32}$/) { print $i; exit } }')"
if [ -n "$HD_ID" ]; then
  echo "hyperdrive  ${HYPERDRIVE_NAME}  exists  id=${HD_ID}"
else
  echo "hyperdrive  ${HYPERDRIVE_NAME}  creating…"
  OUT="$(wr hyperdrive create "$HYPERDRIVE_NAME" --connection-string="$NEON_DATABASE_URL" 2>&1 | sed 's/postgres[a-z]*:\/\/[^ "]*/<redacted>/g')"
  HD_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$HD_ID" ]; then echo "$OUT" >&2; echo "could not parse Hyperdrive id" >&2; exit 1; fi
  echo "hyperdrive  ${HYPERDRIVE_NAME}  created id=${HD_ID}"
fi

# ---- KV -------------------------------------------------------------------------------------
KV_ID="$(wr kv namespace list 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const a=JSON.parse(s); const m=a.find(x=>x.title===process.argv[1]||x.title.endsWith("-"+process.argv[1])); if(m) console.log(m.id) } catch {}
  })' "$KV_NAME")"
if [ -n "$KV_ID" ]; then
  echo "kv          ${KV_NAME}  exists  id=${KV_ID}"
else
  echo "kv          ${KV_NAME}  creating…"
  OUT="$(wr kv namespace create "$KV_NAME" 2>&1)"
  KV_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$KV_ID" ]; then echo "$OUT" >&2; echo "could not parse KV namespace id" >&2; exit 1; fi
  echo "kv          ${KV_NAME}  created id=${KV_ID}"
fi

# ---- Queue + R2 (Phase 2 bindings JOBS_QUEUE / FILES; name-referenced, no ids to paste) ----------
if ! wr queues list 2>/dev/null | grep -q "\b${QUEUE_NAME}\b"; then
  wr queues create "$QUEUE_NAME"
fi
echo "queue       ${QUEUE_NAME}  (name-referenced; no id to paste)"
if ! wr r2 bucket list 2>/dev/null | grep -q "name: *${BUCKET_NAME}\$"; then
  wr r2 bucket create "$BUCKET_NAME"
fi
echo "r2          ${BUCKET_NAME}  (name-referenced; no id to paste)"

# ---- output ---------------------------------------------------------------------------------
cat <<EOF

== Paste into apps/web/${TOML} (or run the sed line from apps/web) ==

[[hyperdrive]]  binding = "HYPERDRIVE"      id = "${HD_ID}"
[[kv_namespaces]] binding = "RATE_LIMIT_KV" id = "${KV_ID}"

  sed -i.bak 's|<HYPERDRIVE${ID_TAG}_ID>|${HD_ID}|; s|<KV_RATE_LIMIT${ID_TAG}_ID>|${KV_ID}|' ${TOML} && rm ${TOML}.bak

Then (from the repo root):
  REQUIRE_PROVISIONED=1 pnpm --filter @gmgo/web test:config   # parity test must pass with no <PLACEHOLDER> left
  git diff apps/web/${TOML}                                    # review; ids are not secrets and are committed
Later-phase names for this environment (declare them in ${TOML} when the phase lands):
  queue      = "${QUEUE_NAME}"
  bucket     = "${BUCKET_NAME}"
  workflow   = "${APP}-agent-run${SUFFIX}"    # ACCOUNT-scoped: must differ from the other env
EOF
