/**
 * `listAgents()` from `@/plugins/api`: the agent catalogue a plugin may list or search — every
 * registered agent as `{ key, title, description }`, the same set `GET /api/agents` serves, and
 * nothing more (no schemas, no prompt keys).
 */
import { describe, expect, it } from 'vitest'
import { listAgentInfo } from '@/api/services/agents/registry'
import { listAgents } from '@/plugins/api'

describe('listAgents', () => {
  it('lists every registered agent by key, title and description only', async () => {
    const agents = await listAgents()
    expect(agents.map(a => a.key).sort()).toEqual(
      listAgentInfo()
        .map(a => a.key)
        .sort()
    )
    for (const a of agents) {
      expect(Object.keys(a).sort()).toEqual(['description', 'key', 'title'])
    }
  })
})
