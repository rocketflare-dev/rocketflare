// @vitest-isolate
// Mocks the provider seam (`ai/resolve`) and the entity-type registry, so it needs its own registry.
/**
 * What a chat endpoint sends back for a fact is bounded before extraction reads it: a value, its
 * wording or a validity date longer than `MAX_CANDIDATE_TEXT_CHARS` is dropped as a bad value or
 * a bad date, at a cost that does not grow with its length, and the section's other facts are
 * still written.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ingestText } from '@/api/services/ai/ingest'
import { setTenantOverride } from '@/api/services/features'
import { extractDocumentFacts } from '@/api/services/knowledge/extract'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { loadConfig } from '@/config'
import { FakeChatClient } from '../../helpers/ai'
import { createTestTenantWithUser } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { createTestEnv } from '../../mocks/bindings'

const state: { client: FakeChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  const { AiNotConfiguredError } = await import('@/api/services/ai/errors')
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiNotConfiguredError('chat')
      return {
        client: state.client,
        provider: 'openai',
        model: 'test-model',
        source: 'tenant',
        billedToPlatform: false,
        maxOutputTokens: 4096,
      }
    }),
    resolveDecisions: vi.fn(async () => {
      throw new AiNotConfiguredError('chat')
    }),
  }
})

const customer: EntityTypeRegistration = {
  type: 'customer',
  label: 'Customer',
  facts: z.object({
    monthly_fee_gbp: z.number(),
    has_support: z.boolean(),
    plan: z.string(),
  }),
}
vi.mock('@/api/services/knowledge/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/knowledge/registry')>()
  return { ...actual, knowledgeEntityTypes: () => [customer] }
})

const db = setupTestDatabase()
const TEXT = '# Harbour Bakery\n\nMonthly Fee: £285 per month.\nSupport is included.\nPlan: Gold.'
const RUN = 100_000

describe('a long string in a submitted fact', () => {
  it('is dropped quickly, and the section keeps its other facts', async () => {
    const env = createTestEnv()
    const cfg = loadConfig(env)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await setTenantOverride(db, 'knowledge-facts', tenant.id, true, user.id)
    const { document } = await ingestText(
      db,
      cfg,
      env,
      { tenantId: tenant.id, userId: user.id, title: 'Harbour Bakery', text: TEXT },
      { jobs: env.JOBS_QUEUE }
    )
    const fact = (over: Record<string, unknown>) => ({
      entityType: 'customer',
      entityName: 'Harbour Bakery',
      confidence: 0.9,
      ...over,
    })
    state.client = new FakeChatClient([
      {
        toolUses: [
          {
            name: 'submit_facts',
            input: {
              facts: [
                fact({
                  key: 'monthly_fee_gbp',
                  value: 285,
                  quote: 'Monthly Fee: £285 per month.',
                  validFrom: `${'.'.repeat(RUN)}x`,
                }),
                fact({
                  key: 'has_support',
                  value: `x${'.'.repeat(RUN)}y`,
                  quote: 'Support is included.',
                }),
                fact({
                  key: 'plan',
                  value: ['(', '('.repeat(RUN)],
                  valueText: `1${'1'.repeat(RUN)}st`,
                  quote: 'Plan: Gold.',
                }),
                fact({ key: 'plan', value: 'Gold', quote: 'Plan: Gold.' }),
              ],
            },
          },
        ],
      },
    ])
    const started = performance.now()
    const report = await extractDocumentFacts(
      db,
      cfg,
      env,
      { tenantId: tenant.id, documentId: document.id },
      { jobs: env.JOBS_QUEUE }
    )
    const elapsed = performance.now() - started
    expect(report.dropped).toMatchObject({ bad_date: 1, bad_value: 2 })
    expect(report.factIds).toHaveLength(1)
    // The whole run, database round trips included: about 50 ms here, against seconds when the
    // strings reach the coercion regexes.
    expect(elapsed).toBeLessThan(1000)
  })
})
