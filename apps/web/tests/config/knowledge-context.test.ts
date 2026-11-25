/** The pure halves of contextual chunk prefixes (#148): the window, the answer cleaner, the embedding input. */
import { describe, expect, it } from 'vitest'
import {
  embeddingInput,
  SITUATING_CONTEXT_MAX_CHARS,
  storedEmbeddingInput,
} from '@/api/services/ai/chunking'
import { CONTEXT_WINDOW_CHARS, cleanContext, contextWindow } from '@/api/services/ai/contextualize'

describe('contextWindow', () => {
  it('is the whole document when it fits', () => {
    expect(contextWindow('x'.repeat(1000), 500)).toEqual({ key: 0, start: 0, end: 1000 })
  })

  it('windows a long document, with a lead-in, and passages of one segment share it', () => {
    const content = 'x'.repeat(CONTEXT_WINDOW_CHARS * 3)
    const first = contextWindow(content, 10)
    expect(first).toMatchObject({ key: 0, start: 0 })
    expect(first.end - first.start).toBe(CONTEXT_WINDOW_CHARS)
    const later = contextWindow(content, CONTEXT_WINDOW_CHARS + 100)
    expect(later.key).toBeGreaterThan(0)
    expect(later.start).toBeLessThan(CONTEXT_WINDOW_CHARS + 100)
    expect(later.end - later.start).toBeLessThanOrEqual(CONTEXT_WINDOW_CHARS)
    expect(contextWindow(content, CONTEXT_WINDOW_CHARS + 200).key).toBe(later.key)
    // Every window contains the passage start it was chosen for.
    for (const at of [0, 44_000, 50_000, 100_000, content.length - 1]) {
      const w = contextWindow(content, at)
      expect(at).toBeGreaterThanOrEqual(w.start)
      expect(at).toBeLessThan(w.end)
    }
  })
})

describe('cleanContext', () => {
  it('strips quotes, control characters and line breaks, and bounds the length', () => {
    expect(cleanContext('  "From the gritting\ncontract.\u0000"  ')).toBe(
      'From the gritting contract.'
    )
    expect(cleanContext('“ ”')).toBe('')
    expect(cleanContext('a'.repeat(5000))).toHaveLength(SITUATING_CONTEXT_MAX_CHARS)
  })
})

describe('embeddingInput', () => {
  const chunk = { text: 'The fee rises.', headingPath: ['Contract', 'Price'], tableHeader: null }

  it('puts the situating context first, then the heading path, then the text', () => {
    expect(embeddingInput(chunk, 'From the gritting contract.')).toBe(
      'From the gritting contract.\n\nContract › Price\n\nThe fee rises.'
    )
  })

  it('is unchanged without a context, and agrees with the stored-row form', () => {
    expect(embeddingInput(chunk)).toBe('Contract › Price\n\nThe fee rises.')
    expect(
      storedEmbeddingInput({
        text: chunk.text,
        headingPath: 'Contract › Price',
        tableHeader: null,
        context: 'Ctx',
      })
    ).toBe(embeddingInput(chunk, 'Ctx'))
  })
})
