/**
 * `scripts/lib/update-check-lib.mjs` — the decisions behind the `SessionStart` hook that tells a
 * copy of the kit about a newer release once per session (`scripts/kit-update-check.mjs`): who is
 * checked at all, how long an answer is trusted, which tag is newest, what changed, and the one
 * message Claude is handed. The `config` project: no database, no network.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CACHE_TTL_MS,
  changelogSummaries,
  FAILURE_TTL_MS,
  freshCache,
  latestVersion,
  MAX_LISTED,
  rawFileUrl,
  skipReason,
  updateMessage,
} from '../../../../scripts/lib/update-check-lib.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const REPO = 'https://github.com/rocketflare-dev/rocketflare.git'

const copy = (over: Partial<Manifest> = {}) =>
  ({
    kit: { name: 'rocketflare', repo: REPO, version: '0.9.0', commit: null },
    app: { slug: 'myapp' },
    ...over,
  }) as unknown as Manifest

describe('skipReason', () => {
  it('checks a copy on a fresh startup', () => {
    expect(skipReason({ source: 'startup', manifest: copy(), env: {} })).toBeNull()
  })

  it('skips resume, clear and compact — once per session', () => {
    for (const source of ['resume', 'clear', 'compact']) {
      expect(skipReason({ source, manifest: copy(), env: {} })).toBe(`session ${source}`)
    }
  })

  it('skips the kit itself, CI, an opt-out and a manifest it cannot use', () => {
    expect(skipReason({ source: 'startup', manifest: copy({ app: null }), env: {} })).toMatch(
      /kit itself/
    )
    expect(skipReason({ source: 'startup', manifest: copy(), env: { CI: 'true' } })).toBe('CI')
    for (const value of ['0', 'false', 'OFF', 'no']) {
      expect(
        skipReason({
          source: 'startup',
          manifest: copy(),
          env: { ROCKETFLARE_UPDATE_CHECK: value },
        })
      ).toMatch(/ROCKETFLARE_UPDATE_CHECK/)
    }
    expect(
      skipReason({ source: 'startup', manifest: copy(), env: { ROCKETFLARE_UPDATE_CHECK: '1' } })
    ).toBeNull()
    expect(skipReason({ source: 'startup', manifest: null, env: {} })).toMatch(/no \.rocketflare/)
    const noVersion = copy({ kit: { repo: REPO, version: 'main' } as Manifest['kit'] })
    expect(skipReason({ source: 'startup', manifest: noVersion, env: {} })).toMatch(/kit\.version/)
  })

  it('stays silent in the kit repository itself (its manifest has app: null)', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
    expect(skipReason({ source: 'startup', manifest, env: {} })).toMatch(/kit itself/)
  })
})

describe('freshCache', () => {
  const now = 1_800_000_000_000
  const cache = {
    repo: REPO,
    current: '0.9.0',
    checkedAt: now - 1000,
    latest: '0.10.0',
    summaries: [],
  }

  it('trusts an answer for this repo and version for a day', () => {
    expect(freshCache(cache, { repo: REPO, current: '0.9.0', now })).toBe(cache)
    expect(
      freshCache({ ...cache, checkedAt: now - CACHE_TTL_MS }, { repo: REPO, current: '0.9.0', now })
    ).toBeNull()
  })

  it('refetches after an upgrade, for another repo, or when the clock went backwards', () => {
    expect(freshCache(cache, { repo: REPO, current: '0.10.0', now })).toBeNull()
    expect(
      freshCache(cache, { repo: 'https://example.com/fork.git', current: '0.9.0', now })
    ).toBeNull()
    expect(
      freshCache({ ...cache, checkedAt: now + 60_000 }, { repo: REPO, current: '0.9.0', now })
    ).toBeNull()
    expect(freshCache(null, { repo: REPO, current: '0.9.0', now })).toBeNull()
  })

  it('remembers a failed check for an hour, not a day', () => {
    const failed = { ...cache, latest: null, failed: true }
    const at = (ago: number) =>
      freshCache({ ...failed, checkedAt: now - ago }, { repo: REPO, current: '0.9.0', now })
    expect(at(FAILURE_TTL_MS - 1)).not.toBeNull()
    expect(at(FAILURE_TTL_MS)).toBeNull()
  })
})

describe('latestVersion', () => {
  it('picks the numerically newest X.Y.Z from ls-remote lines, ignoring other refs', () => {
    expect(
      latestVersion([
        'aaa\trefs/tags/0.9.0',
        'bbb\trefs/tags/0.10.0',
        'ccc\trefs/tags/0.2.0',
        'ddd\trefs/tags/v1.0.0',
        'eee\trefs/tags/1.0.0-rc.1',
        '',
      ])
    ).toBe('0.10.0')
    expect(latestVersion(['aaa\trefs/tags/nightly'])).toBeNull()
  })
})

describe('rawFileUrl', () => {
  it('maps https and ssh GitHub remotes, and nothing else', () => {
    expect(rawFileUrl(REPO, '0.10.0', 'CHANGELOG.md')).toBe(
      'https://raw.githubusercontent.com/rocketflare-dev/rocketflare/0.10.0/CHANGELOG.md'
    )
    expect(rawFileUrl('git@github.com:acme/kit.git', '1.0.0', 'CHANGELOG.md')).toBe(
      'https://raw.githubusercontent.com/acme/kit/1.0.0/CHANGELOG.md'
    )
    expect(rawFileUrl('https://gitlab.com/acme/kit.git', '1.0.0', 'CHANGELOG.md')).toBeNull()
  })
})

describe('changelogSummaries', () => {
  it('takes each release summary between the two versions, newest first — from the real CHANGELOG', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8')
    const summaries = changelogSummaries(text, '0.8.0', '0.9.0')
    expect(summaries.map(s => s.version)).toEqual(['0.9.0', '0.8.1'])
    expect(summaries[0]?.summary).toMatch(/^A plugin's `agentTools` may now be async/)
    expect(summaries.every(s => !s.summary.includes('Porting note'))).toBe(true)
    expect(changelogSummaries(text, '0.9.0', '0.9.0')).toEqual([])
  })
})

describe('updateMessage', () => {
  it('is null when the copy is current or ahead', () => {
    expect(updateMessage({ current: '0.10.0', latest: '0.10.0', summaries: [] })).toBeNull()
    expect(updateMessage({ current: '0.11.0', latest: '0.10.0', summaries: [] })).toBeNull()
    expect(updateMessage({ current: '0.10.0', latest: null, summaries: [] })).toBeNull()
  })

  it('names both versions, lists the newest releases, counts the rest, and says to tell once', () => {
    const summaries = ['0.14.0', '0.13.0', '0.12.0', '0.11.0', '0.10.1'].map(v => ({
      version: v,
      summary: `what ${v} did`,
    }))
    const message = updateMessage({ current: '0.10.0', latest: '0.14.0', summaries }) ?? ''
    expect(message).toContain('update available: 0.14.0 (this app is on 0.10.0)')
    expect(message.match(/^- \d/gm)).toHaveLength(MAX_LISTED)
    expect(message).toContain('…and 2 earlier release(s)')
    expect(message).toContain('ONCE')
    expect(message).toContain('/rf-upgrade')
    expect(message).toContain('ROCKETFLARE_UPDATE_CHECK=0')
  })
})
