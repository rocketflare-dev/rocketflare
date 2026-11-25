/**
 * `scripts/lib/cloudflared.mjs` — `pnpm dev:tunnel` installs cloudflared lazily: the package is no
 * longer in `onlyBuiltDependencies`, so its postinstall (a ~38 MB download of the latest release)
 * never runs. The wrapper follows cfld's own order — override, PATH, managed binary — and only
 * installs when all three miss. No network: every side effect is injected.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CLOUDFLARED_PINNED_VERSION,
  cloudflaredVersion,
  ensureCloudflared,
  managedBinaryPath,
  planCloudflared,
} from '../../scripts/lib/cloudflared.mjs'

const PKG = '/fake/node_modules/cloudflared'
const BIN = managedBinaryPath(PKG)

function deps(overrides: Parameters<typeof ensureCloudflared>[0] = {}) {
  const present = new Set<string>()
  const install = vi.fn(async (_dir: string, _version: string) => {
    present.add(BIN)
    return true
  })
  return {
    present,
    install,
    opts: {
      env: {},
      fromDir: '/fake/apps/web',
      onPath: () => false,
      resolvePackageDir: () => PKG,
      exists: (f: string) => present.has(f),
      install,
      log: () => {},
      ...overrides,
    },
  }
}

describe('planCloudflared', () => {
  it('an override wins without probing anything', () => {
    const onPath = vi.fn(() => true)
    const managedExists = vi.fn(() => true)
    expect(planCloudflared({ env: { CFLD_CLOUDFLARED: '/x' }, onPath, managedExists })).toEqual({
      action: 'none',
      source: 'override',
    })
    expect(planCloudflared({ env: { CLOUDFLARED_BIN: '/y' }, onPath, managedExists }).action).toBe(
      'none'
    )
    expect(onPath).not.toHaveBeenCalled()
    expect(managedExists).not.toHaveBeenCalled()
  })

  it('an empty override does not count', () => {
    expect(
      planCloudflared({
        env: { CFLD_CLOUDFLARED: '' },
        onPath: () => true,
        managedExists: () => false,
      })
    ).toEqual({ action: 'none', source: 'path' })
  })

  it('PATH before the managed binary, managed before installing', () => {
    expect(planCloudflared({ env: {}, onPath: () => false, managedExists: () => true })).toEqual({
      action: 'none',
      source: 'managed',
    })
    expect(planCloudflared({ env: {}, onPath: () => false, managedExists: () => false })).toEqual({
      action: 'install',
    })
  })
})

describe('ensureCloudflared', () => {
  it('binary on PATH → no install', async () => {
    const d = deps({ onPath: () => true })
    expect(await ensureCloudflared(d.opts)).toEqual({ installed: false, source: 'path' })
    expect(d.install).not.toHaveBeenCalled()
  })

  it('managed binary present → no install', async () => {
    const d = deps()
    d.present.add(BIN)
    expect(await ensureCloudflared(d.opts)).toEqual({ installed: false, source: 'managed' })
    expect(d.install).not.toHaveBeenCalled()
  })

  it('nothing found → installs the pinned version into the package, once', async () => {
    const d = deps()
    expect(await ensureCloudflared(d.opts)).toEqual({
      installed: true,
      source: 'managed',
      bin: BIN,
    })
    expect(d.install).toHaveBeenCalledWith(PKG, CLOUDFLARED_PINNED_VERSION, {})
    // the second run finds what the first installed
    expect(await ensureCloudflared(d.opts)).toEqual({ installed: false, source: 'managed' })
    expect(d.install).toHaveBeenCalledTimes(1)
  })

  it('CLOUDFLARED_VERSION overrides the pin', async () => {
    const env = { CLOUDFLARED_VERSION: 'latest' }
    const d = deps({ env })
    await ensureCloudflared(d.opts)
    expect(d.install).toHaveBeenCalledWith(PKG, 'latest', env)
  })

  it('a failed install throws instead of letting cfld spawn a missing binary', async () => {
    const d = deps({ install: async () => false })
    await expect(ensureCloudflared(d.opts)).rejects.toThrow(/installing cloudflared .* failed/)
  })

  it('no cloudflared package (optional dep skipped) → a clear error', async () => {
    const d = deps({ resolvePackageDir: () => null })
    await expect(ensureCloudflared(d.opts)).rejects.toThrow(/package is not installed/)
    expect(d.install).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('the managed path matches the package layout', () => {
    expect(managedBinaryPath(PKG, 'linux')).toBe(path.join(PKG, 'bin', 'cloudflared'))
    expect(managedBinaryPath(PKG, 'win32')).toBe(path.join(PKG, 'bin', 'cloudflared.exe'))
  })

  it('the pin is a cloudflared release tag', () => {
    expect(CLOUDFLARED_PINNED_VERSION).toMatch(/^\d{4}\.\d{1,2}\.\d+$/)
    expect(cloudflaredVersion({})).toBe(CLOUDFLARED_PINNED_VERSION)
  })
})

describe('workspace wiring', () => {
  const root = path.resolve(__dirname, '../../../..')
  const workspace = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  const list = (key: string) =>
    (workspace.match(new RegExp(`^${key}:\\n((?:  - .*\\n?)+)`, 'm'))?.[1] ?? '')
      .split('\n')
      .map(l => l.replace(/^ {2}- /, '').trim())
      .filter(Boolean)

  it('cloudflared is never built on install — dev:tunnel installs it', () => {
    expect(list('onlyBuiltDependencies')).not.toContain('cloudflared')
    expect(list('onlyBuiltDependencies')).toEqual(expect.arrayContaining(['esbuild', 'workerd']))
    expect(list('ignoredBuiltDependencies')).toContain('cloudflared')
  })

  it('dev:tunnel goes through the wrapper', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
    expect(pkg.scripts['dev:tunnel']).toMatch(/^node scripts\/cfld\.mjs /)
    expect(pkg.scripts.cfld).toBe('node scripts/cfld.mjs')
  })
})
