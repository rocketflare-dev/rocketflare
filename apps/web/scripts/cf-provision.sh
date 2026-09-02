#!/usr/bin/env bash
# Provision the Cloudflare resources one environment of this kit needs. Idempotent: existing
# resources are detected by name and reused rather than duplicated. Prints the ids to paste into
# the matching wrangler toml, or patches them in itself with `--apply`.
#
#   NEON_DATABASE_URL='postgresql://…' pnpm web provision:cloudflare <staging|production> [app-name] [--apply]   # from the repo root
#   NEON_DATABASE_URL='postgresql://…' bash apps/web/scripts/cf-provision.sh <staging|production> [--apply]
#
#   <staging|production>  which toml the ids belong to (wrangler.staging.toml / wrangler.toml)
#   [app-name]            worker base name; defaults to `name` in wrangler.toml
#   --apply               write the ids into the toml through scripts/provision/patch-toml.ts
#                         (byte-preserving; a DIFFERENT existing id is refused unless --force)
#   --force               with --apply: overwrite a different existing id
#
# The orchestrator `pnpm provision cloudflare <env>` (scripts/provision.ts) calls this with --apply.
#
# Working directory: this file lives in apps/web/scripts inside the pnpm workspace. The package
# script runs it with apps/web as cwd, and the script ALSO `cd`s to apps/web itself (resolved from
# its own location), so every relative path below — `wrangler.toml`, `wrangler.staging.toml`,
# `pnpm exec wrangler` (the apps/web devDependency) — works whether it is invoked from the root,
# from apps/web, or by absolute path.
#
# Requires: pnpm, an authenticated wrangler session (`pnpm --filter @rocketflare/web exec wrangler login`
# from the root, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment), and
# NEON_DATABASE_URL — the DIRECT (non `-pooler`) host of that environment's Neon branch. Hyperdrive
# pools itself; see docs/DEPLOY.md → Neon.
#
# Creates (all four, idempotently — both tomls already declare every binding):
#   Hyperdrive config   <app>-<env>                 → [[hyperdrive]] id            (patched / printed)
#   KV namespace        <APP>_RATE_LIMIT[_STAGING]  → [[kv_namespaces]] id         (patched / printed)
#   Queue               <app>-jobs[-staging]        → [[queues.*]] queue           (name-referenced)
#   R2 bucket           <app>-files[-staging]       → [[r2_buckets]] bucket_name   (name-referenced)
# Workflows, Durable Objects and the Workers AI binding need no create step: `wrangler deploy`
# registers them. Workflow names are ACCOUNT-scoped, so the staging toml MUST use
# `<app>-agent-run-staging`.
#
# Nothing here writes to git. The secret connection string is passed to wrangler only (it is an
# argument of that one `wrangler hyperdrive create` process) and is redacted from every echoed line.
set -euo pipefail

ENV_NAME=""
APP_ARG=""
APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    --help|-h) ENV_NAME="" ; break ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) if [ -z "$ENV_NAME" ]; then ENV_NAME="$arg"; elif [ -z "$APP_ARG" ]; then APP_ARG="$arg"; else echo "unexpected argument: $arg" >&2; exit 2; fi ;;
  esac
done
case "$ENV_NAME" in
  staging|production) ;;
  *) echo "usage: NEON_DATABASE_URL=… bash $0 <staging|production> [app-name] [--apply] [--force]" >&2; exit 2 ;;
esac

# apps/web — the package that owns the tomls and the wrangler devDependency (NOT the workspace root).
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WEB_DIR"

APP="${APP_ARG:-$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)}"
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
# Every echoed wrangler line passes through this: connection strings never reach the terminal.
redact() { sed -E 's#postgres[a-z]*://[^ "'"'"']*#<redacted>#g'; }

# ---- preflight ------------------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then echo "pnpm not found (corepack enable)" >&2; exit 1; fi
if ! wr whoami >/dev/null 2>&1; then
  echo "wrangler is not authenticated. Run: pnpm --filter @rocketflare/web exec wrangler login   (or export CLOUDFLARE_API_TOKEN)" >&2
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
  set +e
  OUT="$(wr hyperdrive create "$HYPERDRIVE_NAME" --connection-string="$NEON_DATABASE_URL" 2>&1 | redact)"
  set -e
  HD_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$HD_ID" ]; then
    printf '%s\n' "$OUT" >&2
    if printf '%s' "$OUT" | grep -qiE 'paid|plan|upgrade|not (available|enabled)|10021|entitle'; then
      echo "Hyperdrive requires Workers Paid: https://dash.cloudflare.com/?to=/:account/workers/plans" >&2
    fi
    echo "could not parse Hyperdrive id" >&2; exit 1
  fi
  echo "hyperdrive  ${HYPERDRIVE_NAME}  created id=${HD_ID}"
fi

# ---- KV -------------------------------------------------------------------------------------
KV_ID="$(wr kv namespace list 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const a=JSON.parse(s.slice(s.indexOf("["))); const m=a.find(x=>x.title===process.argv[1]||x.title.endsWith("-"+process.argv[1])); if(m) console.log(m.id) } catch {}
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

# ---- Queue + R2 (bindings JOBS_QUEUE / FILES; name-referenced, no ids to paste) ------------------
if ! wr queues list 2>/dev/null | grep -qE "(^|[^A-Za-z0-9_-])${QUEUE_NAME}([^A-Za-z0-9_-]|$)"; then
  wr queues create "$QUEUE_NAME"
fi
echo "queue       ${QUEUE_NAME}  (name-referenced; no id to paste)"
if ! wr r2 bucket list 2>/dev/null | grep -qE "name: *${BUCKET_NAME}\$"; then
  wr r2 bucket create "$BUCKET_NAME"
fi
echo "r2          ${BUCKET_NAME}  (name-referenced; no id to paste)"

# ---- apply / output -------------------------------------------------------------------------
if [ "$APPLY" = "1" ]; then
  FORCE_FLAG=""; [ "$FORCE" = "1" ] && FORCE_FLAG="--force"
  # shellcheck disable=SC2086
  pnpm exec tsx scripts/provision/patch-toml.ts "$TOML" --hyperdrive-id "$HD_ID" --kv-id "$KV_ID" $FORCE_FLAG
fi

cat <<EOT

== ${TOML}: ==

[[hyperdrive]]  binding = "HYPERDRIVE"      id = "${HD_ID}"
[[kv_namespaces]] binding = "RATE_LIMIT_KV" id = "${KV_ID}"

EOT
if [ "$APPLY" != "1" ]; then
cat <<EOT
Paste the ids above into apps/web/${TOML}, or run the sed line from apps/web (or re-run with --apply):

  sed -i.bak 's|<HYPERDRIVE${ID_TAG}_ID>|${HD_ID}|; s|<KV_RATE_LIMIT${ID_TAG}_ID>|${KV_ID}|' ${TOML} && rm ${TOML}.bak

EOT
fi
cat <<EOT
Then (from the workspace root):
  REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config   # parity test must pass with no <PLACEHOLDER> left
  git diff apps/web/${TOML}                                    # review; ids are not secrets and are committed
Name-referenced resources for this environment (already declared in ${TOML}):
  queue      = "${QUEUE_NAME}"
  bucket     = "${BUCKET_NAME}"
  workflow   = "${APP}-agent-run${SUFFIX}"    # ACCOUNT-scoped: must differ from the other env; registered by wrangler deploy
EOT
