/**
 * `pnpm web agent:replay` runs the agent registry under plain Node through tsx — so nothing
 * the registry imports may reach `cloudflare:workers` (the Workflow class, the Durable Object),
 * which exists only inside workerd. That is an import-graph property no type check sees; loading
 * the script is the proof. `--help` exits before any database is touched.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB = fileURLToPath(new URL('../..', import.meta.url))

describe('agent:replay script', () => {
  it('imports under Node and prints its usage', () => {
    const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/agent-replay.ts', '--help'], {
      cwd: WEB,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    })
    expect(run.stderr).toContain('usage: pnpm web agent:replay')
    expect(run.stderr).not.toMatch(/cloudflare:workers|ERR_/)
    expect(run.status).toBe(2)
  })
})
