/**
 * The pure halves of knowledge-fact extraction (D43), no database: the date resolver (dates are
 * resolved in code against the DOCUMENT's date, never by the model), value coercion against a
 * key's schema, the verbatim-quote verifier, the state table, resolution's candidate choice,
 * sections, trust and the preference rule. The database half is `tests/api/knowledge-extract.test.ts`.
 */
import { isPreferredOver, preferredFact } from '@rocketflare/shared/ai/knowledge-facts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { secondsUntilNextUtcDay } from '@/api/services/ai/usage'
import { resolveDatePhrase } from '@/api/services/knowledge/dates'
import {
  chooseCandidate,
  LINK_THRESHOLD,
  REVIEW_THRESHOLD,
} from '@/api/services/knowledge/entities'
import {
  buildSections,
  documentReviewer,
  documentSourceKind,
} from '@/api/services/knowledge/extract'
import { cleanQuote, locateQuote } from '@/api/services/knowledge/quotes'
import { decideFactState, type HeldFact, windowOrder } from '@/api/services/knowledge/state'
import { coerceFactValue, valueKey, valueText } from '@/api/services/knowledge/values'

const day = (iso: string) => new Date(`${iso}T09:00:00Z`)

describe('resolveDatePhrase', () => {
  // 2026-05-18 is a Monday; 2026-07-08 a Wednesday; 2026-04-09 a Thursday.
  const monday = day('2026-05-18')
  const wednesday = day('2026-07-08')
  const thursday = day('2026-04-09')

  it.each([
    ['2027-01-31', '2027-01-31'],
    ['2027-01-31T10:00:00Z', '2027-01-31'],
    ['31 January 2027', '2027-01-31'],
    ['31st January 2027', '2027-01-31'],
    ['31 Jan 2027', '2027-01-31'],
    ['January 31, 2027', '2027-01-31'],
    ['31/01/2027', '2027-01-31'],
    ['31/1/27', '2027-01-31'],
    ['31.01.2027', '2027-01-31'],
    ['03/04/2027', '2027-04-03'], // UK order: day first, always
    ['from 1 November 2026', '2026-11-01'],
    ['until 10 July', '2026-07-10'],
    ['the 1st of November', '2026-11-01'],
    ['30 Nov', '2026-11-30'],
    ['today', '2026-05-18'],
    ['tomorrow', '2026-05-19'],
    ['with immediate effect', '2026-05-18'],
  ])('%s → %s (against Monday 18 May 2026)', (phrase, want) => {
    expect(resolveDatePhrase(phrase, monday)).toBe(want)
  })

  it('places a year-less date in the next year when it would be long past', () => {
    // A September price list "valid until 31 March" means next March.
    expect(resolveDatePhrase('31 March', day('2026-09-15'), 'end')).toBe('2027-03-31')
    // …but a date a few weeks back stays in this year.
    expect(resolveDatePhrase('1 June', day('2026-07-08'))).toBe('2026-06-01')
  })

  it('reads weekdays against the document date', () => {
    expect(resolveDatePhrase('next Monday', monday)).toBe('2026-05-25') // the next one to come
    expect(resolveDatePhrase('from next Monday', wednesday)).toBe('2026-07-13')
    expect(resolveDatePhrase('next Thursday', thursday)).toBe('2026-04-16')
    expect(resolveDatePhrase('this Friday', monday)).toBe('2026-05-22')
    expect(resolveDatePhrase('this Monday', monday)).toBe('2026-05-18')
    expect(resolveDatePhrase('next Tuesday', monday)).toBe('2026-05-19')
    expect(resolveDatePhrase('Tuesday', monday)).toBe('2026-05-19')
    expect(resolveDatePhrase('last Friday', monday)).toBe('2026-05-15')
    expect(resolveDatePhrase('on Mondays', wednesday)).toBe('2026-07-13')
  })

  it('reads relative spans and period boundaries', () => {
    expect(resolveDatePhrase('in two weeks', monday)).toBe('2026-06-01')
    expect(resolveDatePhrase('in 3 days', monday)).toBe('2026-05-21')
    expect(resolveDatePhrase('in a fortnight', monday)).toBe('2026-06-01')
    expect(resolveDatePhrase('a month from now', day('2026-01-31'))).toBe('2026-02-28')
    expect(resolveDatePhrase('the first of next month', day('2026-03-12'))).toBe('2026-04-01')
    expect(resolveDatePhrase('from the start of next quarter', day('2026-03-04'))).toBe(
      '2026-04-01'
    )
    expect(resolveDatePhrase('the end of next month', day('2026-01-10'))).toBe('2026-02-28')
    expect(resolveDatePhrase('end of the year', monday)).toBe('2026-12-31')
    expect(resolveDatePhrase('next month', monday)).toBe('2026-06-01')
    expect(resolveDatePhrase('next month', monday, 'end')).toBe('2026-06-30')
    expect(resolveDatePhrase('next year', monday)).toBe('2027-01-01')
    expect(resolveDatePhrase('the end of October', day('2026-08-19'))).toBe('2026-10-31')
    expect(resolveDatePhrase('March 2027', monday)).toBe('2027-03-01')
    expect(resolveDatePhrase('March 2027', monday, 'end')).toBe('2027-03-31')
  })

  it('answers null for anything it cannot read, never a guess', () => {
    for (const phrase of ['', 'soon', 'when the contract is signed', '31/02/2027', '2027-13-01']) {
      expect(resolveDatePhrase(phrase, monday)).toBeNull()
    }
  })
})

describe('coerceFactValue', () => {
  const doc = day('2026-05-18')
  const plan = z.enum(['Essential', 'Standard', 'Premium'])

  it('takes a value already in shape, and coerces the usual near misses', () => {
    expect(coerceFactValue(z.number(), 285, doc)).toEqual({ ok: true, value: 285 })
    expect(coerceFactValue(z.number(), '£1,140', doc)).toEqual({ ok: true, value: 1140 })
    expect(coerceFactValue(z.number(), 'net 60', doc)).toEqual({ ok: true, value: 60 })
    expect(coerceFactValue(z.boolean(), 'Yes', doc)).toEqual({ ok: true, value: true })
    expect(coerceFactValue(z.boolean(), 'not included', doc)).toEqual({ ok: true, value: false })
    expect(coerceFactValue(plan, 'premium', doc)).toEqual({ ok: true, value: 'Premium' })
    expect(coerceFactValue(plan, 'Standard plan', doc)).toEqual({ ok: true, value: 'Standard' })
    expect(coerceFactValue(z.array(plan), 'Essential, standard and Premium', doc)).toEqual({
      ok: true,
      value: ['Essential', 'Standard', 'Premium'],
    })
    expect(coerceFactValue(z.string(), '  Fiona   Marsh ', doc)).toEqual({
      ok: true,
      value: 'Fiona Marsh',
    })
  })

  it('refuses a placeholder for "no value": the key is simply not stated', () => {
    for (const v of ['<UNKNOWN>', 'unknown', 'N/A', 'n/a', '[TBD]', 'None', 'not stated']) {
      expect(coerceFactValue(z.string(), v, doc), v).toEqual({ ok: false, reason: 'empty value' })
    }
    expect(coerceFactValue(z.string(), 'Unknown Ltd', doc)).toMatchObject({ ok: true })
  })

  it('resolves a date value in code, against the document date', () => {
    expect(coerceFactValue(z.iso.date(), '31 January 2027', doc)).toEqual({
      ok: true,
      value: '2027-01-31',
    })
    expect(coerceFactValue(z.iso.date(), 'next Monday', doc)).toEqual({
      ok: true,
      value: '2026-05-25',
    })
  })

  it('drops what does not parse', () => {
    expect(coerceFactValue(z.number(), '£300 or £350', doc).ok).toBe(false)
    expect(coerceFactValue(plan, 'Gold', doc).ok).toBe(false)
    expect(coerceFactValue(z.iso.date(), 'when signed', doc).ok).toBe(false)
    expect(coerceFactValue(z.string(), null, doc).ok).toBe(false)
    expect(coerceFactValue(z.email(), 'not an email', doc).ok).toBe(false)
  })

  it('normalises for display and compares like with like', () => {
    expect(valueText(['Essential', 'Premium'])).toBe('Essential, Premium')
    expect(valueText(true)).toBe('yes')
    expect(valueKey('01632 960455')).toBe(valueKey('01632-960455'))
    expect(valueKey('Marcus Bell')).toBe(valueKey('marcus bell.'))
    expect(valueKey(['A', 'B'])).toBe(valueKey(['B', 'A']))
    expect(valueKey(60)).not.toBe(valueKey(30))
  })
})

describe('locateQuote — the verifier', () => {
  const text = 'Plan: **Standard**.\nMonthly Fee: £285 per month,\n  ex VAT. It’s fine.'

  it('finds a verbatim quote modulo whitespace, quote marks and emphasis, at its true offsets', () => {
    const at = locateQuote(text, 'Monthly Fee: £285 per month, ex VAT.')
    expect(at).not.toBeNull()
    expect(text.slice(at?.start, at?.end)).toBe('Monthly Fee: £285 per month,\n  ex VAT.')
    expect(locateQuote(text, 'Plan: Standard')).not.toBeNull()
    expect(locateQuote(text, "It's fine")).not.toBeNull()
    expect(cleanQuote('"… Monthly Fee"')).toBe('Monthly Fee')
  })

  it('refuses anything not in the text', () => {
    expect(locateQuote(text, 'Monthly Fee: £290 per month')).toBeNull()
    expect(locateQuote(text, 'monthly fee: £285')).toBeNull() // case is compared
    expect(locateQuote(text, 'ab')).toBeNull()
  })
})

describe('decideFactState — the state table', () => {
  const held = (over: Partial<HeldFact> & { id: string }): HeldFact => ({
    state: 'accepted',
    valueKey: 'n:30',
    validFrom: null,
    validTo: null,
    ...over,
  })
  const candidate = { valueKey: 'n:30', confidence: 0.9, validFrom: null, validTo: null }

  it('nothing held: accepted when confident, else unconfirmed', () => {
    expect(decideFactState(candidate, []).state).toBe('accepted')
    expect(decideFactState({ ...candidate, confidence: 0.5 }, []).state).toBe('unconfirmed')
  })

  it('same value: accepted, and an unconfirmed one is confirmed', () => {
    const d = decideFactState({ ...candidate, confidence: 0.4 }, [
      held({ id: 'a', state: 'unconfirmed' }),
    ])
    expect(d).toMatchObject({ state: 'accepted', confirms: ['a'], conflictsWith: [] })
  })

  it('different value: conflicting on both', () => {
    const d = decideFactState({ ...candidate, valueKey: 'n:60' }, [held({ id: 'a' })])
    expect(d).toMatchObject({ state: 'conflicting', conflictsWith: ['a'], supersedes: [] })
  })

  it('different value with disjoint validity: the earlier window is superseded', () => {
    const older = held({ id: 'a', validTo: new Date('2026-03-31') })
    const newer = { ...candidate, valueKey: 'n:60', validFrom: new Date('2026-04-01') }
    expect(decideFactState(newer, [older])).toMatchObject({
      state: 'accepted',
      supersedes: ['a'],
      conflictsWith: [],
    })
    // An older source read late is superseded by the held later window instead.
    const lateOld = { ...candidate, valueKey: 'n:30', validTo: new Date('2026-03-31') }
    const heldNew = held({ id: 'b', valueKey: 'n:60', validFrom: new Date('2026-04-01') })
    expect(decideFactState(lateOld, [heldNew])).toMatchObject({
      state: 'superseded',
      supersededBy: 'b',
    })
  })

  it('a window on one side only is not a change over time — it conflicts', () => {
    expect(
      windowOrder({ validFrom: null, validTo: null }, { validFrom: new Date(), validTo: null })
    ).toBe(0)
    const d = decideFactState(
      { ...candidate, valueKey: 'n:60', validFrom: new Date('2026-04-01') },
      [held({ id: 'a' })]
    )
    expect(d.state).toBe('conflicting')
  })
})

describe('preference — derived from date and trust, never stored', () => {
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`)
  it('newer AND at least as trusted is preferred; otherwise the older', () => {
    const contract = { observedAt: at('2026-02-03'), sourceKind: 'upload' as const }
    const email = { observedAt: at('2026-06-10'), sourceKind: 'integration' as const }
    const memo = { observedAt: at('2026-05-18'), sourceKind: 'upload' as const }
    expect(isPreferredOver(email, contract)).toBe(false)
    expect(isPreferredOver(contract, email)).toBe(true) // argument order does not matter
    expect(isPreferredOver(memo, contract)).toBe(true)
    expect(preferredFact([email, contract])).toBe(contract)
    expect(preferredFact([contract, memo, email])).toBe(memo)
    expect(preferredFact([])).toBeUndefined()
  })
})

describe('chooseCandidate — resolution thresholds', () => {
  const c = (id: string, score: number, exact = false) => ({
    kind: 'staging' as const,
    id,
    label: id,
    score,
    exact,
  })
  it('links one candidate above the threshold, reviews the band and ties, else nothing', () => {
    expect(chooseCandidate([c('a', 0.8), c('b', 0.3)])).toEqual({ link: c('a', 0.8) })
    expect(chooseCandidate([c('a', 0.8), c('b', 0.7)])).toMatchObject({
      review: [{ id: 'a' }, { id: 'b' }],
    })
    expect(chooseCandidate([c('a', 1, true), c('b', 0.7)])).toEqual({ link: c('a', 1, true) })
    expect(chooseCandidate([c('a', (LINK_THRESHOLD + REVIEW_THRESHOLD) / 2)])).toMatchObject({
      review: [{ id: 'a' }],
    })
    expect(chooseCandidate([c('a', REVIEW_THRESHOLD - 0.01)])).toEqual({ none: true })
  })
})

describe('sections, trust and the cap delay', () => {
  it('joins consecutive chunks through the content, reading overlap once', () => {
    const content = 'aaaa bbbb cccc dddd'
    const rows = [
      { id: '1', seq: 0, text: 'aaaa bbbb', headingPath: 'H', charStart: 0, charEnd: 9 },
      { id: '2', seq: 1, text: 'bbbb cccc dddd', headingPath: 'H', charStart: 5, charEnd: 19 },
    ]
    const [one, ...rest] = buildSections(content, rows)
    expect(rest).toHaveLength(0)
    expect(one).toMatchObject({ text: content, offset: 0, chunks: [{ id: '1' }, { id: '2' }] })
    expect(buildSections(content, rows, 10)).toHaveLength(2)
    const legacy = buildSections(content, [{ ...rows[0], charStart: null, charEnd: null } as never])
    expect(legacy[0]).toMatchObject({ offset: null, text: 'aaaa bbbb' })
  })

  it('reads trust and the reviewer from the document', () => {
    expect(documentSourceKind({ origin: 'integration', source: 'm365:mail' })).toBe('integration')
    expect(documentSourceKind({ origin: 'upload', source: 'agent:weekly-digest' })).toBe('agent')
    expect(documentSourceKind({ origin: 'upload', source: null })).toBe('upload')
    expect(documentReviewer({ reviewerUserId: 'r', ownerUserId: 'o' })).toBe('r')
    expect(documentReviewer({ reviewerUserId: null, ownerUserId: 'o' })).toBe('o')
    expect(documentReviewer({ reviewerUserId: null, ownerUserId: null })).toBeNull()
  })

  it('waits for the next UTC day, at most 12 hours a hop', () => {
    expect(secondsUntilNextUtcDay(new Date('2026-05-18T23:00:00Z'))).toBe(3600 + 60)
    expect(secondsUntilNextUtcDay(new Date('2026-05-18T01:00:00Z'))).toBe(12 * 3600)
  })
})
