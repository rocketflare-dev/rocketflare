/**
 * Pure retrieval helpers, no database: `chunkText` (exact slices of the input; heading-bounded
 * sections with their heading path; paragraph-packed windows with a word-boundary overlap; GFM
 * tables split on row boundaries with the header carried; sequential `seq`, character-based token
 * estimate)
 * and `fuseByRank` (Reciprocal Rank Fusion: an item in both lists outranks a single-signal top hit,
 * ranks are carried, ties break deterministically).
 */
import { describe, expect, it } from 'vitest'
import {
  CHARS_PER_TOKEN,
  chunkText,
  DEFAULT_CHUNK_TOKENS,
  embeddingInput,
  estimateTokens,
  headingPathLabel,
  normalizeLineEndings,
  overlapTail,
  type TextChunk,
} from '@/api/services/ai/chunking'
import {
  anyTermTsquery,
  candidatePoolSize,
  fuseByRank,
  LEXICAL_MAX_TERMS,
  RRF_K,
  vectorLiteral,
} from '@/api/services/ai/retrieval'

const words = (n: number, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')

/** Every chunk is an exact slice of the text it came from. */
function expectExactSlices(text: string, chunks: TextChunk[]) {
  for (const c of chunks) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text)
}

describe('chunkText', () => {
  it('empty / whitespace → no chunks; a short text → one chunk with seq 0', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('  \n\n \n')).toEqual([])
    expect(chunkText('Hello world.')).toEqual([
      {
        seq: 0,
        text: 'Hello world.',
        tokenCount: estimateTokens('Hello world.'),
        charStart: 0,
        charEnd: 12,
        headingPath: [],
        tableHeader: null,
        page: null,
      },
    ])
  })

  it('packs paragraphs into windows, never exceeds the window, and overlaps at a word boundary', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => words(60, `p${i}w`))
    const text = paragraphs.join('\n\n')
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    const maxChars = 200 * CHARS_PER_TOKEN
    expect(chunks.length).toBeGreaterThan(1)
    expectExactSlices(text, chunks)
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
    // The overlap: chunk n+1 starts INSIDE chunk n, on a whole word, and still reaches past it.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as TextChunk
      const next = chunks[i] as TextChunk
      expect(next.charStart).toBeGreaterThan(prev.charStart)
      expect(next.charStart).toBeLessThan(prev.charEnd)
      expect(text[next.charStart - 1]).toMatch(/\s/)
      expect(next.charEnd).toBeGreaterThan(prev.charEnd)
    }
  })

  it('hard-splits a paragraph larger than the window and keeps the overlap', () => {
    const long = words(500)
    const chunks = chunkText(long, { maxTokens: 100, overlapTokens: 10 })
    const maxChars = 100 * CHARS_PER_TOKEN
    expect(chunks.length).toBeGreaterThan(3)
    expectExactSlices(long, chunks)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(maxChars)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.charStart).toBeLessThan(chunks[i - 1]?.charEnd ?? 0)
    }
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

  it('headings bound every chunk, and each chunk carries its heading path', () => {
    const text = [
      'Preamble before any heading.',
      '# Pricing',
      'Monthly plans cost money.',
      '## Annual plans',
      'Annual plans are cheaper.',
      '### Discounts ###',
      'Ten percent off.',
      '## Refunds',
      'Within thirty days.',
      '# Support',
      'Email us.',
    ].join('\n\n')
    // A window too small for two sections together: each section is a chunk of its own.
    const chunks = chunkText(text, { maxTokens: 12, overlapTokens: 2 })
    expectExactSlices(text, chunks)
    expect(chunks.map(c => [c.headingPath, c.text])).toEqual([
      [[], 'Preamble before any heading.'],
      [['Pricing'], '# Pricing\n\nMonthly plans cost money.'],
      [['Pricing', 'Annual plans'], '## Annual plans\n\nAnnual plans are cheaper.'],
      [['Pricing', 'Annual plans', 'Discounts'], '### Discounts ###\n\nTen percent off.'],
      [['Pricing', 'Refunds'], '## Refunds\n\nWithin thirty days.'],
      [['Support'], '# Support\n\nEmail us.'],
    ])
    expect(headingPathLabel(chunks[2]?.headingPath ?? [])).toBe('Pricing › Annual plans')
    expect(headingPathLabel([])).toBeNull()
  })

  it('packs whole sections that fit a window together, under the headings they share', () => {
    const pricing = '# Pricing\n\nIntro.\n\n## Annual\n\nCheaper.\n\n## Monthly\n\nDearer.'
    expect(chunkText(pricing).map(c => [c.headingPath, c.text])).toEqual([[['Pricing'], pricing]])
    // Sections under different top-level headings share nothing.
    const two = `${pricing}\n\n# Support\n\nEmail us.`
    expect(chunkText(two).map(c => c.headingPath)).toEqual([[]])
    // A group is cut at a heading, never inside a section that fits.
    const long = `# A\n\n${words(60, 'a')}\n\n# B\n\n${words(60, 'b')}\n\n# C\n\n${words(10, 'c')}`
    const chunks = chunkText(long, { maxTokens: 100, overlapTokens: 10 })
    expectExactSlices(long, chunks)
    for (const c of chunks) expect(c.text.startsWith('# ')).toBe(true)
    expect(chunks.map(c => c.headingPath)).toEqual([['A'], []])
  })

  it('a section larger than a window never shares a chunk with the next, and the overlap never crosses a heading', () => {
    const text = `# One\n\n${words(300, 'a')}\n\n# Two\n\n${words(40, 'b')}`
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 20 })
    expectExactSlices(text, chunks)
    const two = chunks.filter(c => c.headingPath[0] === 'Two')
    expect(two).toHaveLength(1)
    expect(two[0]?.text.startsWith('# Two')).toBe(true)
    for (const c of chunks.filter(c => c.headingPath[0] === 'One')) {
      expect(c.text).not.toContain('b0')
    }
  })

  it('a `#` inside a fenced code block is not a heading; `#tag` is not one either', () => {
    const text =
      '# Setup\n\n```sh\n# install it\npnpm i\n```\n\n#hashtag stays prose\n\n~~~\n## nope\n~~~'
    const chunks = chunkText(text)
    expectExactSlices(text, chunks)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.headingPath).toEqual(['Setup'])
  })

  it('CRLF input: slices stay exact against the raw text and headings are still found', () => {
    const text =
      'Intro.\r\n\r\n# Title\r\n\r\nBody line one.\r\nBody line two.\r\n\r\n## Sub\r\n\r\nMore.'
    const chunks = chunkText(text, { maxTokens: 12, overlapTokens: 2 })
    expectExactSlices(text, chunks)
    expect(chunks.map(c => c.headingPath)).toEqual([[], ['Title'], ['Title', 'Sub']])
    for (const c of chunks) expect(c.text.trim()).toBe(c.text)
    expect(normalizeLineEndings(text)).not.toContain('\r')
  })

  it('embeddingInput prefixes heading path and table header; the stored text stays plain', () => {
    expect(embeddingInput({ text: 'Body.', headingPath: ['A', 'B'], tableHeader: null })).toBe(
      'A › B\n\nBody.'
    )
    expect(
      embeddingInput({
        text: '| 1 | 2 |',
        headingPath: ['Sheet1'],
        tableHeader: '| a | b |\n|---|---|',
      })
    ).toBe('Sheet1\n\n| a | b |\n|---|---|\n\n| 1 | 2 |')
    expect(embeddingInput({ text: 'Body.', headingPath: [], tableHeader: null })).toBe('Body.')
  })
})

describe('chunkText — tables', () => {
  const header = '| id | name | amount |\n|---:|------|--------|'
  const rows = Array.from({ length: 300 }, (_, i) => `| ${i} | item ${i} | ${i * 7} |`)

  it('a 300-row table splits on row boundaries; every later chunk carries the header', () => {
    const text = `## Sheet1\n\n${header}\n${rows.join('\n')}`
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    expect(chunks.length).toBeGreaterThan(5)
    expectExactSlices(text, chunks)
    const [first, ...later] = chunks
    expect(first?.text.startsWith(`## Sheet1\n\n${header}`)).toBe(true)
    expect(first?.tableHeader).toBeNull()
    for (const c of later) {
      expect(c.tableHeader).toBe(header)
      expect(c.headingPath).toEqual(['Sheet1'])
      // Whole rows only: every line of the chunk is a complete row.
      for (const line of c.text.split('\n')) expect(rows).toContain(line)
      expect(c.text.length).toBeLessThanOrEqual(200 * CHARS_PER_TOKEN)
    }
    // Every row survives, and neighbours overlap by whole rows.
    const all = new Set(chunks.flatMap(c => c.text.split('\n')))
    for (const row of rows) expect(all.has(row)).toBe(true)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.charStart).toBeLessThan(chunks[i - 1]?.charEnd ?? 0)
    }
  })

  it('a table that fits is packed like a paragraph, header included', () => {
    const text = `Before.\n\n${header}\n${rows.slice(0, 3).join('\n')}\n\nAfter.`
    const chunks = chunkText(text)
    expectExactSlices(text, chunks)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.tableHeader).toBeNull()
  })

  it('a single row wider than a window is the only hard split, and keeps the header', () => {
    const wide = `| 1 | ${words(200, 'w')} |`
    const text = `${header}\n${wide}\n| 2 | x | y |`
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 })
    expectExactSlices(text, chunks)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks.slice(1)) expect(c.tableHeader).toBe(header)
  })

  it('a table inside a fenced code block is not a table', () => {
    const text = `\`\`\`\n${header}\n${rows.slice(0, 200).join('\n')}\n\`\`\``
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    expectExactSlices(text, chunks)
    for (const c of chunks) expect(c.tableHeader).toBeNull()
  })

  it('a paragraph with pipes but no delimiter row is not a table', () => {
    const text = Array.from({ length: 200 }, (_, i) => `a | b | c ${i}`).join('\n')
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 })
    expectExactSlices(text, chunks)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.tableHeader).toBeNull()
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
  it('anyTermTsquery ORs the distinct words and lets no tsquery syntax through', () => {
    expect(anyTermTsquery('Pedestrian segregation, I want to know about it')).toBe(
      'pedestrian | segregation | i | want | to | know | about | it'
    )
    expect(anyTermTsquery('a & b | !c <-> "d" a')).toBe('a | b | c | d')
    expect(anyTermTsquery('Größe 42 café')).toBe('größe | 42 | café')
    expect(anyTermTsquery('  ?!  ')).toBeNull()
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
    expect(anyTermTsquery(long)?.split(' | ')).toHaveLength(LEXICAL_MAX_TERMS)
  })

  it('candidatePoolSize retrieves wide; vectorLiteral is pgvector text', () => {
    expect(candidatePoolSize(5)).toBe(50)
    expect(candidatePoolSize(20)).toBe(80)
    expect(candidatePoolSize(100)).toBe(200)
    expect(vectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]')
  })
})
