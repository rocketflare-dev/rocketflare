/**
 * `.github/ci-plugins.json`: the plugins the kit's OWN CI installs on top of `defaultPlugins`.
 * A fresh clone installs `defaultPlugins` (empty — analytics is opt-in); kit.yml's `plugins` job
 * and `kit:release` read the union, so analytics stays proven on every kit pull request.
 * Kit-only: the file, `scripts/default-plugins.mjs` and kit.yml are all deleted by the rename.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CI_PLUGINS_FILE,
  ciPluginEntries,
  readCiPlugins,
} from '../../../../scripts/default-plugins.mjs'
import { defaultPluginEntryProblems } from '../../../../scripts/lib/upgrade-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
const A = { id: 'a', repo: 'https://x.test/a.git', ref: '1.0.0' }
const B = { id: 'b', repo: 'https://x.test/b.git', ref: '2.0.0', subdir: 'plugins/b' }

describe('ciPluginEntries', () => {
  it('is defaultPlugins followed by the CI-only entries', () => {
    expect(ciPluginEntries({ defaultPlugins: [A] }, [B]).map(e => e.id)).toEqual(['a', 'b'])
    expect(ciPluginEntries({ defaultPlugins: [] }, [B])).toMatchObject([B])
    expect(ciPluginEntries({}, [])).toEqual([])
  })

  it('installs an id in both lists once, at the default pin', () => {
    const entries = ciPluginEntries({ defaultPlugins: [A] }, [{ ...A, ref: '9.9.9' }])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject(A)
  })
})

describe('the committed lists', () => {
  it('a fresh clone of the kit installs no plugin', () => {
    expect(manifest.defaultPlugins).toEqual([])
  })

  it(`${CI_PLUGINS_FILE} keeps analytics in CI, pinned, and well formed`, () => {
    const entries = ciPluginEntries(manifest, readCiPlugins(REPO_ROOT))
    expect(defaultPluginEntryProblems(entries)).toEqual([])
    const analytics = entries.find(e => e.id === 'analytics')
    expect(analytics?.ref).toMatch(/^\d+\.\d+\.\d+$/)
    expect(analytics?.subdir).toBe('plugins/analytics')
  })

  it('is kitOnly, so a renamed copy carries no CI list of the kit', () => {
    expect(manifest.kitOnly).toContain(CI_PLUGINS_FILE)
  })
})
