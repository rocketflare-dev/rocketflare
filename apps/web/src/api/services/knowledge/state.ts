/**
 * Deciding a new fact's state against what is already held for the same entity and key (D43,
 * decision 3). Pure: `decideFactState` reads the candidate and the held facts and says what to
 * write — the extraction job applies it.
 *
 * | Compared with each held fact (accepted · unconfirmed · conflicting) | Result |
 * |---|---|
 * | nothing held | `accepted` when confidence ≥ `ACCEPT_CONFIDENCE`, else `unconfirmed` |
 * | the same value (`valueKey`) | corroboration: the new fact is `accepted`, and a held `unconfirmed` one becomes `accepted` |
 * | a different value, both with validity windows that do NOT overlap | a change over time, not a disagreement: the one whose window is EARLIER becomes `superseded` (`supersededById` = the later) |
 * | a different value otherwise | `conflicting` on both, `conflictsWith` linked both ways |
 *
 * A new fact compared with several held ones takes the strongest outcome: `conflicting` if it
 * conflicts with any, else `superseded` if a held window is later than its own, else `accepted`
 * when corroborated or confident, else `unconfirmed` — replacing an older value over time does not
 * by itself make a doubtful reading sure.
 *
 * Which side of a conflict an answer leads with is NOT decided here and never stored: it is
 * `preferredFact` (`@rocketflare/shared/ai/knowledge-facts`) over the facts' document dates and
 * trust — newer and at least as trusted wins, else the older.
 */
import type { FactState } from '@rocketflare/shared/ai/knowledge-facts'

/** At or above it a fact nobody contradicts is `accepted`; below, `unconfirmed` (a review item). */
export const ACCEPT_CONFIDENCE = 0.7

export interface Validity {
  validFrom: Date | null
  validTo: Date | null
}

export interface HeldFact extends Validity {
  id: string
  state: FactState
  valueKey: string
}

export interface CandidateFact extends Validity {
  valueKey: string
  confidence: number
}

export interface StateDecision {
  state: FactState
  /** Held facts this one disagrees with: both sides become `conflicting`, linked both ways. */
  conflictsWith: string[]
  /** Held facts this one replaces over time: they become `superseded` by it. */
  supersedes: string[]
  /** The held fact with a later window that replaces THIS one (state `superseded`), or null. */
  supersededBy: string | null
  /** Held `unconfirmed` facts this one corroborates: they become `accepted`. */
  confirms: string[]
}

const hasWindow = (v: Validity) => v.validFrom !== null || v.validTo !== null
const lo = (v: Validity) => v.validFrom?.getTime() ?? Number.NEGATIVE_INFINITY
const hi = (v: Validity) => v.validTo?.getTime() ?? Number.POSITIVE_INFINITY

/**
 * -1 when `a`'s window ends before `b`'s starts, 1 for the reverse, 0 when they overlap or either
 * side carries no window at all (no window = "true as far as this source says", which overlaps
 * everything).
 */
export function windowOrder(a: Validity, b: Validity): -1 | 0 | 1 {
  if (!hasWindow(a) || !hasWindow(b)) return 0
  if (hi(a) < lo(b)) return -1
  if (hi(b) < lo(a)) return 1
  return 0
}

export function decideFactState(
  candidate: CandidateFact,
  held: readonly HeldFact[]
): StateDecision {
  const decision: StateDecision = {
    state: 'accepted',
    conflictsWith: [],
    supersedes: [],
    supersededBy: null,
    confirms: [],
  }
  let corroborated = false
  for (const fact of held) {
    if (fact.valueKey === candidate.valueKey) {
      corroborated = true
      if (fact.state === 'unconfirmed') decision.confirms.push(fact.id)
      continue
    }
    const order = windowOrder(fact, candidate)
    if (order === -1) decision.supersedes.push(fact.id)
    else if (order === 1) decision.supersededBy ??= fact.id
    else decision.conflictsWith.push(fact.id)
  }
  if (decision.conflictsWith.length > 0) decision.state = 'conflicting'
  else if (decision.supersededBy) decision.state = 'superseded'
  else if (corroborated) decision.state = 'accepted'
  else decision.state = candidate.confidence >= ACCEPT_CONFIDENCE ? 'accepted' : 'unconfirmed'
  return decision
}
