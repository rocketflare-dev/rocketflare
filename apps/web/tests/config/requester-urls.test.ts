/**
 * The pure half of `ToolCtx.requesterUrls`: what counts as a URL a person wrote, and how it is
 * normalised so a tool can compare its own parsed URL against the set.
 */
import { describe, expect, it } from 'vitest'
import {
  normaliseRequesterUrl,
  REQUESTER_URLS_MAX,
  requesterUrlsForRun,
  requesterUrlsFromInput,
  requesterUrlsFromTexts,
} from '@/api/services/agents/tools/requester-urls'

describe('requester URLs', () => {
  it('finds http(s) URLs in prose, drops sentence punctuation and the fragment', () => {
    const urls = requesterUrlsFromTexts([
      'See https://a.example/x, then (https://b.example/y?q=1#top). Also HTTP://C.example.',
    ])
    expect([...urls].sort()).toEqual([
      'http://c.example/',
      'https://a.example/x',
      'https://b.example/y?q=1',
    ])
  })

  it('refuses other schemes and over-long URLs', () => {
    expect(normaliseRequesterUrl('javascript:alert(1)')).toBeNull()
    expect(normaliseRequesterUrl('file:///etc/passwd')).toBeNull()
    expect(normaliseRequesterUrl(`https://a.example/${'x'.repeat(2100)}`)).toBeNull()
    expect(requesterUrlsFromTexts(['ftp://a.example/file']).size).toBe(0)
  })

  it(`keeps at most ${REQUESTER_URLS_MAX}`, () => {
    const text = Array.from({ length: 80 }, (_, i) => `https://h${i}.example/`).join(' ')
    expect(requesterUrlsFromTexts([text]).size).toBe(REQUESTER_URLS_MAX)
  })

  it('walks a run input’s strings, nested', () => {
    const urls = requesterUrlsFromInput({ topic: 'x', sources: [{ url: 'https://a.example/1' }] })
    expect([...urls]).toEqual(['https://a.example/1'])
  })

  it('a run’s set is empty unless a person submitted its input', () => {
    const input = { text: 'https://a.example/' }
    expect(
      requesterUrlsForRun({ inputFromRequester: true, requestedByUserId: 'u' }, input).size
    ).toBe(1)
    expect(
      requesterUrlsForRun({ inputFromRequester: false, requestedByUserId: 'u' }, input).size
    ).toBe(0)
    expect(
      requesterUrlsForRun({ inputFromRequester: true, requestedByUserId: null }, input).size
    ).toBe(0)
  })

  it('the empty set and a found set are frozen', () => {
    expect(Object.isFrozen(requesterUrlsFromTexts([]))).toBe(true)
    expect(Object.isFrozen(requesterUrlsFromTexts(['https://a.example/']))).toBe(true)
  })
})
