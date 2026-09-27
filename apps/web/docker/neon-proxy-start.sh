#!/bin/bash
# Entrypoint for the local Neon proxy (D35), replacing the image's own start.sh so the proxy can be
# tuned for a laptop. Mounted by docker-compose.{dev,test}.yml; the image is pinned by digest, so
# the binaries and flags below are the ones this was written against.
#
# Three changes from the image's start.sh, all about speed. Real Neon has none of these costs:
#   1. The `postgres` auth backend caches no role secrets, so EVERY HTTP query costs a SCRAM
#      exchange plus two fresh backend logins — ~70 ms at Postgres's default 4096 rounds, for
#      ~0.3 ms of query. Re-hashing this throwaway local role's (unchanged) password with ONE round
#      brings it to ~8 ms.
#   2. `--endpoint-rps-limit`: the default (500/s, 300/min, 200/10 min per endpoint) is Neon's
#      cloud abuse guard; a parallel test suite hits it and gets "Too many connections to this
#      endpoint". Raised far past anything local.
#   3. `--sql-over-http-pool-opt-in false`: pool backend connections for every HTTP query, not only
#      for clients that send `Neon-Pool-Opt-In` (the driver does so only for `-pooler` hosts).
set -uo pipefail
trap 'kill -TERM $(jobs -p) 2>/dev/null' TERM

if [ -z "${PG_CONNECTION_STRING:-}" ]; then
  echo "PG_CONNECTION_STRING is not set"
  exit 1
fi

psql -Atq "$PG_CONNECTION_STRING" \
  -c "CREATE SCHEMA IF NOT EXISTS neon_control_plane" \
  -c "CREATE TABLE IF NOT EXISTS neon_control_plane.endpoints (endpoint_id VARCHAR(255) PRIMARY KEY, allowed_ips VARCHAR(255))"

if [ -n "${PROXY_ROLE_PASSWORD:-}" ]; then
  psql -Atq "$PG_CONNECTION_STRING" -v pw="$PROXY_ROLE_PASSWORD" <<'SQL'
SET scram_iterations = 1;
ALTER ROLE CURRENT_USER PASSWORD :'pw';
SQL
fi

./neon-proxy \
  -c server.pem \
  -k server.key \
  --auth-backend=postgres \
  --auth-endpoint="$PG_CONNECTION_STRING" \
  --wss=0.0.0.0:4445 \
  --endpoint-rps-limit 1000000@1s \
  --endpoint-rps-limit 1000000@1m \
  --endpoint-rps-limit 1000000@10m \
  --sql-over-http-pool-opt-in false \
  &

caddy run --config ./Caddyfile --adapter caddyfile &

wait
