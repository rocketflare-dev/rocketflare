/**
 * `@testkit/unit`'s contribution helpers: a cross-plugin test asserts only its own plugin's entries
 * in a shared registry, so it holds in a host with any other plugins installed (#180).
 */
import { expectOwnContributions, isOwnContribution, ownContributions } from '@testkit/unit'
import { describe, expect, it } from 'vitest'

const PROVIDERS = [
  { id: 'global-search:people' },
  { id: 'global-search:documents' },
  { id: 'inbox:messages' },
  { id: 'global-searcher:x' },
]

describe('own contributions', () => {
  it('matches the id and the id followed by a namespace separator, nothing longer', () => {
    expect(isOwnContribution('inbox', 'inbox')).toBe(true)
    expect(isOwnContribution('inbox', 'inbox.received')).toBe(true)
    expect(isOwnContribution('inbox', 'inbox/settings')).toBe(true)
    expect(isOwnContribution('global-search', 'global-searcher:x')).toBe(false)
  })

  it('picks this plugin’s entries out of a shared list', () => {
    expect(ownContributions('global-search', PROVIDERS)).toEqual(PROVIDERS.slice(0, 2))
    expect(ownContributions('inbox', ['inbox.a', 'kit.b'])).toEqual(['inbox.a'])
    expect(ownContributions('x', [{ route: 'x:1' }], p => p.route)).toEqual([{ route: 'x:1' }])
  })

  it('passes on exactly its own set, whatever else is installed, and names a gap', () => {
    expect(() =>
      expectOwnContributions('global-search', PROVIDERS, [
        'global-search:documents',
        'global-search:people',
      ])
    ).not.toThrow()
    expect(() =>
      expectOwnContributions('global-search', PROVIDERS, [
        'global-search:people',
        'global-search:agents',
      ])
    ).toThrow(/missing global-search:agents\n {2}unexpected global-search:documents/)
  })

  it('refuses an item it cannot key, rather than guessing', () => {
    expect(() => ownContributions('x', [{ route: 'x:1' }])).toThrow(/pass keyOf/)
  })
})
