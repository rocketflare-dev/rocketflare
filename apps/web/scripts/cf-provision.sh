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
# Creates a RESOURCE LIST, idempotently. The kit’s own four are the default list — both tomls
# already declare every one of these bindings:
#   Hyperdrive config   <app>-<env>                 → [[hyperdrive]] id            (patched / printed)
#   KV namespace        <APP>_RATE_LIMIT[_STAGING]  → [[kv_namespaces]] id         (patched / printed)
#   Queue               <app>-jobs[-staging]        → [[queues.*]] queue           (name-referenced)
#   R2 bucket           <app>-files[-staging]       → [[r2_buckets]] bucket_name   (name-referenced)
#
# PLUGIN_RESOURCES (D31, Decision 12) appends to that list: a JSON array of
# `{ "type": "kv"|"queue"|"r2", "name": "<already env-suffixed>", "binding": "APPROVALS_CACHE" }`,
# built by `pnpm provision cloudflare <env>` from each installed plugin’s `plugin.json` through
# scripts/provision/plugin-resources.ts (which owns the `<app>-<id>-<name>[-staging]` naming rule,
# and the `<APP>_<ID>_<NAME>[_STAGING]` one for KV). It travels in the ENVIRONMENT rather than in
# argv or a temp file: nothing in it is secret, nothing is left on disk, and the redaction rule
# below is unchanged — the connection string is still the one thing that never reaches a log.
# An unsupported type (`d1`, `vectorize`, `analytics_engine`…) is a loud refusal naming the type,
# never a silent skip: a binding that is quietly not created is a Worker that deploys and 503s.
#
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
  *) echo "usage: NEON_DATABASE_URL=… [PLUGIN_RESOURCES='[{\"type\":\"kv\",\"name\":\"…\",\"binding\":\"…\"}]'] bash $0 <staging|production> [app-name] [--apply] [--force]" >&2; exit 2 ;;
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

# ---- the resource list --------------------------------------------------------------------
# TYPE<TAB>NAME<TAB>BINDING per line: the kit’s four, then whatever PLUGIN_RESOURCES declares.
RESOURCE_LIST="$(printf '%s\t%s\t%s\n' \
  hyperdrive "$HYPERDRIVE_NAME" HYPERDRIVE \
  kv         "$KV_NAME"         RATE_LIMIT_KV \
  queue      "$QUEUE_NAME"      JOBS_QUEUE \
  r2         "$BUCKET_NAME"     FILES)"

if [ -n "${PLUGIN_RESOURCES:-}" ]; then
  EXTRA="$(printf '%s' "$PLUGIN_RESOURCES" | node -e '
    let s=""; process.stdin.on("data", d => (s += d)).on("end", () => {
      let list;
      try { list = JSON.parse(s) } catch (e) {
        console.error("PLUGIN_RESOURCES is not valid JSON: " + e.message); process.exit(2)
      }
      if (!Array.isArray(list)) { console.error("PLUGIN_RESOURCES must be a JSON array"); process.exit(2) }
      const supported = ["kv", "queue", "r2"];
      for (const r of list) {
        if (!r || !supported.includes(r.type)) {
          console.error("unsupported plugin binding type " + JSON.stringify(r && r.type) +
            " for binding " + JSON.stringify(r && r.binding) + " (supported: " + supported.join(", ") +
            "). Create it and add the block to BOTH tomls by hand.");
          process.exit(2)
        }
        if (!r.name || !r.binding) { console.error("plugin resource needs name and binding: " + JSON.stringify(r)); process.exit(2) }
        process.stdout.write(r.type + "\t" + r.name + "\t" + r.binding + "\n")
      }
    })')"
  if [ -n "$EXTRA" ]; then
    RESOURCE_LIST="${RESOURCE_LIST}
${EXTRA}"
  fi
fi

# ---- one find-or-create per type ------------------------------------------------------------
# Each sets RESULT_ID (empty for the name-referenced types) rather than echoing it, so the log
# lines below stay on stdout where a human reads them.
RESULT_ID=""

ensure_hyperdrive() {
  local name="$1"
  # `wrangler hyperdrive list` prints a table; match the name column and take the id column.
  RESULT_ID="$(wr hyperdrive list 2>/dev/null | awk -v n="$name" '$0 ~ "[| ]"n"[| ]" { for (i=1;i<=NF;i++) if ($i ~ /^[0-9a-f]{32}$/) { print $i; exit } }')"
  if [ -n "$RESULT_ID" ]; then
    echo "hyperdrive  ${name}  exists  id=${RESULT_ID}"
    return
  fi
  echo "hyperdrive  ${name}  creating…"
  set +e
  OUT="$(wr hyperdrive create "$name" --connection-string="$NEON_DATABASE_URL" 2>&1 | redact)"
  set -e
  RESULT_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$RESULT_ID" ]; then
    printf '%s\n' "$OUT" >&2
    if printf '%s' "$OUT" | grep -qiE 'paid|plan|upgrade|not (available|enabled)|10021|entitle'; then
      echo "Hyperdrive requires Workers Paid: https://dash.cloudflare.com/?to=/:account/workers/plans" >&2
    fi
    echo "could not parse Hyperdrive id" >&2; exit 1
  fi
  echo "hyperdrive  ${name}  created id=${RESULT_ID}"
}

ensure_kv() {
  local name="$1"
  RESULT_ID="$(wr kv namespace list 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const a=JSON.parse(s.slice(s.indexOf("["))); const m=a.find(x=>x.title===process.argv[1]||x.title.endsWith("-"+process.argv[1])); if(m) console.log(m.id) } catch {}
    })' "$name")"
  if [ -n "$RESULT_ID" ]; then
    echo "kv          ${name}  exists  id=${RESULT_ID}"
    return
  fi
  echo "kv          ${name}  creating…"
  OUT="$(wr kv namespace create "$name" 2>&1)"
  RESULT_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$RESULT_ID" ]; then echo "$OUT" >&2; echo "could not parse KV namespace id" >&2; exit 1; fi
  echo "kv          ${name}  created id=${RESULT_ID}"
}

ensure_queue() {
  local name="$1"
  RESULT_ID=""
  if ! wr queues list 2>/dev/null | grep -qE "(^|[^A-Za-z0-9_-])${name}([^A-Za-z0-9_-]|$)"; then
    wr queues create "$name"
  fi
  echo "queue       ${name}  (name-referenced; no id to paste)"
}

ensure_r2() {
  local name="$1"
  RESULT_ID=""
  if ! wr r2 bucket list 2>/dev/null | grep -qE "name: *${name}\$"; then
    wr r2 bucket create "$name"
  fi
  echo "r2          ${name}  (name-referenced; no id to paste)"
}

HD_ID=""
KV_ID=""
PATCH_ARGS=()
while IFS="$(printf '\t')" read -r RTYPE RNAME RBINDING; do
  [ -z "${RTYPE:-}" ] && continue
  case "$RTYPE" in
    hyperdrive)
      ensure_hyperdrive "$RNAME"; HD_ID="$RESULT_ID"
      PATCH_ARGS+=(--hyperdrive-id "$HD_ID") ;;
    kv)
      ensure_kv "$RNAME"
      if [ "$RBINDING" = "RATE_LIMIT_KV" ]; then
        KV_ID="$RESULT_ID"; PATCH_ARGS+=(--kv-id "$KV_ID")
      else
        PATCH_ARGS+=(--binding "{\"type\":\"kv\",\"binding\":\"${RBINDING}\",\"id\":\"${RESULT_ID}\"}")
      fi ;;
    queue)
      ensure_queue "$RNAME"
      [ "$RBINDING" = "JOBS_QUEUE" ] || \
        PATCH_ARGS+=(--binding "{\"type\":\"queue\",\"binding\":\"${RBINDING}\",\"name\":\"${RNAME}\"}") ;;
    r2)
      ensure_r2 "$RNAME"
      [ "$RBINDING" = "FILES" ] || \
        PATCH_ARGS+=(--binding "{\"type\":\"r2\",\"binding\":\"${RBINDING}\",\"name\":\"${RNAME}\"}") ;;
    *) echo "unsupported resource type: ${RTYPE}" >&2; exit 2 ;;
  esac
done <<EOF
${RESOURCE_LIST}
EOF

# ---- apply / output -------------------------------------------------------------------------
if [ "$APPLY" = "1" ]; then
  FORCE_FLAG=""; [ "$FORCE" = "1" ] && FORCE_FLAG="--force"
  # shellcheck disable=SC2086
  pnpm exec tsx scripts/provision/patch-toml.ts "$TOML" ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"} $FORCE_FLAG
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
if [ -n "${PLUGIN_RESOURCES:-}" ]; then
cat <<EOT
Plugin resources for this environment (D31 — declared in each plugin's plugin.json, named
<app>-<id>-<name>${SUFFIX} / <APP>_<ID>_<NAME>${KV_SUFFIX}, block patched into ${TOML}):
EOT
  printf '%s\n' "$RESOURCE_LIST" | awk -F'\t' 'NR > 4 { printf "  %-11s %-42s binding = \"%s\"\n", $1, $2, $3 }'
fi
