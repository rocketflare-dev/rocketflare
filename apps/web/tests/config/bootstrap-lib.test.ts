/**
 * Pure helpers behind `scripts/bootstrap.mjs` (the one-shot first run), no database: the `.nvmrc`
 * / version parsers, `fillDevVars` (never overwrites a value a person typed), `toggleAiBlock` (the
 * `[ai]` block of BOTH real tomls round-trips byte-identically and, once off, parses with no `ai`
 * table so the parity test stays green), and the two stdout parsers (`pnpm seed`, `wrangler whoami`).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import {
  aiBlockState,
  extractSeedKey,
  fillDevVars,
  parseNvmrc,
  parseWhoami,
  readDevVars,
  toggleAiBlock,
  versionAtLeast,
} from '../../../../scripts/lib/bootstrap-lib.mjs'

const WEB_DIR = path.resolve(__dirname, '../..')
const readWeb = (file: string) => fs.readFileSync(path.join(WEB_DIR, file), 'utf8')

describe('parseNvmrc / versionAtLeast', () => {
  it('reads the major from the common .nvmrc shapes', () => {
    expect(parseNvmrc('24\n')).toBe(24)
    expect(parseNvmrc('v24.1.0')).toBe(24)
    expect(parseNvmrc('lts/*')).toBeNaN()
    expect(parseNvmrc(readWeb('../../.nvmrc'))).toBe(24)
  })

  it('compares majors, tolerating a v prefix and junk', () => {
    expect(versionAtLeast('v24.16.0', 24)).toBe(true)
    expect(versionAtLeast('25.0.0-pre', 24)).toBe(true)
    expect(versionAtLeast('v22.12.0', 24)).toBe(false)
    expect(versionAtLeast(undefined, 24)).toBe(false)
    expect(versionAtLeast('node: command not found', 24)).toBe(false)
  })
})

describe('fillDevVars', () => {
  const EXAMPLE = [
    '# Copy to `.dev.vars`',
    'APP_ENV=development',
    'DATABASE_URL=postgresql://x:y@localhost:5432/z',
    '# AES-GCM key. Generate: openssl rand -hex 32',
    'OAUTH_ENCRYPTION_KEY=',
    '',
    '# --- Optional ---',
    'RESEND_API_KEY=',
    '',
  ].join('\n')
  const REQUIRED = ['OAUTH_ENCRYPTION_KEY']
  const HEX = /^[0-9a-f]{64}$/
  const gen = () => 'a'.repeat(64)

  it('absent file → the example with the required keys generated', () => {
    const { text, filled, missing } = fillDevVars(EXAMPLE, null, gen, REQUIRED)
    expect(filled).toEqual(['OAUTH_ENCRYPTION_KEY'])
    expect(missing).toEqual([])
    expect(readDevVars(text).OAUTH_ENCRYPTION_KEY).toBe('a'.repeat(64))
    expect(readDevVars(text).RESEND_API_KEY).toBe('')
    expect(text).toContain('# AES-GCM key. Generate: openssl rand -hex 32')
    expect(text.replace('a'.repeat(64), '')).toBe(EXAMPLE)
  })

  it('existing file: a non-empty value is never overwritten, an empty required key is filled', () => {
    const existing = EXAMPLE.replace(
      'DATABASE_URL=postgresql://x:y@localhost:5432/z',
      'DATABASE_URL=mine'
    )
      .replace('RESEND_API_KEY=', 'RESEND_API_KEY=re_live')
      .concat('AUTH_SIGNING_KEY=keep-me\n')
    const { text, filled, missing } = fillDevVars(EXAMPLE, existing, gen, REQUIRED)
    const values = readDevVars(text)
    expect(filled).toEqual(['OAUTH_ENCRYPTION_KEY'])
    expect(missing).toEqual([])
    expect(values.DATABASE_URL).toBe('mine')
    expect(values.RESEND_API_KEY).toBe('re_live')
    expect(values.AUTH_SIGNING_KEY).toBe('keep-me')
    expect(values.OAUTH_ENCRYPTION_KEY).toBe('a'.repeat(64))
    expect(text.split('\n')[0]).toBe('# Copy to `.dev.vars`')
  })

  it('a filled required key is left alone on the second run (idempotent)', () => {
    const first = fillDevVars(EXAMPLE, null, gen, REQUIRED).text
    const second = fillDevVars(EXAMPLE, first, () => 'b'.repeat(64), REQUIRED)
    expect(second.filled).toEqual([])
    expect(second.text).toBe(first)
  })

  it('reports optional keys the file lacks and appends an absent required key', () => {
    const existing = 'APP_ENV=development\nOAUTH_ENCRYPTION_KEY=""\n'
    const { text, filled, missing } = fillDevVars(EXAMPLE, existing, gen, REQUIRED)
    expect(filled).toEqual(['OAUTH_ENCRYPTION_KEY'])
    expect(missing).toEqual(['DATABASE_URL', 'RESEND_API_KEY'])
    expect(readDevVars(text).OAUTH_ENCRYPTION_KEY).toBe('a'.repeat(64))

    const bare = fillDevVars(EXAMPLE, 'APP_ENV=development\n', gen, REQUIRED)
    expect(bare.filled).toEqual(['OAUTH_ENCRYPTION_KEY'])
    expect(bare.text).toBe(`APP_ENV=development\nOAUTH_ENCRYPTION_KEY=${'a'.repeat(64)}\n`)
  })

  it('the real example, filled with a real generator, yields a 64-hex key', () => {
    const example = readWeb('.dev.vars.example')
    const { text, filled } = fillDevVars(
      example,
      null,
      () => randomBytes(32).toString('hex'),
      REQUIRED
    )
    expect(filled).toEqual(['OAUTH_ENCRYPTION_KEY'])
    expect(readDevVars(text).OAUTH_ENCRYPTION_KEY).toMatch(HEX)
  })
})

describe('toggleAiBlock / aiBlockState', () => {
  const SAMPLE = [
    '[[r2_buckets]]',
    'binding = "FILES"',
    '',
    '# Workers AI (D17): zero-key embeddings.',
    '[ai]',
    'binding = "AI"',
    '# Comment this block out to run fully offline.',
    'remote = true',
    '',
    '# Agent runs (D7).',
    '[[workflows]]',
    'name = "rocketflare-agent-run"',
    '',
  ].join('\n')

  it('off comments every line of the block and nothing else', () => {
    const off = toggleAiBlock(SAMPLE, 'off')
    expect(off).toBe(
      SAMPLE.replace(
        '[ai]\nbinding = "AI"\n# Comment this block out to run fully offline.\nremote = true',
        '# [ai]\n# binding = "AI"\n# # Comment this block out to run fully offline.\n# remote = true'
      )
    )
    expect(aiBlockState(off)).toBe('off')
    expect(off).toContain('\n[[workflows]]\nname = "rocketflare-agent-run"\n')
    expect(off).toContain('\n# Workers AI (D17): zero-key embeddings.\n')
  })

  it('off → on is byte-identical; both directions are idempotent; absent is untouched', () => {
    const off = toggleAiBlock(SAMPLE, 'off')
    expect(toggleAiBlock(off, 'on')).toBe(SAMPLE)
    expect(toggleAiBlock(off, 'off')).toBe(off)
    expect(toggleAiBlock(SAMPLE, 'on')).toBe(SAMPLE)
    const none = '[vars]\nAPP_ENV = "x"\n'
    expect(aiBlockState(none)).toBe('absent')
    expect(toggleAiBlock(none, 'off')).toBe(none)
  })

  it.each(['wrangler.toml', 'wrangler.staging.toml'])(
    '%s: on today; off drops the `ai` table for the parser and round-trips',
    file => {
      const original = readWeb(file)
      expect(aiBlockState(original)).toBe('on')
      expect((TOML.parse(original) as Record<string, unknown>).ai).toBeDefined()

      const off = toggleAiBlock(original, 'off')
      const parsed = TOML.parse(off) as Record<string, unknown>
      expect(parsed.ai).toBeUndefined()
      // Everything else survives: same tables, same values.
      const { ai: _ai, ...rest } = TOML.parse(original) as Record<string, unknown>
      expect(parsed).toEqual(rest)
      expect(toggleAiBlock(off, 'on')).toBe(original)
    }
  )
})

describe('extractSeedKey', () => {
  const FRESH = [
    'Seeding (multi-tenant mode)…',
    '  tenant  Acme (acme)',
    '  user    owner@example.test       owner',
    '',
    '  API key (shown ONCE — only its hash is stored):',
    '    rocketflare_abcDEF123-_abcDEF123-_abcDEF123-_abcDEF1',
    '',
    'Sign in locally (APP_ENV=development) without email:',
    '  curl -sS -X POST http://localhost:3001/auth/dev-login \\',
  ].join('\n')

  it('captures the key printed after the one-time banner', () => {
    expect(extractSeedKey(FRESH)).toBe('rocketflare_abcDEF123-_abcDEF123-_abcDEF123-_abcDEF1')
  })

  it('is undefined for the "already exists" variant and for empty output', () => {
    const again = FRESH.replace(
      / {2}API key \(shown ONCE[^\n]*\n[^\n]*\n/,
      '  API key rocketflare_abcD… already exists (revoke it and re-seed to mint a new one)\n'
    )
    expect(extractSeedKey(again)).toBeUndefined()
    expect(extractSeedKey('')).toBeUndefined()
  })
})

describe('parseWhoami', () => {
  const LOGGED_IN = [
    '',
    ' ⛅️ wrangler 4.127.1',
    '────────────────────',
    'Getting User settings...',
    '👋 You are logged in with an OAuth Token, associated with the email dev@example.com.',
    '🔐 Credentials are stored in: /Users/dev/Library/Preferences/.wrangler/config/default.toml',
    '┌────────────────────────┬──────────────────────────────────┐',
    '│ Account Name           │ Account ID                       │',
    '├────────────────────────┼──────────────────────────────────┤',
    "│ Dev's Account          │ 0123456789abcdef0123456789abcdef │",
    '└────────────────────────┴──────────────────────────────────┘',
    '🔓 Token Permissions:',
    '- account (read)',
  ].join('\n')
  const LOGGED_OUT = [
    ' ⛅️ wrangler 4.127.1',
    '────────────────────',
    'Getting User settings...',
    'You are not authenticated. Please run `wrangler login`.',
  ].join('\n')

  it('logged in: email and the first account row', () => {
    expect(parseWhoami(LOGGED_IN)).toEqual({
      loggedIn: true,
      email: 'dev@example.com',
      account: "Dev's Account",
    })
  })

  it('logged out, empty and undefined output → not logged in', () => {
    expect(parseWhoami(LOGGED_OUT)).toEqual({ loggedIn: false })
    expect(parseWhoami('')).toEqual({ loggedIn: false })
    expect(parseWhoami(undefined)).toEqual({ loggedIn: false })
  })

  it('an API token session (no email line) is still logged in', () => {
    const token = LOGGED_IN.replace(
      /👋 You are logged in[^\n]*/,
      '👋 You are logged in with an API Token, associated with the email ci@example.com.'
    )
    expect(parseWhoami(token).loggedIn).toBe(true)
    expect(parseWhoami(token).email).toBe('ci@example.com')
  })
})
