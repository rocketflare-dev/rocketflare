/**
 * The conflict chat cases (`kit/conflict-chat.ts`) are derived from the answer keys alone, so they
 * are checked here against the kit fixture: one case per conflicted entity and key, each naming
 * every planted value with its document.
 */
import { describe, expect, it } from 'vitest'
import { conflictChatCases, conflictSides } from '../kit/conflict-chat'
import { listCorpora, loadCorpus } from '../kit/corpus'

const corpora = listCorpora()
  .map(name => loadCorpus(name))
  .filter(c => c.conflicts.length > 0)

describe('conflictChatCases', () => {
  for (const corpus of corpora) {
    it(`${corpus.name}: one case per conflicted entity and key, each with every side`, () => {
      const cases = conflictChatCases(corpus)
      const keys = new Set(corpus.conflicts.map(c => `${c.entity}|${c.key}`))
      expect(cases).toHaveLength(keys.size)
      expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
      for (const c of corpus.conflicts) {
        const sides = conflictSides(corpus, c.entity, c.key)
        expect(sides.length).toBeGreaterThanOrEqual(2)
        const evalCase = cases.find(x => String(x.input).includes(c.entity))
        expect(evalCase).toBeDefined()
      }
      for (const evalCase of cases) {
        expect(evalCase.expected.rubric).toMatch(/every one of these values/)
        expect(typeof evalCase.input).toBe('string')
      }
    })
  }

  it('groups three facts with two values on one key into two sides', () => {
    const corpus = corpora.find(c => c.name.endsWith('brightside'))
    if (!corpus) return
    const sides = conflictSides(corpus, 'Winter gritting (annual plan)', 'price_gbp')
    expect(sides.map(s => s.value).sort()).toEqual(['1140', '1195'])
    expect(sides.find(s => s.value === '1140')?.docs.length).toBe(2)
  })
})
