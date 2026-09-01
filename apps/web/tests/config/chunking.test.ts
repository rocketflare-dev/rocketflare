/**
 * Pure retrieval helpers (D18), no database: `chunkText` (paragraph-aware windows with a word-boundary
 * overlap, hard split of an oversized paragraph, sequential `seq`, character-based token estimate)
 * and `fuseByRank` (Reciprocal Rank Fusion: an item in both lists outranks a single-signal top hit,
 * ranks are carried, ties break deterministically).
 */
import { describe, expect, it } from 'vitest'
import {
  CHARS_PER_TOKEN,
  chunkText,
  DEFAULT_CHUNK_TOKENS,
  estimateTokens,
  overlapTail,
} from '@/api/services/ai/chunking'
import { candidatePoolSize, fuseByRank, RRF_K, vectorLiteral } from '@/api/services/ai/retrieval'

const words = (n: number, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')

describe('chunkText', () => {
  it('empty / whitespace → no chunks; a short text → one chunk with seq 0', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('  \n\n \n')).toEqual([])
    expect(chunkText('Hello world.')).toEqual([
      { seq: 0, text: 'Hello world.', tokenCount: estimateTokens('Hello world.') },
    ])
  })

  it('packs paragraphs into windows, never exceeds the window, and overlaps at a word boundary', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => words(60, `p${i}w`))
    const text = paragraphs.join('\n\n')
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    const maxChars = 200 * CHARS_PER_TOKEN
    expect(chunks.length).toBeGreaterThan(1)
    for (const [i, c] of chunks.entries()) {
      expect(c.seq).toBe(i)
      expect(c.text.length).toBeLessThanOrEqual(maxChars)
      expect(c.text.trim()).toBe(c.text)
      expect(c.tokenCount).toBe(Math.ceil(c.text.length / CHARS_PER_TOKEN))
    }
    // Every paragraph survives somewhere, in order of first appearance.
    let cursor = 0
    for (const p of paragraphs) {
      const idx = chunks.findIndex((c, i) => i >= cursor && c.text.includes(p))
      expect(idx, p.slice(0, 12)).toBeGreaterThanOrEqual(cursor)
      cursor = idx
    }
    // The tail of chunk n opens chunk n+1 (the overlap), starting on a whole word.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]?.text ?? ''
      const head = chunks[i]?.text.split('\n\n')[0] ?? ''
      expect(prev.endsWith(head)).toBe(true)
      // …and the cut fell on whitespace in the previous chunk, never inside a word.
      expect(prev[prev.length - head.length - 1]).toMatch(/\s/)
    }
  })

  it('hard-splits a paragraph larger than the window and keeps the overlap', () => {
    const long = words(500)
    const chunks = chunkText(long, { maxTokens: 100, overlapTokens: 10 })
    const maxChars = 100 * CHARS_PER_TOKEN
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(maxChars)
    const joined = chunks.map(c => c.text).join(' ')
    for (let i = 0; i < 500; i += 37) expect(joined).toContain(`lorem${i}`)
  })

  it('defaults to ~800-token windows', () => {
    const text = Array.from({ length: 30 }, (_, i) => words(80, `d${i}x`)).join('\n\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_TOKENS)
  })

  it('overlapTail cuts at a word boundary', () => {
    expect(overlapTail('one two three four', 9)).toBe('four')
    expect(overlapTail('short', 50)).toBe('short')
    expect(overlapTail('abc', 0)).toBe('')
  })
})

describe('fuseByRank (RRF)', () => {
  const key = (x: string) => x
  it('an item found by both signals beats a single-signal top hit; ranks are carried', () => {
    const fused = fuseByRank(['a', 'b', 'c'], ['b', 'd'], key)
    expect(fused.map(f => f.item)).toEqual(['b', 'a', 'd', 'c'])
    expect(fused[0]).toMatchObject({ item: 'b', rank: 1, denseRank: 2, lexicalRank: 1 })
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
    expect(fused[1]).toMatchObject({ item: 'a', rank: 2, denseRank: 1, lexicalRank: null })
    expect(fused[2]).toMatchObject({ item: 'd', denseRank: null, lexicalRank: 2 })
  })
  it('empty lists fuse to nothing; equal scores tie-break on the key', () => {
    expect(fuseByRank<string>([], [], key)).toEqual([])
    expect(fuseByRank(['z'], ['a'], key).map(f => f.item)).toEqual(['a', 'z'])
  })
  it('candidatePoolSize retrieves wide; vectorLiteral is pgvector text', () => {
    expect(candidatePoolSize(5)).toBe(50)
    expect(candidatePoolSize(20)).toBe(80)
    expect(candidatePoolSize(100)).toBe(200)
    expect(vectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]')
  })
})
