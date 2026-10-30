/**
 * Fan-out inside one run: `ctx.scope(prefix)` and `ctx.map(key, items, fn, options)`.
 *
 * **A scope is a key namespace, nothing more.** Every keyed primitive — `once`, `decide` (and its
 * `sift`/`pick`), `interrupt`, `artifact`, `step` — gets `<prefix>/` in front of its key, so two
 * items can each call `ctx.decide('relevant', …)` without colliding on `(run_id, key)`. The record
 * is the run's own tables, keyed by the full path; a replay serves it by the same path.
 *
 * A scope has NO checkpoint: `agent_runs.checkpoint` is one column, and two tool loops sharing it
 * would overwrite each other's transcript. A tool loop inside a scope restarts on a retry; the
 * item-level `once` below is what stops a FINISHED item from running again.
 *
 * `map` runs each item as `ctx.once(key[itemKey], () => fn(item, ctx.scope(key[itemKey])))`:
 *   - a finished item's result is recorded, so a retried or resumed step replays it and runs only
 *     what had not finished — `fn`'s result is jsonb, so return ids and scalars;
 *   - at most `min(concurrency ?? 4, AGENT_MAP_MAX_CONCURRENCY)` items are in flight;
 *   - the first error stops scheduling, waits for the items in flight, then is thrown;
 *   - an item that asks a person (`InterruptRequested`) does NOT stop scheduling — the other items
 *     carry on, and every ask raised by the map is merged into ONE park, so a hundred approvals are
 *     one wait rather than a hundred. A real error still wins over the asks.
 *
 * No parent/child runs: everything stays inside one `execute` step, on one DB client — which is
 * also the ceiling. The step's client serialises its queries, and each concurrent model call is a
 * subrequest, so six is the cap rather than sixty.
 */
import { InterruptRequested } from '../ai/agent-loop'
import { decideWithShapes } from './decisions'
import type { AgentContext } from './registry'

export const AGENT_MAP_DEFAULT_CONCURRENCY = 4
export const AGENT_MAP_MAX_CONCURRENCY = 6
/** Between a scope's prefix and the key inside it: `screen[42]/relevant`. */
export const SCOPE_SEPARATOR = '/'

export interface MapOptions<T> {
  /** Items in flight at once; clamped to 1…{@link AGENT_MAP_MAX_CONCURRENCY}. Default 4. */
  concurrency?: number
  /**
   * The item's key inside the map — default its index. Give a stable id when the item list can
   * change between attempts (it should not: freeze it behind `ctx.once` first).
   */
  keyOf?: (item: T, index: number) => string
}

/** A context before `scope`/`map` are attached — what the runtime and replay build. */
export type BaseAgentContext<Input = unknown> = Omit<AgentContext<Input>, 'scope' | 'map'>

/** Attach `scope` and `map` to a context; every scope it hands out has them too. */
export function withFanout<Input>(base: BaseAgentContext<Input>): AgentContext<Input> {
  const ctx: AgentContext<Input> = {
    ...base,
    scope: prefix => withFanout(scoped(base, prefix)),
    map: (key, items, fn, options) => mapItems(ctx, key, items, fn, options),
  }
  return ctx
}

function scoped<Input>(base: BaseAgentContext<Input>, prefix: string): BaseAgentContext<Input> {
  if (!prefix) throw new Error('ctx.scope needs a non-empty prefix')
  const k = (key: string) => `${prefix}${SCOPE_SEPARATOR}${key}`
  return {
    ...base,
    once: (key, fn, options) => base.once(k(key), fn, options),
    interrupt: ask => base.interrupt({ ...ask, key: k(ask.key) }),
    artifact: input => base.artifact({ ...input, key: k(input.key) }),
    decide: decideWithShapes((key, request) => base.decide(k(key), request)),
    step: (key, label, status, detail) => base.step(k(key), label, status, detail),
    checkpoint: { load: async () => null, save: async () => {} },
  }
}

async function mapItems<Input, T, R>(
  ctx: AgentContext<Input>,
  key: string,
  items: readonly T[],
  fn: (item: T, scope: AgentContext<Input>) => Promise<R>,
  options: MapOptions<T> = {}
): Promise<R[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? AGENT_MAP_DEFAULT_CONCURRENCY, AGENT_MAP_MAX_CONCURRENCY)
  )
  const itemKeys = items.map((item, i) => `${key}[${options.keyOf?.(item, i) ?? i}]`)
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error(`ctx.map("${key}"): keyOf must return a different key for every item`)
  }

  const results = new Array<R>(items.length)
  const asks: { index: number; err: InterruptRequested }[] = []
  let failed = false
  let failure: unknown
  let next = 0

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      const itemKey = itemKeys[index] as string
      try {
        await ctx.checkCancelled()
        results[index] = await ctx.once(
          itemKey,
          () => fn(items[index] as T, ctx.scope(itemKey)),
          // Replay runs the item again and serves what is recorded INSIDE it — the item's
          // own result is a cache, and serving it would hide every change to `fn`.
          { replay: 'inner' }
        )
      } catch (err) {
        if (err instanceof InterruptRequested) asks.push({ index, err })
        else if (!failed) {
          failed = true
          failure = err
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))

  if (failed) throw failure
  if (asks.length > 0) {
    asks.sort((a, b) => a.index - b.index)
    throw new InterruptRequested(asks.flatMap(a => a.err.requests))
  }
  return results
}
