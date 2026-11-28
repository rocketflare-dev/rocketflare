/**
 * The `egress` value check (`src/api/services/agents/tools/egress.ts`): every unit's `tools(ctx)`
 * is CALLED with a stub context and `egress` is read off the values it returns, so an `as Tool`
 * cast cannot hide a missing answer. For now a missing answer is a WARNING — printed here, so the
 * gate shows it, and raised by `pnpm plugin check` — never a failure.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  coreToolUnit,
  installedToolUnits,
  missingEgress,
  pluginToolUnits,
  readToolEgress,
  type ToolUnit,
} from '@/api/services/agents/tools/egress'
import type { Tool } from '@/api/services/ai/agent-loop'

const WEB = fileURLToPath(new URL('../..', import.meta.url))

const cast = (name: string, extra: Record<string, unknown> = {}): Tool =>
  ({ name, description: name, schema: z.object({}), ...extra }) as Tool

describe('egress value check', () => {
  it('warns (never fails) for every installed tool without an egress answer', async () => {
    const report = await readToolEgress(installedToolUnits())
    // Straight to stderr, not console.warn: Vitest drops a passing test's console output under
    // its agent reporter, so a coding agent running the gate would never see the warnings.
    const say = (line: string) => process.stderr.write(`${line}\n`)
    for (const t of missingEgress(report)) {
      say(
        `warn: ${t.kind} ${t.unit}: the tool "${t.tool}" has no \`egress\` answer — can it send ` +
          "this organisation's data outside it? (.claude/rules/tools.md)"
      )
    }
    for (const u of report.unreadable) {
      say(`note: ${u.kind} ${u.unit}: tools(ctx) could not be called (${u.error})`)
    }
    expect(report.tools.some(t => t.unit === 'core' && t.tool === 'search_knowledge')).toBe(true)
  })

  it('reads the VALUE: a tool cast with `as Tool` and no egress is reported', async () => {
    const units: ToolUnit[] = [
      {
        kind: 'domain',
        id: 'sales',
        tools: () => [cast('sales_find'), cast('sales_email', { egress: true })],
      },
    ]
    const report = await readToolEgress(units)
    expect(missingEgress(report).map(t => `${t.kind}:${t.unit}:${t.tool}`)).toEqual([
      'domain:sales:sales_find',
    ])
    expect(report.tools.find(t => t.tool === 'sales_email')?.egress).toBe(true)
  })

  it('calls the builder with every flag on, every permission granted and no database', async () => {
    let seen: { features?: readonly string[]; can: boolean } | null = null
    const units: ToolUnit[] = [
      {
        kind: 'plugin',
        id: 'gamma',
        tools: ctx => {
          seen = { features: ctx.features, can: ctx.can?.('manage', 'all') ?? false }
          return []
        },
      },
      {
        kind: 'plugin',
        id: 'delta',
        tools: async ctx => {
          await ctx.db.select()
          return [cast('delta_x', { egress: false })]
        },
      },
    ]
    const report = await readToolEgress(units)
    expect(seen).toMatchObject({ can: true, features: expect.arrayContaining(['knowledge-facts']) })
    // A builder that queries is UNREADABLE, never guessed — `plugin check` reads it statically.
    expect(report.unreadable).toEqual([
      { kind: 'plugin', unit: 'delta', error: expect.stringMatching(/no database/) },
    ])
    expect(report.tools).toEqual([])
  })

  it('attributes to core only what no other unit contributed', async () => {
    const plugin: ToolUnit = { kind: 'plugin', id: 'p', tools: () => [cast('p_tool')] }
    const report = await readToolEgress([coreToolUnit([plugin]), plugin])
    expect(report.tools.filter(t => t.unit === 'core').map(t => t.tool)).not.toContain('p_tool')
    expect(pluginToolUnits([]).length).toBe(0)
  })

  it('runs under plain Node through tsx and prints one JSON document', () => {
    const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tool-egress.ts'], {
      cwd: WEB,
      encoding: 'utf8',
    })
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as { tools: { tool: string }[]; unreadable: unknown[] }
    expect(report.tools.map(t => t.tool)).toContain('get_document')
  })
})
