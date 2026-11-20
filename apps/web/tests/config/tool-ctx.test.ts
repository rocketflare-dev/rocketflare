/**
 * `toolCtx` — what a plugin's tool builder is handed — answers from what the caller already
 * resolved: the requester as given (null for a run nobody started), and the caller's flags
 * without a query when it has them. `db` here is an empty object, so any query would throw.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { toolCtx } from '@/plugins/api'
import { createTestEnv } from '../mocks/bindings'

const env = createTestEnv()
const cfg = loadConfig(env)
const db = {} as Database
const scope = { tenantId: 't-1', userId: 'u-1', groupIds: ['g-1'], bypass: false }

describe('toolCtx', () => {
  it("answers the caller's own flags without reading the tenant's", async () => {
    const ctx = toolCtx({ db, cfg, env, scope, features: ['knowledge-facts'] })
    expect(await ctx.features()).toEqual(['knowledge-facts'])
  })

  it('passes the requester through, and is null without one', () => {
    const requester = {
      userId: 'u-1',
      role: 'member' as const,
      isAdmin: false,
      groups: [{ id: 'g-1', name: 'Finance', typeName: 'Department' }],
    }
    expect(toolCtx({ db, cfg, env, scope, requester }).requester).toEqual(requester)
    expect(toolCtx({ db, cfg, env, scope }).requester).toBeNull()
  })
})
