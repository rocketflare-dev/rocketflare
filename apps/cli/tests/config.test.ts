/** Config store tests (D26): temp dir, 0700/0600 permissions, env/flag precedence, key redaction. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createConfigStore,
  DEFAULT_SERVER_URL,
  fileMode,
  redactConfig,
  redactKey,
  resolveConfigDir,
} from '../src/config'
import { TEST_KEY, tempStore } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

describe('resolveConfigDir', () => {
  it('uses $HOME/.gmgo by default and honours GMGO_CONFIG_DIR', () => {
    expect(resolveConfigDir({ HOME: '/home/alice' })).toBe('/home/alice/.gmgo')
    expect(resolveConfigDir({ HOME: '/home/alice', GMGO_CONFIG_DIR: '/etc/gmgo' })).toBe(
      '/etc/gmgo'
    )
  })
})

describe('config store', () => {
  it('returns an empty config when the file does not exist', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    expect(await t.store.load()).toEqual({})
  })

  it('round-trips and writes dir 0700 / file 0600', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const config = {
      serverUrl: 'https://app.example.com',
      apiKey: TEST_KEY,
      tenantId: 't1',
      tenantName: 'Acme',
      user: { email: 'a@example.com', name: 'Alice' },
    }
    await t.store.save(config)
    expect(await t.store.load()).toEqual(config)
    expect(await fileMode(t.store.dir)).toBe(0o700)
    expect(await fileMode(t.store.file)).toBe(0o600)
    expect(JSON.parse(await readFile(t.store.file, 'utf8'))).toEqual(config)
  })

  it('tightens an existing loose file to 0600 on save', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.save({ serverUrl: 'http://a' })
    const { chmod } = await import('node:fs/promises')
    await chmod(t.store.file, 0o644)
    await t.store.update({ tenantId: 'x' })
    expect(await fileMode(t.store.file)).toBe(0o600)
  })

  it('update merges, clearCredentials keeps serverUrl, clear removes the file', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.update({
      serverUrl: 'http://a',
      apiKey: TEST_KEY,
      tenantId: 't',
      user: { email: 'e' },
    })
    await t.store.update({ tenantName: 'Acme' })
    expect(await t.store.load()).toMatchObject({ apiKey: TEST_KEY, tenantName: 'Acme' })
    await t.store.clearCredentials()
    expect(await t.store.load()).toEqual({ serverUrl: 'http://a' })
    await t.store.clear()
    expect(await fileMode(t.store.file)).toBeNull()
    expect(await t.store.load()).toEqual({})
  })

  it('rejects an invalid config file', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(t.store.dir, { recursive: true })
    await writeFile(join(t.store.dir, 'config.json'), JSON.stringify({ serverUrl: 'nope' }))
    await expect(t.store.load()).rejects.toThrow(/invalid/)
  })
})

describe('resolve precedence', () => {
  it('flag > GMGO_URL > config > default; GMGO_API_KEY > config', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const base = await t.store.resolve()
    expect(base).toMatchObject({
      serverUrl: DEFAULT_SERVER_URL,
      serverUrlSource: 'default',
      apiKey: undefined,
      apiKeySource: 'none',
    })

    await t.store.save({ serverUrl: 'http://from-config/', apiKey: 'config-key' })
    expect(await t.store.resolve()).toMatchObject({
      serverUrl: 'http://from-config',
      serverUrlSource: 'config',
      apiKey: 'config-key',
      apiKeySource: 'config',
    })

    const withEnv = createConfigStore({
      dir: t.store.dir,
      env: { GMGO_URL: 'http://from-env', GMGO_API_KEY: 'env-key' },
    })
    expect(await withEnv.resolve()).toMatchObject({
      serverUrl: 'http://from-env',
      serverUrlSource: 'env',
      apiKey: 'env-key',
      apiKeySource: 'env',
    })
    expect(await withEnv.resolve({ serverUrl: 'http://from-flag' })).toMatchObject({
      serverUrl: 'http://from-flag',
      serverUrlSource: 'flag',
    })
  })
})

describe('redaction', () => {
  it('shows only a prefix', () => {
    expect(redactKey(TEST_KEY)).toBe('gmgo_tes…')
    expect(redactKey('short')).toBe('****')
    expect(redactKey(undefined)).toBe('-')
    expect(redactConfig({ apiKey: TEST_KEY, tenantId: 't' })).toEqual({
      apiKey: 'gmgo_tes…',
      tenantId: 't',
    })
    expect(JSON.stringify(redactConfig({ apiKey: TEST_KEY }))).not.toContain(TEST_KEY)
  })
})
