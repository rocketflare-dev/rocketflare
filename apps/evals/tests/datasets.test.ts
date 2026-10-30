/** Every committed dataset parses with the shared `EvalCase` schema, and bad lines say where. */
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DATASETS_DIR, loadDataset, parseDataset } from '../kit/dataset'

describe('datasets', () => {
  const names = readdirSync(DATASETS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace(/\.jsonl$/, ''))

  it('ships the knowledge-chat starter dataset (each example agent ships its own beside it)', () => {
    expect(names).toContain('knowledge-chat')
  })

  for (const name of names) {
    it(`${name}.jsonl parses, and every case says what "good" means`, () => {
      const cases = loadDataset(name)
      expect(cases.length).toBeGreaterThan(0)
      for (const c of cases) {
        const e = c.expected
        expect(Boolean(e.rubric || e.contains?.length || e.tools || e.output), c.id).toBe(true)
      }
    })
  }

  it('names the line of a malformed or duplicate case', () => {
    expect(() => parseDataset('x', '{"id":"a","input":"q"}\nnot json')).toThrow(
      /x\.jsonl:2: not JSON/
    )
    expect(() => parseDataset('x', '{"id":"Bad Id","input":"q"}')).toThrow(/x\.jsonl:1: id/)
    expect(() => parseDataset('x', '{"id":"a","input":"q"}\n{"id":"a","input":"r"}')).toThrow(
      /duplicate case id "a"/
    )
  })
})
