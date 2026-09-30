# The driver conformance suite

This directory proves the driver seam (`src/db/CLAUDE.md`): app code behaves the same under
`postgres` and `neon`. `pnpm test` runs it twice on a local target (postgres, then neon through the
local proxy) and once under neon on a remote Neon gate branch. It ships to every copy.

- **Each test states ONE equivalence** and passes **unchanged** under both drivers: the same
  input, the same expected value.
- **No `skip`, `skipIf`, `runIf`, `todo` or `only`, and no branching on the driver inside a
  test.** `tests/config/driver-conformance.test.ts` fails all of them. Module-level setup may pick
  what to dial per driver (`unreachable.test.ts` does); an expectation may not.
- **A test that fails under one driver means the seam has a hole.** Fix `src/db/client.ts`
  (normalise it) or `tests/config/driver-results.test.ts` (ban the pattern). Never weaken the
  test to match one driver's behaviour.
- **Everything goes through `openDatabase`**, the Worker's own path (neon-http for queries, the
  WebSocket pool for transactions), never the pool-only handle scripts and fixtures get. Probe
  both a plain query and the same thing inside `db.transaction(…)`, because under `neon` those are
  two different clients.

Running one driver by hand:

```bash
pnpm web test:driver                                   # postgres
pnpm web test:db:up:neon && DATABASE_DRIVER=neon NEON_LOCAL_PROXY=http://localhost:4433 pnpm web test:driver
```
