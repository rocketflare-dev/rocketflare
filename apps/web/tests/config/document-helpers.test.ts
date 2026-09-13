/**
 * The pure helpers behind the document viewer (`config` project, no database, no DOM). Each exists
 * because something downstream would be silently wrong without it: `documentPath` is the ONE place
 * the viewer's route is written, so a link from Search, a citation and a passage row cannot drift;
 * `windowStart` is what makes a deep link and the reader's own paging share a cache entry;
 * `highlightMatches` is the reason highlighting is `<mark>` NODES and not `dangerouslySetInnerHTML`
 * over text somebody uploaded.
 */
import {
  DOCUMENT_EXCERPT_CHARS,
  DOCUMENT_WINDOW_CHARS,
  documentCardFromDocument,
  documentCardsFromToolCalls,
  documentCardsFromToolResult,
  documentExcerpt,
  documentPath,
  KNOWLEDGE_TOOLS,
  windowStart,
} from '@rocketflare/shared/ai/embeddings'
import { describe, expect, it } from 'vitest'
import { highlightMatches } from '@/ui/lib/highlight'

const DOC = '55555555-5555-4555-8555-555555555555'

describe('documentPath', () => {
  it('writes only the parameters it is given, in a stable order', () => {
    expect(documentPath(DOC)).toBe(`/documents/${DOC}`)
    expect(documentPath(DOC, { offset: 0 })).toBe(`/documents/${DOC}?offset=0`)
    expect(documentPath(DOC, { tab: 'document', offset: 40, chunk: 'c1', q: 'a b' })).toBe(
      `/documents/${DOC}?tab=document&offset=40&chunk=c1&q=a+b`
    )
  })

  it('drops a null offset, a null chunk and an empty query rather than writing empty params', () => {
    // A passage whose `charOffset` could not be resolved must fall back to `?chunk=` ALONE — an
    // `offset=null` in the URL would read as "the beginning", which is a worse answer than none.
    expect(documentPath(DOC, { offset: null, chunk: 'c1', q: '' })).toBe(
      `/documents/${DOC}?chunk=c1`
    )
    expect(documentPath(DOC, { offset: -1 })).toBe(`/documents/${DOC}`)
  })
})

describe('windowStart', () => {
  it('snaps an arbitrary offset down to a window boundary', () => {
    expect(windowStart(0)).toBe(0)
    expect(windowStart(41_207)).toBe(2 * DOCUMENT_WINDOW_CHARS)
    expect(windowStart(DOCUMENT_WINDOW_CHARS)).toBe(DOCUMENT_WINDOW_CHARS)
    // Two links into the same window resolve to ONE query, which is the whole point.
    expect(windowStart(21_000)).toBe(windowStart(39_999))
  })

  it('is total: a negative, a NaN or a fractional offset is the first window', () => {
    expect(windowStart(-5)).toBe(0)
    expect(windowStart(Number.NaN)).toBe(0)
    expect(windowStart(0.5)).toBe(0)
  })
})

describe('highlightMatches', () => {
  it('splits on every term, case-insensitively, keeping the original text intact', () => {
    const segments = highlightMatches('The Warehouse warehouse policy', 'warehouse')
    expect(segments.map(s => s.text).join('')).toBe('The Warehouse warehouse policy')
    expect(segments.filter(s => s.match).map(s => s.text)).toEqual(['Warehouse', 'warehouse'])
  })

  it('treats the query as text, not a pattern', () => {
    // A regex metacharacter in somebody's search box must not blow up or match everything.
    expect(() => highlightMatches('a.b', '.')).not.toThrow()
    const segments = highlightMatches('cost is $5 (net)', '$5')
    expect(segments.filter(s => s.match).map(s => s.text)).toEqual(['$5'])
  })

  it('returns one plain segment for an empty query and ignores one-character terms', () => {
    expect(highlightMatches('hello', '')).toEqual([{ text: 'hello', match: false }])
    expect(highlightMatches('hello', null)).toEqual([{ text: 'hello', match: false }])
    // Marking every "a" marks the whole document and says nothing.
    expect(highlightMatches('a banana', 'a')).toEqual([{ text: 'a banana', match: false }])
  })
})

describe('documentCardFromDocument', () => {
  it('builds a card from a row the client already has, with no excerpt unless given one', () => {
    const row = {
      id: DOC,
      tenantId: '00000000-0000-4000-8000-000000000000',
      ownerUserId: null,
      title: 'Quarterly report',
      source: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      fileId: null,
      chunkCount: 7,
      status: 'indexed' as const,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(documentCardFromDocument(row)).toMatchObject({
      id: DOC,
      title: 'Quarterly report',
      typeLabel: 'PDF',
      status: 'indexed',
      excerpt: null,
      passages: 7,
      href: `/documents/${DOC}`,
    })
    expect(documentCardFromDocument(row, 'The quarter went well.').excerpt).toBe(
      'The quarter went well.'
    )
  })
})

describe('documentExcerpt', () => {
  it('collapses whitespace, ellipsises past the cap, and maps empty to null', () => {
    expect(documentExcerpt('  one\n\n two\tthree  ')).toBe('one two three')
    expect(documentExcerpt(null)).toBeNull()
    expect(documentExcerpt('   \n  ')).toBeNull()
    const long = documentExcerpt('x'.repeat(DOCUMENT_EXCERPT_CHARS * 2)) as string
    expect(long).toHaveLength(DOCUMENT_EXCERPT_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('documentCardsFromToolResult', () => {
  const OTHER = '66666666-6666-4666-8666-666666666666'

  it('reads a search answer, and says nothing about a type or a size it was not told', () => {
    const cards = documentCardsFromToolResult(
      KNOWLEDGE_TOOLS.search,
      JSON.stringify({
        query: 'volcanoes',
        documents: [
          { documentId: DOC, title: 'Volcanoes', totalPassages: 3, passages: [{ text: 'a' }] },
          { documentId: OTHER, title: 'Bananas', totalPassages: 1, passages: [] },
        ],
      })
    )
    expect(cards.map(c => c.id)).toEqual([DOC, OTHER])
    expect(cards[0]).toMatchObject({
      title: 'Volcanoes',
      passages: 3,
      // A search hit carries no content type, no size and no original. Guessing "Text" for what
      // might be a PDF is a worse answer than an absent badge.
      typeLabel: null,
      contentType: null,
      sizeBytes: null,
      fileId: null,
      status: 'indexed',
      href: `/documents/${DOC}`,
    })
  })

  it('reads a list answer with its types, and a get_document window as the excerpt', () => {
    const [listed] = documentCardsFromToolResult(KNOWLEDGE_TOOLS.list, {
      documents: [
        { documentId: DOC, title: 'Report', contentType: 'application/pdf', passages: 9 },
      ],
    })
    expect(listed).toMatchObject({ typeLabel: 'PDF', contentType: 'application/pdf', passages: 9 })

    const [read] = documentCardsFromToolResult(KNOWLEDGE_TOOLS.get, {
      documentId: DOC,
      title: 'Report',
      contentType: 'application/pdf',
      status: 'indexed',
      passages: 9,
      text: '  The quarter\n went well.  ',
    })
    // The window the model was shown IS the honest excerpt — whitespace-collapsed, nothing added.
    expect(read).toMatchObject({ excerpt: 'The quarter went well.' })
  })

  it('degrades to no cards rather than crashing on anything it does not recognise', () => {
    // `search-knowledge.ts` reserves the right to retune its JSON for context budgets, so the
    // mapper must survive that — this is the whole reason the card is a kit CUSTOM event and not
    // the UI parsing `TOOL_CALL_RESULT`.
    expect(documentCardsFromToolResult(KNOWLEDGE_TOOLS.search, '{ not json')).toEqual([])
    expect(documentCardsFromToolResult(KNOWLEDGE_TOOLS.search, { documents: 'nope' })).toEqual([])
    expect(documentCardsFromToolResult(KNOWLEDGE_TOOLS.search, null)).toEqual([])
    // A dead end is a real answer shape: `{ error, hint }` names no documents, so no cards.
    expect(
      documentCardsFromToolResult(KNOWLEDGE_TOOLS.get, { error: 'document_not_found', hint: 'x' })
    ).toEqual([])
    expect(documentCardsFromToolResult('some_other_tool', { documents: [] })).toEqual([])
  })

  it('collapses a document named by several calls in one turn to ONE card', () => {
    const cards = documentCardsFromToolCalls([
      {
        name: KNOWLEDGE_TOOLS.search,
        result: JSON.stringify({ documents: [{ documentId: DOC, title: 'Volcanoes' }] }),
      },
      {
        name: KNOWLEDGE_TOOLS.get,
        result: JSON.stringify({ documentId: DOC, title: 'Volcanoes', text: 'Lava.' }),
      },
      { name: 'unrelated_tool', result: '{}' },
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.id).toBe(DOC)
    expect(documentCardsFromToolCalls(null)).toEqual([])
  })
})
