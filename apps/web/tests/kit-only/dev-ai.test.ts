/**
 * `scripts/lib/dev-ai.mjs` — the local Workers AI switch, kept out of every tracked file.
 * `DEV_WORKERS_AI=off` (shell, then `.dev.vars`) makes every local `wrangler dev` launch run from a
 * generated, git-ignored copy of `wrangler.toml` without `[ai]`; the tomls themselves (and so
 * `worker-configuration.d.ts`) are never edited for it. Over a temp directory, never the checkout.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiBlockState } from '../../../../scripts/lib/bootstrap-lib.mjs'
import {
  devWorkersAiMode,
  OFFLINE_CONFIG,
  offlineConfigText,
  wranglerDevConfigArgs,
} from '../../../../scripts/lib/dev-ai.mjs'

const TOML = [
  'name = "app"',
  'main = "src/worker.ts"',
  '',
  '# Workers AI.',
  '[ai]',
  'binding = "AI"',
  'remote = true',
  '',
  '[[workflows]]',
  'binding = "AGENT_RUN_WORKFLOW"',
  '',
].join('\n')

describe('devWorkersAiMode', () => {
  it('is on unless DEV_WORKERS_AI says off', () => {
    expect(devWorkersAiMode()).toBe('on')
    expect(devWorkersAiMode({}, { DEV_WORKERS_AI: 'off' })).toBe('off')
    expect(devWorkersAiMode({}, { DEV_WORKERS_AI: 'false' })).toBe('off')
    expect(devWorkersAiMode({}, { DEV_WORKERS_AI: 'on' })).toBe('on')
  })

  it('lets the shell win over .dev.vars, and treats a blank value as unset', () => {
    expect(devWorkersAiMode({ DEV_WORKERS_AI: 'on' }, { DEV_WORKERS_AI: 'off' })).toBe('on')
    expect(devWorkersAiMode({ DEV_WORKERS_AI: 'off' }, {})).toBe('off')
    expect(devWorkersAiMode({ DEV_WORKERS_AI: ' ' }, { DEV_WORKERS_AI: 'off' })).toBe('off')
    expect(devWorkersAiMode({}, { DEV_WORKERS_AI: '' })).toBe('on')
  })
})

describe('offlineConfigText', () => {
  it('comments out [ai] and nothing else, under a generated header', () => {
    const text = offlineConfigText(TOML)
    expect(aiBlockState(text)).toBe('off')
    expect(text).toMatch(/^# GENERATED/)
    expect(text).toContain('\n[[workflows]]\nbinding = "AGENT_RUN_WORKFLOW"\n')
    expect(text).toContain('\nmain = "src/worker.ts"\n')
  })
})

describe('wranglerDevConfigArgs', () => {
  let web = ''
  beforeEach(() => {
    web = mkdtempSync(path.join(tmpdir(), 'dev-ai-'))
    writeFileSync(path.join(web, 'wrangler.toml'), TOML)
  })
  afterEach(() => rmSync(web, { recursive: true, force: true }))

  it('off: writes the offline config beside wrangler.toml and points wrangler at it', () => {
    writeFileSync(path.join(web, '.dev.vars'), 'APP_ENV=development\nDEV_WORKERS_AI=off\n')
    const r = wranglerDevConfigArgs({ webDir: web, env: {} })
    expect(r.mode).toBe('off')
    expect(r.args).toEqual(['--config', OFFLINE_CONFIG])
    expect(aiBlockState(readFileSync(path.join(web, OFFLINE_CONFIG), 'utf8'))).toBe('off')
    // The tracked toml is untouched.
    expect(readFileSync(path.join(web, 'wrangler.toml'), 'utf8')).toBe(TOML)
  })

  it('on: no extra arguments, and a stale offline config is removed', () => {
    writeFileSync(path.join(web, OFFLINE_CONFIG), 'stale')
    const r = wranglerDevConfigArgs({ webDir: web, env: {} })
    expect(r).toEqual({ mode: 'on', args: [], note: null })
    expect(existsSync(path.join(web, OFFLINE_CONFIG))).toBe(false)
  })

  it('names the recovery when the tracked toml itself is still commented out', () => {
    writeFileSync(
      path.join(web, 'wrangler.toml'),
      TOML.replace(
        '[ai]\nbinding = "AI"\nremote = true',
        '# [ai]\n# binding = "AI"\n# remote = true'
      )
    )
    const r = wranglerDevConfigArgs({ webDir: web, env: {} })
    expect(r.note).toMatch(/pnpm bootstrap --offline/)
  })
})
