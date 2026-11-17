/**
 * Chat over planted conflicts (D43): one `EvalCase` per conflicted entity and key of a corpus's
 * `conflicts.jsonl`, asking the question a person would ask about that key, with a rubric that the
 * answer gives EVERY value the documents state for it, each with its source, and says they
 * disagree (or that one replaced the other) — never one value silently. The decision is
 * "review never blocks retrieval" (`docs/CONCEPTS.md` §9, "Knowledge facts"): a
 * conflict is used, labelled, and both sides cited.
 *
 * Pure: the cases come from the answer keys alone (`facts.jsonl` for each side's value and
 * document, the docs' titles and dates), so they are unit-tested in `tests/conflict-chat.test.ts`
 * and stay in step with the fixture by construction.
 */
import { type EvalCase, evalCaseSchema } from '@rocketflare/shared/ai/evals'
import type { Corpus, PlantedFact } from './corpus'

/** The question for a key, `{entity}` substituted. A key with none gets the generic one. */
const QUESTIONS: Record<string, string> = {
  price_gbp: 'How much do we charge for {entity}?',
  monthly_fee_gbp: 'What is the monthly fee for {entity}?',
  gritting_included: 'Is winter gritting included for {entity}?',
  account_manager: "Who is {entity}'s account manager?",
  primary_contact: 'Who is our main contact at {entity}?',
  contact_email: 'What email address do we use for our contact at {entity}?',
  contact_phone: 'What is the phone number for {entity}?',
  contract_renewal_date: "When does {entity}'s contract renew?",
  payment_terms_days: "What are {entity}'s payment terms?",
  visit_day: 'Which day is the routine visit at {entity}?',
  lead_time_days: "What is {entity}'s delivery lead time?",
  minimum_order_gbp: 'What is the minimum order from {entity}?',
}

const GENERIC = 'What do our documents say about {entity}: {key}?'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function render(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.map(render).join(', ')
  return String(value)
}

export interface ConflictSide {
  value: string
  docs: { id: string; title: string; date: string }[]
}

/** The distinct values the planted facts on one conflicted key give, each with its documents. */
export function conflictSides(corpus: Corpus, entity: string, key: string): ConflictSide[] {
  const ids = new Set(
    corpus.conflicts.filter(c => c.entity === entity && c.key === key).flatMap(c => [c.a, c.b])
  )
  const facts = corpus.facts.filter(f => ids.has(f.id))
  const byValue = new Map<string, PlantedFact[]>()
  for (const f of facts) {
    const v = render(f.value)
    byValue.set(v, [...(byValue.get(v) ?? []), f])
  }
  const docOf = new Map(corpus.docs.map(d => [d.id, d]))
  return [...byValue.entries()].map(([value, fs]) => ({
    value,
    docs: [...new Set(fs.map(f => f.doc))].map(id => ({
      id,
      title: docOf.get(id)?.title ?? id,
      date: docOf.get(id)?.date ?? '',
    })),
  }))
}

/** One case per conflicted (entity, key), in the order `conflicts.jsonl` first names them. */
export function conflictChatCases(corpus: Corpus): EvalCase[] {
  const seen = new Set<string>()
  const cases: EvalCase[] = []
  for (const c of corpus.conflicts) {
    const k = `${c.entity}|${c.key}`
    if (seen.has(k)) continue
    seen.add(k)
    const sides = conflictSides(corpus, c.entity, c.key)
    if (sides.length < 2) continue
    const winnerFact = corpus.facts.find(f => f.id === (c.winner === 'a' ? c.a : c.b))
    const listed = sides
      .map(
        s =>
          `${s.value} (${s.docs.map(d => `"${d.title}"${d.date ? `, ${d.date}` : ''}`).join('; ')})`
      )
      .join(' and ')
    const question = (QUESTIONS[c.key] ?? GENERIC)
      .replace('{entity}', c.entity)
      .replace('{key}', c.key.replace(/_/g, ' '))
    cases.push(
      evalCaseSchema.parse({
        id: `conflict-${slug(c.entity)}-${slug(c.key)}`,
        input: question,
        messages: [],
        context: [],
        expected: {
          rubric: [
            `The documents give different values for ${c.entity}'s ${c.key.replace(/_/g, ' ')}: ${listed}.`,
            'PASS only if the answer mentions every one of these values, attributes each to the document it came from (by title or an unambiguous description such as "the 2026 price list" or "the synced email"), and says the sources disagree or that one replaced the other.',
            "FAIL if it states only one value as if it were the only answer, or attributes one of these values to the wrong source. Citing further documents as context, or the answer's own judgement of which source is stronger, is fine; judge only the values and sources listed here, which are exactly the titles above.",
            winnerFact
              ? `Leading with ${render(winnerFact.value)} as the likely current value is fine but not required; a different number format (e.g. £1,195 for 1195) is fine.`
              : 'A different number format is fine.',
          ].join(' '),
        },
        tags: ['conflict', 'facts', c.key],
      })
    )
  }
  return cases
}
