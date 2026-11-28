/**
 * Every tool the kit ships answers `egress` and `readsContent` (read as values, through the same
 * check a copy runs), and `pnpm plugin check`'s egress warnings (`scripts/lib/plugin-lib.mjs`):
 * from the values when the builder could be called, statically when it could not. Kit-only: it
 * pins the kit's own tool list, which a copy extends.
 */
import { describe, expect, it } from 'vitest'
import {
  coreToolUnit,
  pluginToolUnits,
  readToolEgress,
  type ToolUnit,
} from '@/api/services/agents/tools/egress'
import type { Tool } from '@/api/services/ai/agent-loop'
import {
  declaredToolEgress,
  declaresToolBuilder,
  egressProblems,
  stringConstants,
} from '../../../../scripts/lib/plugin-lib.mjs'

/** The plugins the kit itself ships. CI also installs published plugins, which answer on their own schedule. */
const KIT_PLUGINS = new Set(['example-feature'])

describe("the kit's own tools", () => {
  it('every one answers egress and readsContent', async () => {
    const plugins = pluginToolUnits()
    const report = await readToolEgress([
      coreToolUnit(plugins),
      ...plugins.filter(u => KIT_PLUGINS.has(u.id)),
    ])
    expect(report.unreadable).toEqual([])
    expect(report.tools.length).toBeGreaterThanOrEqual(5)
    for (const t of report.tools) {
      expect(typeof t.egress, `${t.unit}:${t.tool}`).toBe('boolean')
      expect(typeof t.readsContent, `${t.unit}:${t.tool}`).toBe('boolean')
    }
    // The app's own AI providers are not outside it: knowledge search is not egress.
    expect(report.tools.find(t => t.tool === 'search_knowledge')?.egress).toBe(false)
  })
})

describe('plugin check — egress', () => {
  const src = `
    const FETCH = 'gamma_fetch'
    export const a = defineTool({ name: FETCH, description: 'x', egress: true, schema })
    export const b = defineTool({ name: 'gamma_list', description: 'y', schema })
  `

  it('reads which defineTool calls answer egress', () => {
    expect(declaredToolEgress(src, stringConstants(src))).toEqual([
      { name: 'gamma_fetch', answers: true },
      { name: 'gamma_list', answers: false },
    ])
  })

  it('warns from the values, and statically for a tool the values did not show', () => {
    const declarations = [
      { pluginId: 'gamma', file: 'g.ts', tools: declaredToolEgress(src) },
      { pluginId: 'delta', file: 'd.ts', tools: [{ name: 'delta_send', answers: false }] },
    ]
    const report = {
      tools: [
        { kind: 'plugin', unit: 'gamma', tool: 'gamma_fetch', egress: true },
        // The VALUE is what counts for a tool the builder returned (a cast can drop the key).
        { kind: 'plugin', unit: 'gamma', tool: 'gamma_list' },
        { kind: 'core', unit: 'core', tool: 'app_tool' },
      ],
      unreadable: [{ kind: 'plugin', unit: 'delta', error: 'no database' }],
    }
    const problems = egressProblems(report, declarations)
    expect(problems.map(p => `${p.severity}:${p.unit}:${p.tool}:${p.file}`)).toEqual([
      'warn:gamma:gamma_list:g.ts',
      'warn:core:app_tool:apps/web/src/api/services/agents/tools/index.ts',
      'warn:delta:delta_send:d.ts',
    ])
    expect(problems[0]?.fix).toMatch(/send your data outside your organisation/)
    expect(problems[0]?.fix).toMatch(/Never default it to false/)
  })

  it('reads every plugin statically when the value check could not run', () => {
    const problems = egressProblems(null, [
      { pluginId: 'gamma', file: 'g.ts', tools: declaredToolEgress(src) },
    ])
    expect(problems.map(p => p.tool)).toEqual(['gamma_list'])
  })

  // A builder gated on what the stub context lacks — here a configured secret, as the published
  // freeagent plugin gates on its OAuth client and a connected organisation — returns [] without
  // touching the database, so the value read shows nothing and is not "unreadable" either.
  const gatedSource = `
    const COMPANY = 'gated_company'
    const tools = (ctx) => [
      defineTool({ name: COMPANY, description: 'a', schema }),
      defineTool({ name: 'gated_search', description: 'b', schema }),
      defineTool({ name: 'gated_categories', description: 'c', schema }),
      defineTool({ name: 'gated_invoices', description: 'd', schema }),
      defineTool({ name: 'gated_bills', description: 'e', schema }),
      defineTool({ name: 'gated_create_bill', description: 'f', allowEdits: true, schema }),
    ]
  `
  const gated: ToolUnit = {
    kind: 'plugin',
    id: 'gated',
    tools: ctx =>
      (ctx.env as Record<string, unknown>).GATED_CLIENT_ID
        ? [{ name: 'gated_company' } as unknown as Tool]
        : [],
  }

  it('counts every statically defined tool a gated builder did not return', async () => {
    const report = await readToolEgress([gated])
    expect(report.tools).toEqual([])
    expect(report.unreadable).toEqual([])
    expect(report.units).toEqual([{ kind: 'plugin', unit: 'gated', builder: true, returned: 0 }])
    const declarations = [
      {
        pluginId: 'gated',
        file: 'gated-tools.ts',
        tools: declaredToolEgress(gatedSource, stringConstants(gatedSource)),
      },
    ]
    const problems = egressProblems(report, declarations)
    expect(problems.map(p => `${p.kind}:${p.unit}:${p.tool}`)).toEqual([
      'egress:gated:gated_company',
      'egress:gated:gated_search',
      'egress:gated:gated_categories',
      'egress:gated:gated_invoices',
      'egress:gated:gated_bills',
      'egress:gated:gated_create_bill',
    ])
    expect(problems[0]?.problem).toMatch(/did not return it under the stub context/)
  })

  it('a returned tool and its static declaration count once', () => {
    const report = {
      tools: [{ kind: 'plugin', unit: 'gated', tool: 'gated_company' }],
      unreadable: [],
      units: [{ kind: 'plugin', unit: 'gated', builder: true, returned: 1 }],
    }
    const problems = egressProblems(report, [
      {
        pluginId: 'gated',
        file: 'g.ts',
        tools: declaredToolEgress(gatedSource, stringConstants(gatedSource)),
      },
    ])
    expect(problems.filter(p => p.tool === 'gated_company')).toHaveLength(1)
    expect(problems).toHaveLength(6)
  })

  it('pairs an unnamed declaration with a returned tool it could not name, never more', () => {
    const tools = [
      { name: null, answers: false },
      { name: null, answers: false },
    ]
    const report = {
      tools: [{ kind: 'plugin', unit: 'u', tool: 'u_dynamic', egress: true }],
      unreadable: [],
      units: [{ kind: 'plugin', unit: 'u', builder: true, returned: 1 }],
    }
    expect(
      egressProblems(report, [{ pluginId: 'u', file: 'u.ts', tools }]).map(p => p.tool)
    ).toEqual(['?'])
  })

  it('reports a builder neither read can see into as unverifiable, never as zero', () => {
    const report = {
      tools: [],
      unreadable: [{ kind: 'plugin', unit: 'thrown', error: 'no database' }],
      units: [
        { kind: 'plugin', unit: 'gated', builder: true, returned: 0 },
        { kind: 'plugin', unit: 'thrown', builder: true, returned: null },
        { kind: 'plugin', unit: 'none', builder: false, returned: 0 },
      ],
    }
    expect(egressProblems(report, []).map(p => `${p.kind}:${p.unit}`)).toEqual([
      'egress-unverifiable:gated',
      'egress-unverifiable:thrown',
    ])
    // With no value check at all, the server entry says which plugins have a builder.
    const entry = 'export const s = { shared, tools: raw => build(raw) }'
    expect(declaresToolBuilder(entry)).toBe(true)
    expect(declaresToolBuilder('export const s = { shared, mounts }')).toBe(false)
    expect(
      egressProblems(null, [], [{ pluginId: 'gated', builder: declaresToolBuilder(entry) }]).map(
        p => `${p.kind}:${p.unit}`
      )
    ).toEqual(['egress-unverifiable:gated'])
  })
})
