/**
 * The pure helpers behind the document viewer (`config` project, no database, no DOM). Each exists
 * because something downstream would be silently wrong without it: `documentPath` is the ONE place
 * the viewer's route is written, so a link from Search, a citation and a passage row cannot drift;
 * `windowStart` is what makes a deep link and the reader's own paging share a cache entry;
 * `highlightMatches` is the reason highlighting is `<mark>` NODES and not `dangerouslySetInnerHTML`
 * over text somebody uploaded.
 */
import {
  DOCUMENT_WINDOW_CHARS,
  documentCardFromDocument,
  documentPath,
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
