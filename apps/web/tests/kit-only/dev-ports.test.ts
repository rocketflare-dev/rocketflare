/**
 * `scripts/lib/dev-ports.mjs` — the one reader of the local dev ports that Vite, the dev
 * supervisor, the bootstrap and the seed share. Unset means the kit's :3000 (UI) / :3001 (API), so
 * an existing checkout behaves exactly as before; the shell beats `apps/web/.dev.vars`; a value
 * that is not a port throws rather than silently landing on a default.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  devAllowedHosts,
  devPorts,
  resolveDevAllowedHosts,
  resolveDevPorts,
} from '../../../../scripts/lib/dev-ports.mjs'

describe('resolveDevPorts', () => {
  it('defaults to 3000 / 3001 when nothing is set', () => {
    expect(resolveDevPorts({}, {})).toEqual({ ui: 3000, api: 3001 })
    expect(resolveDevPorts()).toEqual({ ui: 3000, api: 3001 })
  })

  it('reads .dev.vars values when the shell has none', () => {
    expect(resolveDevPorts({}, { DEV_UI_PORT: '5199', DEV_API_PORT: '8799' })).toEqual({
      ui: 5199,
      api: 8799,
    })
  })

  it('lets the shell win over .dev.vars, key by key', () => {
    expect(
      resolveDevPorts({ DEV_UI_PORT: '4000' }, { DEV_UI_PORT: '5199', DEV_API_PORT: '8799' })
    ).toEqual({ ui: 4000, api: 8799 })
  })

  it('treats a blank value as unset', () => {
    expect(resolveDevPorts({ DEV_UI_PORT: '' }, { DEV_UI_PORT: ' ', DEV_API_PORT: '' })).toEqual({
      ui: 3000,
      api: 3001,
    })
  })

  it.each(['abc', '3000abc', '30.5', '-1', '0', '65536'])('rejects %s, naming the key', value => {
    expect(() => resolveDevPorts({ DEV_API_PORT: value })).toThrow(/DEV_API_PORT/)
  })

  it('rejects two servers on one port', () => {
    expect(() => resolveDevPorts({ DEV_UI_PORT: '3001' })).toThrow(/must differ/)
  })
})

describe('resolveDevAllowedHosts', () => {
  it('is empty when unset', () => {
    expect(resolveDevAllowedHosts({}, {})).toEqual([])
  })

  it('splits, trims and dedupes a comma-separated list; the shell wins', () => {
    expect(
      resolveDevAllowedHosts(
        {},
        { DEV_ALLOWED_HOSTS: ' a.example.com, ,b.example.com,a.example.com' }
      )
    ).toEqual(['a.example.com', 'b.example.com'])
    expect(
      resolveDevAllowedHosts({ DEV_ALLOWED_HOSTS: 'shell.example' }, { DEV_ALLOWED_HOSTS: 'file' })
    ).toEqual(['shell.example'])
  })
})

describe('devPorts / devAllowedHosts over a .dev.vars file', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const devVarsFile = (text: string) => {
    dir = mkdtempSync(path.join(tmpdir(), 'dev-ports-'))
    const file = path.join(dir, '.dev.vars')
    writeFileSync(file, text)
    return file
  }

  it('reads the file, ignoring commented keys', () => {
    const file = devVarsFile(
      '# DEV_UI_PORT=1111\nDEV_UI_PORT=5199\nDEV_API_PORT="8799"\nDEV_ALLOWED_HOSTS=x.example\n'
    )
    expect(devPorts({ env: {}, devVarsFile: file })).toEqual({ ui: 5199, api: 8799 })
    expect(devAllowedHosts({ env: {}, devVarsFile: file })).toEqual(['x.example'])
    expect(devPorts({ env: { DEV_API_PORT: '9000' }, devVarsFile: file })).toEqual({
      ui: 5199,
      api: 9000,
    })
  })

  it('falls back to the defaults when there is no .dev.vars yet', () => {
    const missing = path.join(tmpdir(), 'no-such-dir-dev-ports', '.dev.vars')
    expect(devPorts({ env: {}, devVarsFile: missing })).toEqual({ ui: 3000, api: 3001 })
    expect(devAllowedHosts({ env: {}, devVarsFile: missing })).toEqual([])
  })
})
