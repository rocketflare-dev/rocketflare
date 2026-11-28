/**
 * Every tool the kit ships answers `egress` and `readsContent` (read as values, through the same
 * check a copy runs), and `pnpm plugin check`'s egress warnings (`scripts/lib/plugin-lib.mjs`):
 * from the values when the builder could be called, statically when it could not. Kit-only: it
 * pins the kit's own tool list, which a copy extends.
 */
import { describe, expect, it } from 'vitest'
import { coreToolUnit, pluginToolUnits, readToolEgress } from '@/api/services/agents/tools/egress'
import {
  declaredToolEgress,
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

  it('warns from the values, and statically only for a unit that could not be called', () => {
    const declarations = [
      { pluginId: 'gamma', file: 'g.ts', tools: declaredToolEgress(src) },
      { pluginId: 'delta', file: 'd.ts', tools: [{ name: 'delta_send', answers: false }] },
    ]
    const report = {
      tools: [
        { kind: 'plugin', unit: 'gamma', tool: 'gamma_fetch', egress: true },
        // The static read says it answers; the VALUE says it does not (a cast) — the value wins.
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
})
