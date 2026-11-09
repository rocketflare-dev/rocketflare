/** The containment rule shared by `plugin.mjs` and `upgrade.mjs`. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeWriter } from '../../../../scripts/lib/git-lib.mjs'
import { pluginSurfaces, readManifest } from '../../../../scripts/lib/manifest.mjs'
import { manifestPathProblems } from '../../../../scripts/lib/plugin-lib.mjs'
import {
  containedPath,
  repoPathProblem,
  writePathProblem,
} from '../../../../scripts/lib/repo-paths.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'rf-repo-paths-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('repoPathProblem', () => {
  it.each([
    'apps/web/src/index.ts',
    '.github/workflows/ci.yml',
    '.gitignore',
    'a/.gitkeep',
    'docs/plugins/x/readme.md',
  ])('accepts %s', rel => expect(repoPathProblem(rel)).toBeNull())

  it.each([
    ['', 'empty string'],
    ['/etc/passwd', 'absolute'],
    ['C:/x', 'windows absolute'],
    ['a\\b', 'backslash'],
    ['../x', 'leading parent'],
    ['a/../../x', 'inner parent'],
    ['a/./b', 'current directory'],
    ['a//b', 'empty segment'],
    ['.git/config', 'git directory'],
    ['a/.GIT/config', 'git directory in another case'],
    ['a/.git. /config', 'git directory with trailing dots and spaces'],
  ])('refuses %s (%s)', rel => expect(repoPathProblem(rel)).toEqual(expect.any(String)))

  it('refuses a value that is not a string', () => {
    expect(repoPathProblem(undefined)).toEqual(expect.any(String))
  })
})

describe('writePathProblem', () => {
  mkdirSync(path.join(root, 'real'), { recursive: true })
  mkdirSync(path.join(root, 'elsewhere'), { recursive: true })
  symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'real', 'link'))
  writeFileSync(path.join(root, 'elsewhere', 'target.txt'), 'x')
  symlinkSync(path.join(root, 'elsewhere', 'target.txt'), path.join(root, 'real', 'leaf'))

  it('accepts a path that does not exist yet', () => {
    expect(writePathProblem(path.join(root, 'real'), 'new/dir/file.txt')).toBeNull()
  })
  it('refuses a directory symlink on the path', () => {
    expect(writePathProblem(path.join(root, 'real'), 'link/file.txt')).toMatch(/symlink link/)
  })
  it('refuses a file that is itself a symlink', () => {
    expect(writePathProblem(path.join(root, 'real'), 'leaf')).toMatch(/symlink leaf/)
  })
  it('containedPath throws on a refused path and returns the join otherwise', () => {
    const real = path.join(root, 'real')
    expect(() => containedPath(real, '../escaped')).toThrow()
    expect(containedPath(real, 'ok/file')).toBe(path.join(real, 'ok/file'))
  })
  it('makeWriter refuses to leave its root', () => {
    const writer = makeWriter(path.join(root, 'work'))
    expect(() => writer.write('../escaped.txt', 'x')).toThrow()
    expect(writer.write('added/ok.txt', 'x')).toBe(path.join(root, 'work/added/ok.txt'))
  })
})

describe('manifestPathProblems', () => {
  const fields = (m: Record<string, unknown>) => manifestPathProblems(m, 'orders').map(p => p.field)

  it('accepts a manifest whose paths are all its own', () => {
    expect(
      fields({
        anchor: 'apps/web/src/plugins/orders/plugin.json',
        coreEdits: [{ file: 'apps/web/vite.config.ts', after: 'x', lines: [] }],
        dependencies: { 'apps/web': { zod: '4.0.0' } },
        paths: [
          'apps/web/src/plugins/orders/**',
          'docs/plugins/orders/**',
          '.claude/skills/orders-extra/**',
        ],
      })
    ).toEqual([])
  })

  it('refuses a path a plugin does not own', () => {
    expect(fields({ anchor: 'apps/web/src/plugins/other/plugin.json' })).toEqual(['anchor'])
    expect(fields({ anchor: '.claude/skills/orders/plugin.json' })).toEqual(['anchor'])
    expect(fields({ paths: ['apps/web/src/api/**'] })).toEqual(['paths'])
    expect(fields({ paths: ['.claude/skills/rf-plugin/**'] })).toEqual(['paths'])
    expect(fields({ paths: ['../x/*'] })).toEqual(['paths'])
    expect(fields({ coreEdits: [{ file: '../x', after: 'x', lines: [] }] })).toEqual(['coreEdits'])
    expect(fields({ coreEdits: [{ after: 'x', lines: [] }] })).toEqual(['coreEdits'])
    expect(fields({ dependencies: { '../x': {} } })).toEqual(['dependencies'])
  })

  it('accepts the surfaces this repository records', () => {
    const { manifest } = readManifest(path.resolve(__dirname, '../../../..'))
    for (const surface of pluginSurfaces(manifest)) {
      expect(manifestPathProblems(surface, surface.id)).toEqual([])
    }
  })
})
