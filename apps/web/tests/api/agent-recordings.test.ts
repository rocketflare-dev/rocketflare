// @vitest-isolate
// Replays committed run recordings through the real registry — isolated so no other file's agent
// swaps leak into what is replayed.
/**
 * The gate's version check (D44 phase 3): every recording in `tests/agent-recordings/` — a settled
 * run written by `pnpm web agent:replay <agent> --tenant <slug> --record tests/agent-recordings` —
 * is replayed STRICTLY against today's code. When the run's `meta.version` is still the agent's
 * and today's code asks its `once` / `decide` / `interrupt` keys in another order, asks a new one,
 * or stops asking one, the gate fails with "bump `meta.version`": a run in flight would otherwise
 * resume under code that reads its record differently, and no `onVersionChange` would see it.
 * A recording of an OLDER version is expected to drift and is skipped. Output and model-turn
 * changes are not checked here: a prompt edit changes answers and needs no bump — and a recorded
 * turn reports `drift` here anyway, because the system prompt names the tenant and this replay
 * runs in a test tenant (strict replay still answers it from the recording).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getAgent, isAgentKey } from '@/api/services/agents/registry'
import {
  parseRunRecording,
  type ReplayResult,
  recordingRunRow,
  replayRun,
  versionBumpNeeded,
} from '@/api/services/agents/replay'
import { agentVersionOf } from '@/api/services/agents/runs'
import type { RuntimeEnv } from '@/api/services/agents/runtime'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const DIR = join(__dirname, '..', 'agent-recordings')
// A copy that removed the example agents may have no recordings left, or no folder at all.
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.json')) : []
const logger = (() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger
})()

describe('recorded runs still replay under their meta.version', () => {
  it.skipIf(files.length > 0)(
    'has no recordings yet (record one with agent:replay --record)',
    () => {}
  )

  for (const file of files) {
    it(file, async () => {
      const recording = parseRunRecording(readFileSync(join(DIR, file), 'utf8'))
      // A recording of an agent this copy no longer has is not a failure of the code that is here.
      if (!isAgentKey(recording.agentKey)) return
      const agent = getAgent(recording.agentKey)
      const env = createTestEnv()
      const role = (recording.run.requesterRole ?? 'member') as 'owner' | 'admin' | 'member'
      const { tenant, user } = await createTestTenantWithUser(db, role)
      const result = await replayRun(
        db,
        loadConfig(env),
        env as unknown as RuntimeEnv,
        recordingRunRow(recording, tenant.id, recording.run.requesterRole ? user.id : null),
        agent,
        { logger, rows: recording.rows }
      )
      const problem = versionBumpNeeded(recording, agentVersionOf(agent.meta), result)
      expect(problem, problem ?? '').toBeNull()
    })
  }
})

describe('versionBumpNeeded', () => {
  const recording = { agentKey: 'a', agentVersion: 2 } as Parameters<typeof versionBumpNeeded>[0]
  const clean = { misses: [], decisions: [] } as unknown as ReplayResult

  it('passes a run whose keys did not move, and any recording of an older version', () => {
    expect(versionBumpNeeded(recording, 2, clean)).toBeNull()
    const moved = {
      ...clean,
      orderDrift: { recorded: ['once:a', 'once:b'], replayed: ['once:b', 'once:a'] },
    }
    expect(versionBumpNeeded(recording, 3, moved)).toBeNull()
  })

  it('fails a moved, new or dropped key at the same version — and says to bump', () => {
    const moved = {
      ...clean,
      orderDrift: { recorded: ['once:a', 'once:b'], replayed: ['once:b', 'once:a'] },
    }
    expect(versionBumpNeeded(recording, 2, moved)).toMatch(/bump `meta\.version`/)
    const added = {
      ...clean,
      misses: [{ kind: 'once', key: 'new-step' }],
    } as unknown as ReplayResult
    expect(versionBumpNeeded(recording, 2, added)).toContain('new once key "new-step"')
    const dropped = {
      ...clean,
      decisions: [{ key: 'route', status: 'unused' }],
    } as unknown as ReplayResult
    expect(versionBumpNeeded(recording, 2, dropped)).toContain('no longer asked: decide:route')
    // A model or tool miss is a prompt / tool-output matter, not a key one.
    const chat = {
      ...clean,
      misses: [{ kind: 'chat', key: 'tool-loop turn 1' }],
    } as unknown as ReplayResult
    expect(versionBumpNeeded(recording, 2, chat)).toBeNull()
  })
})
