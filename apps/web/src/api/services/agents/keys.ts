/**
 * Key safety for the run's records. Every keyed primitive — `ctx.once`, the tool loop's journal —
 * finds an earlier attempt's work by its key, so the one bug it cannot survive is two DIFFERENT
 * calls sharing a key in the same attempt: the second silently gets the first one's result.
 *
 *   for (const q of queries) await ctx.once('search', () => search(q))   // three times query 1
 *
 * Two rules close it. `ctx.once(label, fn, { inputs })` keys on the label plus a hash of `inputs`,
 * so the loop above, written with `{ inputs: q }`, is three keys. And a key used twice in one
 * attempt throws {@link EffectKeyConflictError} rather than answering from the record — across
 * attempts, the same key is exactly how a retry finds its result.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { hashToken } from '../../utils/core/hash'
import { stableStringify } from '../../utils/core/stable-stringify'

/** A keyed call reused a key already used by another call in this attempt. Never retried. */
export class EffectKeyConflictError extends Error {
  readonly code = ERROR_CODES.agentEffectKeyConflict
  constructor(
    readonly primitive: 'once' | 'tool loop',
    readonly key: string
  ) {
    super(
      primitive === 'once'
        ? `ctx.once("${key}") was called twice in one attempt. Give each call its own key, or pass { inputs } so the key carries what differs between them.`
        : `Two tool loops used the journal key "${key}" in one attempt. Pass each runToolLoop its own key.`
    )
    this.name = 'EffectKeyConflictError'
  }
}

/**
 * The recorded key for `ctx.once(label, fn, { inputs })`: the label alone without `inputs`, else
 * `label#<hash>` over the inputs as jsonb would store them (key order fixed, `undefined` dropped).
 */
export async function effectKey(label: string, inputs?: unknown): Promise<string> {
  if (inputs === undefined) return label
  const canonical = stableStringify(JSON.parse(JSON.stringify(inputs ?? null)))
  return `${label}#${(await hashToken(canonical)).slice(0, 12)}`
}

/** One attempt's set of used keys: `claim(key)` throws on the second use. */
export function attemptKeys(primitive: EffectKeyConflictError['primitive']) {
  const used = new Set<string>()
  return {
    claim(key: string): void {
      if (used.has(key)) throw new EffectKeyConflictError(primitive, key)
      used.add(key)
    },
  }
}
