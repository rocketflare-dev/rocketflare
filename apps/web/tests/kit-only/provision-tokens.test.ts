/**
 * `scripts/provision/env-file.ts` — the pure half of `apps/web/.provision.env` handling (config
 * project, no filesystem): parsing with `.dev.vars` conventions, comment-preserving upsert, the
 * mask, the env-beats-file resolver, the missing-token hint, and that a registered token value can
 * never come out of `redact()`. Fixture values are obviously fake.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  maskToken,
  missingTokenHint,
  parseEnvFile,
  REDACT_EXEMPT_KEYS,
  resolveToken,
  secretValuesOf,
  upsertEnvFile,
} from '../../scripts/provision/env-file'
import { clearRegisteredSecrets, redact, registerSecrets } from '../../scripts/provision/redact'

const FILE = `# header comment — never a credential
# another line

CLOUDFLARE_API_TOKEN=cfFAKEtokenFAKEtokenFAKEtokenFAKEtoken
export CLOUDFLARE_ACCOUNT_ID = abcdef12abcdef12abcdef12abcdef12
NEON_API_KEY="napi_fakefakefakefakefake"
RESEND_API_KEY='re_FAKEFAKE_fakefakefakefake'
BOOTSTRAP_ADMIN_EMAILS=
not a line
  # indented comment
LANGFUSE_SECRET_KEY=  spaced-out-value
`

describe('parseEnvFile', () => {
  it('reads KEY=VALUE with comments, blanks, export and quotes tolerated', () => {
    const v = parseEnvFile(FILE)
    expect(v).toEqual({
      CLOUDFLARE_API_TOKEN: 'cfFAKEtokenFAKEtokenFAKEtokenFAKEtoken',
      CLOUDFLARE_ACCOUNT_ID: 'abcdef12abcdef12abcdef12abcdef12',
      NEON_API_KEY: 'napi_fakefakefakefakefake',
      RESEND_API_KEY: 're_FAKEFAKE_fakefakefakefake',
      LANGFUSE_SECRET_KEY: 'spaced-out-value',
    })
    expect(v).not.toHaveProperty('BOOTSTRAP_ADMIN_EMAILS')
  })
  it('accepts CRLF and lets a later line win', () => {
    expect(parseEnvFile('A=1\r\nA=2\r\n')).toEqual({ A: '2' })
    expect(parseEnvFile('')).toEqual({})
  })
  it('drops an inline comment after an unquoted value, keeps a # inside quotes', () => {
    expect(parseEnvFile('A=napi_x  # my key\nB="keep # this"\nC=no#space')).toEqual({
      A: 'napi_x',
      B: 'keep # this',
      C: 'no#space',
    })
  })
})

describe('upsertEnvFile', () => {
  it('replaces existing keys in place (export and blank ones too) and preserves everything else', () => {
    const out = upsertEnvFile(FILE, {
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      BOOTSTRAP_ADMIN_EMAILS: 'me@example.com',
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('# header comment — never a credential')
    expect(lines[3]).toBe('CLOUDFLARE_API_TOKEN=cfFAKEtokenFAKEtokenFAKEtokenFAKEtoken')
    expect(lines[4]).toBe('CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef')
    expect(lines[7]).toBe('BOOTSTRAP_ADMIN_EMAILS=me@example.com')
    expect(out).toContain('not a line')
    expect(out).toContain('  # indented comment')
    expect(out.endsWith('\n')).toBe(true)
    expect(parseEnvFile(out).CLOUDFLARE_ACCOUNT_ID).toBe('0123456789abcdef0123456789abcdef')
  })
  it('appends keys the file does not mention and quotes values that need it', () => {
    const out = upsertEnvFile('# only a comment\n', { NEW_KEY: 'plain', SPACED: 'a b#c' })
    expect(out).toBe('# only a comment\nNEW_KEY=plain\nSPACED="a b#c"\n')
    expect(parseEnvFile(out)).toEqual({ NEW_KEY: 'plain', SPACED: 'a b#c' })
  })
  it('is idempotent', () => {
    const once = upsertEnvFile(FILE, { NEON_API_KEY: 'napi_otherfakefakefake' })
    expect(upsertEnvFile(once, { NEON_API_KEY: 'napi_otherfakefakefake' })).toBe(once)
  })
})

describe('maskToken', () => {
  it('shows a prefix and the last four, never the middle', () => {
    expect(maskToken('re_FAKEFAKE_fakefakefakefake')).toBe('re_…fake')
    expect(maskToken('short')).toBe('••••')
    expect(maskToken(undefined)).toBe('(not set)')
  })
})

describe('resolveToken', () => {
  const file = { NEON_API_KEY: 'napi_fromfile_fakefake', RESEND_API_KEY: 're_fromfile_fakefake' }
  it('prefers the environment, falls back to the file, trims both', () => {
    expect(resolveToken('NEON_API_KEY', { NEON_API_KEY: ' napi_fromenv_fakefake ' }, file)).toEqual(
      {
        value: 'napi_fromenv_fakefake',
        source: 'env',
      }
    )
    expect(resolveToken('RESEND_API_KEY', {}, file)).toEqual({
      value: 're_fromfile_fakefake',
      source: 'file',
    })
  })
  it('treats an empty environment value as unset and reports a missing token as undefined', () => {
    expect(resolveToken('NEON_API_KEY', { NEON_API_KEY: '' }, file)?.source).toBe('file')
    expect(
      resolveToken('CLOUDFLARE_API_TOKEN', { CLOUDFLARE_API_TOKEN: '  ' }, file)
    ).toBeUndefined()
  })
})

describe('missingTokenHint', () => {
  it('names the three ways in and the minting URL', () => {
    const hint = missingTokenHint('NEON_API_KEY', { url: 'https://example.test/keys', scopes: 'x' })
    expect(hint).toContain('pnpm provision tokens')
    expect(hint).toContain('apps/web/.provision.env.example')
    expect(hint).toContain('export the variable')
    expect(hint).toContain('https://example.test/keys')
    expect(missingTokenHint('CLOUDFLARE_ACCOUNT_ID')).not.toContain('Mint:')
  })
})

describe('registered token values never survive redact()', () => {
  afterEach(() => clearRegisteredSecrets())
  it('masks a Cloudflare-shaped token (matches no pattern) once registered', () => {
    const cf = 'cfFAKEtokenFAKEtokenFAKEtokenFAKEtoken'
    expect(redact(`token=${cf}`)).toBe(`token=${cf}`) // no shape pattern catches it
    const values = secretValuesOf(parseEnvFile(FILE))
    registerSecrets(values)
    for (const value of values) expect(redact(`x ${value} y`)).not.toContain(value)
    expect(redact(`token=${cf}`)).toBe('token=<redacted>')
  })
  it('exempts the identifiers preflight prints (account id, admin email)', () => {
    const parsed = parseEnvFile(`${FILE}BOOTSTRAP_ADMIN_EMAILS=me@example.com\n`)
    const values = secretValuesOf(parsed)
    expect(values).not.toContain(parsed.CLOUDFLARE_ACCOUNT_ID)
    expect(values).not.toContain('me@example.com')
    expect(values).toContain(parsed.NEON_API_KEY)
    expect([...REDACT_EXEMPT_KEYS]).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'BOOTSTRAP_ADMIN_EMAILS'])
    registerSecrets(values)
    expect(redact(`account ${parsed.CLOUDFLARE_ACCOUNT_ID}`)).toContain(
      parsed.CLOUDFLARE_ACCOUNT_ID
    )
  })
  it('ignores short values so a common word is not masked', () => {
    registerSecrets(['abc', undefined])
    expect(redact('abc')).toBe('abc')
  })
})
