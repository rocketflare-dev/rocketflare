/**
 * The `egress` value check: can each tool send this organisation's data outside it?
 *
 * A type check cannot answer that. A unit's tools exist only once its `tools(ctx)` is CALLED, and
 * `as Tool` / `as Tool[]` casts are common, so a cast object literal compiles without the field.
 * This module calls every unit's builder with a stub context — every flag on, every permission
 * granted, so each builder hands back its largest set — and reads `egress` off the values it
 * returns. `pnpm plugin check` (through `scripts/tool-egress.ts`) and the gate's config test both
 * run it, and both only WARN for a tool with no answer for now; it becomes required later.
 *
 * Unit-agnostic on purpose: a unit is anything with an id and a `tools(ctx)` — the kit's own tool
 * list (plus whatever an app appends in `buildAgentTools`) and each installed plugin today, and
 * any other kind of unit that contributes tools tomorrow.
 *
 * The stub context has NO database: any query a builder makes throws, and that unit is reported
 * as unreadable rather than guessed at. A builder that reads a settings row before it builds
 * (to return `[]` for an organisation that has not turned it on) is unreadable here, and
 * `plugin check` falls back to reading its `defineTool({ … })` calls statically.
 */
import { FEATURE_KEYS } from '@rocketflare/shared/features'
import { loadConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { AnyServerPlugin } from '../../../../plugins/server'
import { serverPlugins } from '../../../../plugins/server'
import type { Tool } from '../../ai/agent-loop'
import type { AiEnv } from '../../ai/types'
import { buildAgentTools, pluginTools } from './index'
import type { AgentToolContext } from './search-knowledge'

/** Something that contributes tools: the kit's own list, a plugin, or any later kind of unit. */
export interface ToolUnit {
  kind: string
  id: string
  tools(ctx: AgentToolContext): Tool[] | Promise<Tool[]> | undefined
}

/** One tool as the check read it. */
export interface ToolEgressEntry {
  kind: string
  unit: string
  tool: string
  egress: boolean | undefined
  readsContent: boolean | undefined
}

/** A unit whose builder threw under the stub context, so its tools could not be read. */
export interface UnreadableToolUnit {
  kind: string
  unit: string
  error: string
}

export interface ToolEgressReport {
  tools: ToolEgressEntry[]
  unreadable: UnreadableToolUnit[]
}

/** What a builder sees when it touches the stub's database. */
export class StubDatabaseError extends Error {
  constructor() {
    super('the egress check builds tools with no database')
    this.name = 'StubDatabaseError'
  }
}

const STUB_TENANT = '00000000-0000-4000-8000-000000000001'
const STUB_USER = '00000000-0000-4000-8000-000000000002'

/** A database whose every member throws: a builder that queries is unreadable, never guessed. */
function noDatabase(): Database {
  return new Proxy({} as Database, {
    get() {
      throw new StubDatabaseError()
    },
  })
}

/**
 * The context every builder is called with: an owner who may do anything, every feature flag on
 * and no database, so each builder returns the most it ever would without reading a row.
 */
export function stubToolContext(): AgentToolContext {
  // Only what the config schema requires; no binding, so a builder reaching for one gets nothing.
  const env = {
    APP_ENV: 'development',
    APP_URL: 'http://localhost',
    APP_NAME: 'egress check',
    LOG_LEVEL: 'silent',
  }
  return {
    db: noDatabase(),
    cfg: loadConfig(env),
    env: env as unknown as AiEnv,
    scope: { tenantId: STUB_TENANT, userId: STUB_USER, groupIds: [], bypass: true },
    can: () => true,
    features: [...FEATURE_KEYS],
    requesterUrls: new Set<string>(),
    requester: { userId: STUB_USER, role: 'owner', isAdmin: true, groups: [] },
  }
}

/** One unit per installed plugin, read through the same `tools` / `agentTools` the host calls. */
export function pluginToolUnits(
  plugins: readonly Pick<AnyServerPlugin, 'shared' | 'tools' | 'agentTools'>[] = serverPlugins
): ToolUnit[] {
  return plugins.map(p => ({
    kind: 'plugin',
    id: p.shared.id,
    tools: ctx => pluginTools(p, ctx),
  }))
}

/**
 * The kit's own tools: everything `buildAgentTools` returns that no other unit contributed — the
 * core knowledge tools and whatever the app appends there. Pass the other units so their tools
 * are not counted twice.
 */
export function coreToolUnit(others: readonly ToolUnit[]): ToolUnit {
  return {
    kind: 'core',
    id: 'core',
    tools: async ctx => {
      const theirs = new Set<string>()
      for (const unit of others) {
        try {
          for (const tool of (await unit.tools(ctx)) ?? []) theirs.add(tool.name)
        } catch {
          // reported against that unit by readToolEgress
        }
      }
      return (await buildAgentTools(ctx)).filter(tool => !theirs.has(tool.name))
    },
  }
}

/** Every unit installed here: the kit's own list, then each plugin. */
export function installedToolUnits(): ToolUnit[] {
  const plugins = pluginToolUnits()
  return [coreToolUnit(plugins), ...plugins]
}

/** Call each unit's builder with `ctx` and read `egress` / `readsContent` off what it returns. */
export async function readToolEgress(
  units: readonly ToolUnit[],
  ctx: AgentToolContext = stubToolContext()
): Promise<ToolEgressReport> {
  const report: ToolEgressReport = { tools: [], unreadable: [] }
  for (const unit of units) {
    let tools: Tool[]
    try {
      tools = (await unit.tools(ctx)) ?? []
    } catch (err) {
      report.unreadable.push({
        kind: unit.kind,
        unit: unit.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    for (const tool of tools) {
      report.tools.push({
        kind: unit.kind,
        unit: unit.id,
        tool: tool.name,
        egress: typeof tool.egress === 'boolean' ? tool.egress : undefined,
        readsContent: typeof tool.readsContent === 'boolean' ? tool.readsContent : undefined,
      })
    }
  }
  return report
}

/** The tools with no `egress` answer — what the check warns about. */
export function missingEgress(report: ToolEgressReport): ToolEgressEntry[] {
  return report.tools.filter(t => t.egress === undefined)
}
