/**
 * `scripts/rename.mjs`'s pure half (`scripts/lib/rename-lib.mjs`): name derivation, the ordered
 * replacement classes and the careful-row arithmetic. No database, no filesystem — the `config`
 * project. This file is on the tool's exclusion list precisely because it asserts on the kit's
 * own token strings.
 */
import { describe, expect, it } from 'vitest'
import {
  API_KEY_HANDLE_MARGIN,
  applyColour,
  applyReplacements,
  CLASS_IDS,
  deriveNames,
  EXCLUDED_DIRS,
  EXCLUDED_PATHS,
  hexToRgb,
  isBinary,
  isExcluded,
  KIT,
  parseArgs,
  prefixGuard,
  REDACTED_KEY_MARGIN,
  readIntConstant,
  rewriteIntConstant,
  rewritePrefixComments,
  validateSlug,
} from '../../../../scripts/lib/rename-lib.mjs'

describe('deriveNames', () => {
  it('derives snake, UPPER, display and the placeholder domain from a hyphenated slug', () => {
    expect(deriveNames('my-app')).toEqual({
      slug: 'my-app',
      snake: 'my_app',
      upper: 'MY_APP',
      display: 'My App',
      domain: 'my-app.example.com',
      prefix: 'my_app_',
      colour: null,
    })
  })

  it('takes an explicit display name, domain and colour', () => {
    const names = deriveNames('acme', 'ACME Corp', { domain: 'Acme.IO', colour: '#FF0000' })
    expect(names.display).toBe('ACME Corp')
    expect(names.domain).toBe('acme.io')
    expect(names.colour).toBe('#ff0000')
    expect(names.snake).toBe('acme')
    expect(names.upper).toBe('ACME')
  })

  it('rejects a bad domain or colour', () => {
    expect(() => deriveNames('acme', undefined, { domain: 'nodots' })).toThrow(/apex host/)
    expect(() => deriveNames('acme', undefined, { colour: 'red' })).toThrow(/6-digit hex/)
  })
})

describe('validateSlug', () => {
  it('accepts lowercase slugs with digits and hyphens', () => {
    expect(validateSlug('acme')).toBeNull()
    expect(validateSlug('my-app2')).toBeNull()
  })

  it('refuses the kit name, uppercase, leading digits, underscores and a trailing hyphen', () => {
    expect(validateSlug(KIT.slug)).toMatch(/kit's own name/)
    expect(validateSlug('MyApp')).toMatch(/must match/)
    expect(validateSlug('1app')).toMatch(/must match/)
    expect(validateSlug('my_app')).toMatch(/must match/)
    expect(validateSlug('my-')).toMatch(/trailing|end with a hyphen/)
    expect(validateSlug('')).toMatch(/required/)
  })
})

/** One paragraph with every token class the kit ships. */
const SAMPLE = [
  'import { x } from "@rocketflare/shared/ai/config" // @rocketflare/web',
  "ROCKETFLARE_API_KEY=… ROCKETFLARE_URL=… ENV_PREFIX = 'ROCKETFLARE'",
  "~/.rocketflare/config.json and CONFIG_DIR_NAME = '.rocketflare' and $HOME/.rocketflare",
  'noreply@rocketflare.dev app.rocketflare.dev staging.rocketflare.dev admin@rocketflare.local',
  'postgresql://rocketflare:rocketflare_pass@localhost:5432/rocketflare_dev',
  'POSTGRES_USER: rocketflare',
  'pg_isready -U rocketflare -d rocketflare_dev',
  'rocketflare_app rocketflare_test rocketflare_ab12cd34',
  'rocketflare-agent-run-staging rocketflare-jobs rocketflare-files-staging rocketflare-light',
  'APP_NAME=Rocketflare Test <title>Rocketflare</title>',
  'name = "rocketflare" bin rocketflare, cfld.name rocketflare; container rocketflare-dev-postgres',
  'https://github.com/rocketflare-dev/rocketflare.git stays',
].join('\n')

describe('applyReplacements', () => {
  it('renames every class for a hyphenated slug without partial-form mismatches', () => {
    const names = deriveNames('my-app')
    const { text, counts, preserved } = applyReplacements(SAMPLE, names)
    expect(text).toBe(
      [
        'import { x } from "@my-app/shared/ai/config" // @my-app/web',
        "MY_APP_API_KEY=… MY_APP_URL=… ENV_PREFIX = 'MY_APP'",
        "~/.my-app/config.json and CONFIG_DIR_NAME = '.my-app' and $HOME/.my-app",
        'noreply@my-app.example.com app.my-app.example.com staging.my-app.example.com admin@my-app.example.com',
        'postgresql://my_app:my_app_pass@localhost:5432/my_app_dev',
        'POSTGRES_USER: my_app',
        'pg_isready -U my_app -d my_app_dev',
        'my_app_app my_app_test my_app_ab12cd34',
        'my-app-agent-run-staging my-app-jobs my-app-files-staging my-app-light',
        'APP_NAME=My App Test <title>My App</title>',
        'name = "my-app" bin my-app, cfld.name my-app; container my-app-dev-postgres',
        'https://github.com/rocketflare-dev/rocketflare.git stays',
      ].join('\n')
    )
    // The classic mismatches: scope/env must not pick up the hyphenated or snake forms.
    expect(text).not.toMatch(/my-app_|@my_app\/|MY-APP|my_app-|\.my_app\b/)
    expect(text).toContain('-staging')
    expect(preserved).toBe(1)
    expect(counts).toEqual({
      scope: 2,
      env: 3,
      domain: 4,
      cfgdir: 3,
      dbuser: 3,
      snake: 6,
      kebab: 5,
      display: 2,
      bare: 3,
    })
  })

  it('collapses every class to the same word for a single-word slug', () => {
    const { text } = applyReplacements(SAMPLE, deriveNames('acme', 'Acme Ops'))
    expect(text).toContain('@acme/shared')
    expect(text).toContain('ACME_API_KEY')
    expect(text).toContain('~/.acme/config.json')
    expect(text).toContain('noreply@acme.example.com')
    expect(text).toContain('postgresql://acme:acme_pass@localhost:5432/acme_dev')
    expect(text).toContain('acme_app')
    expect(text).toContain('acme-agent-run-staging')
    expect(text).toContain('APP_NAME=Acme Ops Test')
    expect(text.replaceAll(KIT.preserved[0], '')).not.toMatch(/[Rr]ocketflare/)
  })

  it('applies the classes longest-first: the env class takes the bare ENV_PREFIX too', () => {
    const { text, counts } = applyReplacements("'ROCKETFLARE' ROCKETFLARE_X", deriveNames('a-b'))
    expect(text).toBe("'A_B' A_B_X")
    expect(counts.env).toBe(2)
    expect(counts.bare).toBe(0)
  })

  it('keeps the domain ahead of the config-dir class (app.rocketflare.dev is not a config dir)', () => {
    const { text, counts } = applyReplacements('https://app.rocketflare.dev', deriveNames('a-b'))
    expect(text).toBe('https://app.a-b.example.com')
    expect(counts.cfgdir).toBe(0)
  })

  it('returns the identical string and zero counts when nothing matches', () => {
    const input = 'nothing to see here'
    const result = applyReplacements(input, deriveNames('acme'))
    expect(result.text).toBe(input)
    expect(result.total).toBe(0)
  })

  it('table columns are the class ids in application order', () => {
    expect(CLASS_IDS).toEqual([
      'scope',
      'env',
      'domain',
      'cfgdir',
      'dbuser',
      'snake',
      'kebab',
      'display',
      'bare',
    ])
  })
})

describe('exclusions', () => {
  it('lists the files that must survive the pass', () => {
    for (const p of [
      'pnpm-lock.yaml',
      'LICENSE',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'apps/web/src/ui/public/logo.svg',
      'apps/web/src/ui/public/favicon.svg',
      'scripts/rename.mjs',
      'scripts/lib/rename-lib.mjs',
      'scripts/lib/rename-lib.d.mts',
      'apps/web/tests/config/rename-lib.test.ts',
      '.claude/skills/adapt/SKILL.md',
      '.claude/skills/adapt/checklist.md',
    ]) {
      expect(EXCLUDED_PATHS, p).toContain(p)
      expect(isExcluded(p), p).toBe(true)
    }
    for (const d of ['node_modules', 'dist', '.git', '.wrangler'])
      expect(EXCLUDED_DIRS).toContain(d)
    expect(isExcluded('apps/web/node_modules/x/package.json')).toBe(true)
    expect(isExcluded('apps/web/dist/ui/index.html')).toBe(true)
    expect(isExcluded('apps/web/migrations/0000_cute_violations.sql')).toBe(false)
    expect(isExcluded('apps/web/migrations/meta/0000_snapshot.json')).toBe(false)
    expect(isExcluded('apps/web/wrangler.staging.toml')).toBe(false)
  })

  it('spots a binary by a NUL byte in the head', () => {
    expect(isBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true)
    expect(isBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
  })
})

describe('prefix guard (row a)', () => {
  it('sets both handle lengths to prefix + margin for a longer prefix', () => {
    const g = prefixGuard(deriveNames('northwind-traders'), {
      apiKeyPrefixLength: 20,
      redactedKeyChars: 16,
    })
    expect(g.prefix).toBe('northwind_traders_')
    expect(g.prefixLength).toBe(18)
    expect(g.apiKeyPrefixLength).toEqual({ current: 20, required: 26, change: true })
    expect(g.redactedKeyChars).toEqual({ current: 16, required: 22, change: true })
    expect(API_KEY_HANDLE_MARGIN).toBe(8)
    expect(REDACTED_KEY_MARGIN).toBe(4)
  })

  it('shrinks them for a shorter prefix (the CLI tests assume prefix + 4 exactly)', () => {
    const g = prefixGuard(deriveNames('acme'), { apiKeyPrefixLength: 20, redactedKeyChars: 16 })
    expect(g.apiKeyPrefixLength).toEqual({ current: 20, required: 13, change: true })
    expect(g.redactedKeyChars).toEqual({ current: 16, required: 9, change: true })
  })

  it('reads and rewrites the constants and their arithmetic comments', () => {
    const hash =
      "export const API_KEY_PREFIX = 'acme'\n" +
      'export const API_KEY_PREFIX_LENGTH = 20 // `acme_` (12) + 8 chars — must exceed the prefix\n'
    expect(readIntConstant(hash, 'API_KEY_PREFIX_LENGTH')).toBe(20)
    expect(readIntConstant(hash, 'NOPE')).toBeNull()
    const out = rewriteIntConstant(hash, 'API_KEY_PREFIX_LENGTH', 13, 'acme_', 8)
    expect(out).toContain('export const API_KEY_PREFIX_LENGTH = 13 // `acme_` (5) + 8 chars')
    const cli = '/** Characters shown of a key: `acme_` (12) + 4 — never the full secret. */\n'
    expect(rewritePrefixComments(cli, 'acme_', 4)).toContain('`acme_` (5) + 4 — never')
  })
})

describe('colour (row e)', () => {
  it('rewrites the light primary everywhere it appears, the rgb triple and the meta tag', () => {
    const css = [
      '@plugin "daisyui/theme" { name: "x-light";',
      '  --color-primary: #2563eb; /* blue-600 */',
      '  --color-primary-content: #ffffff;',
      '  --surface-active: color-mix(in srgb, #2563eb 10%, #ffffff);',
      '  --focus-ring: #2563eb; }',
      '@plugin "daisyui/theme" { name: "x-dark"; --color-primary: #60a5fa; }',
      ':root { --dc-primary-rgb: 37, 99, 235; }',
    ].join('\n')
    const html = '<meta name="theme-color" content="#2563eb" />'
    const r = applyColour({ css, html }, '#b91c1c')
    expect(r.from).toBe('#2563eb')
    expect(r.cssReplacements).toBe(3)
    expect(r.css).not.toContain('#2563eb')
    expect(r.css).toContain('--dc-primary-rgb: 185, 28, 28;')
    expect(r.css).toContain('--color-primary: #60a5fa')
    expect(r.html).toBe('<meta name="theme-color" content="#b91c1c" />')
    expect(r.htmlReplaced).toBe(true)
    expect(r.manual.join('\n')).toContain('#60a5fa')
    expect(hexToRgb('#ffffff')).toBe('255, 255, 255')
  })
})

describe('parseArgs', () => {
  it('parses flags, options and the two positionals', () => {
    expect(
      parseArgs(['--dry-run', '--domain', 'acme.io', '--colour', '#112233', 'acme', 'Acme Ops'])
    ).toEqual({
      dryRun: true,
      force: false,
      skipInstall: false,
      domain: 'acme.io',
      colour: '#112233',
      slug: 'acme',
      display: 'Acme Ops',
    })
  })

  it('reports usage problems instead of throwing', () => {
    expect(parseArgs([])).toEqual({ error: 'a slug is required' })
    expect(parseArgs(['--bogus', 'acme'])).toEqual({ error: 'unknown option --bogus' })
    expect(parseArgs(['--domain'])).toEqual({ error: '--domain needs a value' })
    expect(parseArgs(['rocketflare'])).toMatchObject({ error: expect.stringMatching(/kit's own/) })
    expect(parseArgs(['acme', 'A', 'extra'])).toMatchObject({
      error: expect.stringMatching(/extra/),
    })
    expect(parseArgs(['--colour', 'red', 'acme'])).toMatchObject({
      error: expect.stringMatching(/hex/),
    })
    expect(parseArgs(['--help'])).toEqual({ help: true })
  })
})
