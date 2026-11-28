---
breaking: false
migrations: []
areas: [api, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The agent-run sweep (`sweepLostRuns`, `sendReminders`) now runs hourly at `16 * * * *` instead of every 10 minutes, so an idle Neon compute can suspend between sweeps instead of waking six times an hour.

- `[triggers] crons` in both tomls: `"*/10 * * * *"` → `"16 * * * *"`; `scheduled.ts` registers the two tasks under the new expression. :16 shares the compute wake of the analytics plugin's `15 * * * *` without sharing its expression.
- A lost run is now settled, and a HITL reminder or `onTimeout: 'reject'` applied, up to an hour late rather than up to 10 minutes. `SWEEP_STALE_MS` (10 minutes idle) and `SWEEP_BATCH` (100 per sweep) are unchanged.

## How to apply

- In BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, replace `"*/10 * * * *"` in `[triggers] crons` with `"16 * * * *"`, and in `apps/web/src/api/scheduled.ts` change the `'*/10 * * * *'` key of `CORE_SCHEDULED_TASKS` to `'16 * * * *'`. The toml expression and the key must match, or the sweep never runs.
- A copy that relies on faster settling or reminders may keep `*/10 * * * *` (or any cadence): skip this note, at the cost of keeping its Neon compute awake.
- If an agent sets `meta.hitl.timeout` with `onTimeout: 'reject'`, keep it at least an hour shorter than `AGENT_INTERRUPT_TIMEOUT`.

## Conflicts to expect

- `[triggers] crons` in both tomls if you added crons of your own: keep yours, swap only the `*/10` line.

## Verify

- `pnpm test config` passes (toml parity).
- `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=16+*+*+*+*"` logs `sweepLostRuns` while `pnpm dev` is running.
