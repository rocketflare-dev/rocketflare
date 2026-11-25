/**
 * `ServerPlugin.knowledgeSources` (the PLATFORM sources the kit's `search_knowledge` tool also
 * covers) — the pure union over a FIXTURE plugin list, so the rule holds in a kit with no plugin
 * declaring the slot: deduplicated in plugin order, async answers awaited, a throwing builder
 * reported and skipped, an unnamespaced or `kit:` source reported and dropped.
 */
import { describe, expect, it } from 'vitest'
import { fullAccessScope } from '@/api/services/access'
import { pluginKnowledgeSources } from '@/api/services/agents/tools'
import type { AnyServerPlugin } from '@/plugins/types'

type Fixture = Pick<AnyServerPlugin, 'shared' | 'knowledgeSources'>
const plugin = (id: string, knowledgeSources?: Fixture['knowledgeSources']): Fixture =>
  ({ shared: { id }, knowledgeSources }) as Fixture

describe('pluginKnowledgeSources', () => {
  it('unions, dedupes, skips a throw and drops an unnamespaced source', async () => {
    const errors: string[] = []
    const scope = fullAccessScope(crypto.randomUUID())
    const seen: unknown[] = []
    const sources = await pluginKnowledgeSources(
      [
        plugin('guide', s => {
          seen.push(s)
          return ['guide:page', 'guide:faq']
        }),
        plugin('search', async () => ['guide:page', 'search:help', 'nonamespace', 'kit:docs']),
        plugin('broken', () => {
          throw new Error('boom')
        }),
        plugin('silent'),
      ],
      scope,
      (id, err) => errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    )
    expect(sources).toEqual(['guide:page', 'guide:faq', 'search:help'])
    expect(seen).toEqual([scope])
    expect(errors).toEqual([
      'search: not a namespaced source: "nonamespace"',
      'search: not a namespaced source: "kit:docs"',
      'broken: boom',
    ])
  })
})
