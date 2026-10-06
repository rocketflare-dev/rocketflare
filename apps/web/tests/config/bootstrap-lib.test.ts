/**
 * Pure helpers behind `scripts/bootstrap.mjs` (the one-shot first run), no database: the `.nvmrc`
 * / version parsers, `fillDevVars` (never overwrites a value a person typed), `toggleAiBlock` (the
 * `[ai]` block of BOTH real tomls round-trips byte-identically and, once off, parses with no `ai`
 * table so the parity test stays green), and the two stdout parsers (`pnpm seed`, `wrangler whoami`).
 * Plus the sandbox opt-outs (`--no-install`, `ROCKETFLARE_BOOTSTRAP_SKIP`, `ROCKETFLARE_ALLOW_ROOT`),
 * parsed here and run once through `bootstrap.mjs` itself with every step skipped (no side effects).
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import {
  aiBlockState,
  BOOTSTRAP_SKIPPABLE_STEPS,
  BootstrapUsageError,
  bootstrapStepPlan,
  checkoutTag,
  chooseDevDbPort,
  databaseUrlPort,
  databaseUrlTarget,
  describeTracing,
  extractSeedKey,
  fillDevVars,
  isLocalDatabaseUrl,
  isNeonDatabaseUrl,
  isPostgresUrl,
  localDriverFor,
  parseBootstrapArgs,
  parseBootstrapSkip,
  parseNvmrc,
  parseWhoami,
  planDefaultPlugins,
  readDevVars,
  toggleAiBlock,
  upsertDevVar,
  versionAtLeast,
  withDatabaseUrlPort,
} from '../../../../scripts/lib/bootstrap-lib.mjs'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'

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

describe('describeTracing (preflight, D32)', () => {
  it('reports local-only, the langfuse preset from the keys, and phoenix/generic endpoints — never a secret', () => {
    expect(describeTracing({})).toBe(
      'local ai_spans on; export off (local only — no OTEL_EXPORTER_OTLP_ENDPOINT)'
    )
    const lf = describeTracing({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-secret',
      LANGFUSE_SECRET_KEY: 'sk-lf-secret',
    })
    expect(lf).toBe(
      'local ai_spans on; exporting to langfuse at https://cloud.langfuse.com/api/public/otel'
    )
    expect(describeTracing({ OBSERVABILITY_PRESET: 'langfuse' })).toContain('export off')
    const phoenix = describeTracing({
      OBSERVABILITY_PRESET: 'phoenix',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:6006',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20topsecret',
    })
    expect(phoenix).toBe(
      'local ai_spans on; exporting to phoenix at http://localhost:6006 (http/protobuf, headers set)'
    )
    for (const text of [lf, phoenix]) expect(text).not.toMatch(/secret/)
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
    '%s: off drops the `ai` table for the parser and round-trips',
    file => {
      // The checkout may be in either state (`pnpm bootstrap --offline`); normalise to on first,
      // and require both tomls to agree so the parity test cannot be surprised.
      const onDisk = readWeb(file)
      expect(['on', 'off']).toContain(aiBlockState(onDisk))
      expect(aiBlockState(onDisk)).toBe(aiBlockState(readWeb('wrangler.toml')))
      const original = aiBlockState(onDisk) === 'on' ? onDisk : toggleAiBlock(onDisk, 'on')
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

/**
 * The dev database's port is chosen, not fixed: a second checkout on one machine used to be
 * unable to start Postgres at all (5432 taken, `container_name` pinned). `scripts/dev-db.mjs`
 * composes these four helpers; the docker side is exercised by running the bootstrap.
 */
describe('chooseDevDbPort', () => {
  const all = () => true

  it('keeps the port already in use by this checkout — a re-run must not move a live database', () => {
    expect(chooseDevDbPort({ preferred: 5437, isAvailable: all })).toBe(5437)
  })

  it('takes the next free port when the preferred one is held by another checkout', () => {
    const taken = new Set([5432])
    expect(chooseDevDbPort({ preferred: 5432, isAvailable: p => !taken.has(p) })).toBe(5434)
  })

  it('never hands out the test port, even when it is free and preferred', () => {
    expect(chooseDevDbPort({ preferred: 5433, isAvailable: all })).toBe(5432)
    expect(chooseDevDbPort({ preferred: null, isAvailable: p => p === 5433 })).toBeNull()
  })

  it('starts from 5432 when there is nothing to prefer', () => {
    expect(chooseDevDbPort({ preferred: null, isAvailable: all })).toBe(5432)
  })

  it('returns null when the whole range is taken, rather than a colliding port', () => {
    expect(chooseDevDbPort({ preferred: 5432, isAvailable: () => false })).toBeNull()
  })
})

describe('database URL port', () => {
  const URL_5432 = 'postgresql://rocketflare:rocketflare_pass@localhost:5432/rocketflare_dev'

  it('reads and rewrites the port, leaving the rest of the URL alone', () => {
    expect(databaseUrlPort(URL_5432)).toBe(5432)
    expect(withDatabaseUrlPort(URL_5432, 5434)).toBe(
      'postgresql://rocketflare:rocketflare_pass@localhost:5434/rocketflare_dev'
    )
  })

  it('survives a URL it cannot parse or one with no port', () => {
    expect(databaseUrlPort('not a url')).toBeNull()
    expect(databaseUrlPort('postgresql://localhost/db')).toBeNull()
    expect(withDatabaseUrlPort('not a url', 5434)).toBe('not a url')
  })
})

describe('upsertDevVar', () => {
  const FILE = ['# a comment', 'DATABASE_URL=postgresql://x:y@localhost:5432/z', 'OTHER=keep'].join(
    '\n'
  )

  it('rewrites the assignment in place and leaves every other byte alone', () => {
    const next = upsertDevVar(FILE, 'DATABASE_URL', 'postgresql://x:y@localhost:5434/z')
    expect(next).toContain('# a comment')
    expect(next).toContain('DATABASE_URL=postgresql://x:y@localhost:5434/z')
    expect(next).toContain('OTHER=keep')
    expect(next.split('\n')).toHaveLength(3)
  })

  it('appends a key the file does not have, and is idempotent', () => {
    const once = upsertDevVar('A=1\n', 'DATABASE_URL', 'postgresql://h/db')
    expect(once).toBe('A=1\nDATABASE_URL=postgresql://h/db\n')
    expect(upsertDevVar(once, 'DATABASE_URL', 'postgresql://h/db')).toBe(once)
  })
})

describe('checkoutTag', () => {
  it('is stable per path and differs between checkouts', () => {
    const a = checkoutTag('/Users/x/work/rocketflare/apps/web')
    expect(checkoutTag('/Users/x/work/rocketflare/apps/web')).toBe(a)
    expect(checkoutTag('/Users/x/work/other/apps/web')).not.toBe(a)
    expect(a).toMatch(/^[a-z0-9]{7}$/)
  })
})

describe('planDefaultPlugins', () => {
  const entry = { id: 'analytics', repo: 'https://example.test/rocketflare-plugin-analytics.git' }

  it('turns a declared entry into one `plugin add … --apply`', () => {
    const plan = planDefaultPlugins([entry], [])
    expect(plan.install).toEqual([
      {
        id: 'analytics',
        spec: 'https://example.test/rocketflare-plugin-analytics.git',
        args: [
          'plugin',
          'add',
          'https://example.test/rocketflare-plugin-analytics.git',
          '--apply',
          '--allow-dirty',
        ],
      },
    ])
    expect(plan.skipped).toEqual([])
    expect(plan.problems).toEqual([])
  })

  it('pins the ref onto the spec and passes a subdir through', () => {
    const [job] = planDefaultPlugins([{ ...entry, ref: '1.2.0', subdir: 'plugin' }], []).install
    expect(job.spec).toBe('https://example.test/rocketflare-plugin-analytics.git@1.2.0')
    expect(job.args).toEqual([
      'plugin',
      'add',
      'https://example.test/rocketflare-plugin-analytics.git@1.2.0',
      '--subdir',
      'plugin',
      '--apply',
      '--allow-dirty',
    ])
  })

  // Idempotence is the whole point: a second bootstrap must not re-add an installed plugin, which
  // `pnpm plugin add` answers with exit 7.
  it('skips an id that is already a surface', () => {
    const plan = planDefaultPlugins([entry], ['analytics'])
    expect(plan.install).toEqual([])
    expect(plan.skipped).toEqual(['analytics'])
  })

  it('is empty and silent with nothing declared — the kit today', () => {
    expect(planDefaultPlugins([], [])).toEqual({ install: [], skipped: [], problems: [] })
    expect(planDefaultPlugins(undefined, [])).toEqual({ install: [], skipped: [], problems: [] })
  })

  // `defaultPlugins` is hand-edited, so a typo in it is a sentence rather than a crash mid-install.
  it('reports a malformed entry instead of throwing, and installs nothing from it', () => {
    const plan = planDefaultPlugins(
      ['https://example.test/x.git', { repo: 'https://example.test/y.git' }, { id: 'z' }, entry],
      []
    )
    // The sentences come from `defaultPluginEntryProblems` now — one validator for the bootstrap,
    // `kit:release` and both workflows, which used to answer this differently from each other.
    expect(plan.problems).toHaveLength(3)
    expect(plan.problems[1]).toMatch(/no "id"/)
    expect(plan.problems[2]).toMatch(/'z' has no "repo"/)
    expect(plan.install.map(j => j.id)).toEqual(['analytics'])
  })

  it('matches what the kit ships in .rocketflare.json', () => {
    const { manifest } = readManifest(path.join(WEB_DIR, '../..'))
    expect(Array.isArray(manifest?.defaultPlugins)).toBe(true)
    expect(planDefaultPlugins(manifest?.defaultPlugins, []).problems).toEqual([])
  })
})

/**
 * `--db-url` (0.14.0): bootstrap against a database this checkout does not run — a Neon branch in
 * a coding sandbox with no Docker. Without the flag every default must stay exactly as it was.
 */
describe('parseBootstrapArgs', () => {
  const NEON = 'postgresql://u:secret@ep-x-123.eu-central-1.aws.neon.tech/neondb?sslmode=require'

  it('keeps the historical defaults when no flag is given', () => {
    expect(parseBootstrapArgs([], {})).toEqual({
      yes: false,
      shareDbIgnored: false,
      offline: false,
      online: false,
      dev: true,
      demo: true,
      plugins: true,
      open: true,
      as: 'owner@example.test',
      dbUrl: null,
      driver: null,
      check: false,
      verbose: false,
      help: false,
      skip: [],
      allowRoot: false,
    })
    expect(parseBootstrapArgs([], { DEV_VERBOSE: '1' }).verbose).toBe(true)
  })

  it('--no-install skips step 2 only', () => {
    expect(parseBootstrapArgs(['--no-install']).skip).toEqual(['install'])
    expect(
      parseBootstrapArgs(['--no-install'], { ROCKETFLARE_BOOTSTRAP_SKIP: 'install' }).skip
    ).toEqual(['install'])
  })

  it('ROCKETFLARE_BOOTSTRAP_SKIP adds to --no-install, in step order, without duplicates', () => {
    const env = { ROCKETFLARE_BOOTSTRAP_SKIP: 'seed, migrate,toolchain,,seed' }
    expect(parseBootstrapArgs([], env).skip).toEqual(['toolchain', 'migrate', 'seed'])
    expect(parseBootstrapArgs(['--no-install'], env).skip).toEqual([
      'toolchain',
      'install',
      'migrate',
      'seed',
    ])
    expect(parseBootstrapArgs([], { ROCKETFLARE_BOOTSTRAP_SKIP: '' }).skip).toEqual([])
  })

  it('ROCKETFLARE_ALLOW_ROOT is exactly 1, nothing looser', () => {
    expect(parseBootstrapArgs([], { ROCKETFLARE_ALLOW_ROOT: '1' }).allowRoot).toBe(true)
    expect(parseBootstrapArgs([], { ROCKETFLARE_ALLOW_ROOT: 'true' }).allowRoot).toBe(false)
    expect(parseBootstrapArgs([], { ROCKETFLARE_ALLOW_ROOT: '' }).allowRoot).toBe(false)
  })

  it('reads --driver (D35) in both forms and refuses anything else', () => {
    expect(parseBootstrapArgs(['--driver', 'neon']).driver).toBe('neon')
    expect(parseBootstrapArgs(['--driver=postgres']).driver).toBe('postgres')
    expect(() => parseBootstrapArgs(['--driver', 'pg'])).toThrow(/neon or postgres/)
    expect(() => parseBootstrapArgs(['--driver'])).toThrow(BootstrapUsageError)
    expect(() => parseBootstrapArgs(['--driver', 'neon', '--check'])).toThrow(/exclude/)
    // The neon driver reaches Neon or the local proxy, never another external Postgres.
    expect(() =>
      parseBootstrapArgs(['--driver', 'neon', '--db-url', 'postgres://u:pw@rds.example.com/db'])
    ).toThrow(/needs a Neon --db-url/)
    expect(parseBootstrapArgs(['--driver', 'neon', '--db-url', NEON]).driver).toBe('neon')
  })

  it('reads --db-url as a separate value and in = form', () => {
    expect(parseBootstrapArgs(['--db-url', NEON, '--yes']).dbUrl).toBe(NEON)
    expect(parseBootstrapArgs([`--db-url=${NEON}`]).dbUrl).toBe(NEON)
    expect(parseBootstrapArgs(['--db-url=postgres://h/db']).dbUrl).toBe('postgres://h/db')
  })

  it('is a usage error when the value is missing or not a postgres URL, never echoing it', () => {
    expect(() => parseBootstrapArgs(['--db-url'])).toThrow(BootstrapUsageError)
    expect(() => parseBootstrapArgs(['--db-url', '--yes'])).toThrow(/needs a postgres/)
    expect(() => parseBootstrapArgs(['--db-url='])).toThrow(/needs a postgres/)
    expect(() => parseBootstrapArgs(['--db-url', 'mysql://u:pw@h/db'])).toThrow(
      /must be a postgres/
    )
    expect(() => parseBootstrapArgs(['--db-url', 'https://u:hunter2@h/db'])).toThrow(
      /^(?!.*hunter2)/
    )
  })

  it('refuses --db-url with --check (preflight reads .dev.vars)', () => {
    expect(() => parseBootstrapArgs(['--check', '--db-url', NEON])).toThrow(/--check/)
  })

  it('keeps the existing flag rules', () => {
    expect(() => parseBootstrapArgs(['--offline', '--online'])).toThrow(BootstrapUsageError)
    expect(() => parseBootstrapArgs(['--nope'])).toThrow(/unknown option --nope/)
    expect(() => parseBootstrapArgs(['--as'])).toThrow(/--as needs an email/)
    expect(parseBootstrapArgs(['--as=a@b.test', '--no-dev']).as).toBe('a@b.test')
    expect(parseBootstrapArgs(['-h']).help).toBe(true)
  })
})

describe('database URL helpers', () => {
  it('isPostgresUrl accepts both schemes with a host, nothing else', () => {
    expect(isPostgresUrl('postgresql://u:p@localhost:5432/db')).toBe(true)
    expect(isPostgresUrl('postgres://h/db')).toBe(true)
    expect(isPostgresUrl('mysql://h/db')).toBe(false)
    expect(isPostgresUrl('not a url')).toBe(false)
  })

  it('isLocalDatabaseUrl: loopback is local, anything else is off-box, garbage stays local', () => {
    expect(isLocalDatabaseUrl('postgresql://u:p@localhost:5432/db')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://u:p@127.0.0.1:5434/db')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://u:p@[::1]:5432/db')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://u:p@ep-x.neon.tech/db')).toBe(false)
    expect(isLocalDatabaseUrl('postgresql://u:p@10.0.0.5:5432/db')).toBe(false)
    expect(isLocalDatabaseUrl('not a url')).toBe(true)
  })

  it('databaseUrlTarget drops the credentials and the query', () => {
    expect(databaseUrlTarget('postgresql://u:secret@ep-x.neon.tech/neondb?sslmode=require')).toBe(
      'ep-x.neon.tech/neondb'
    )
    expect(databaseUrlTarget('postgresql://u:p@localhost:5434/rocketflare_dev')).toBe(
      'localhost:5434/rocketflare_dev'
    )
    expect(databaseUrlTarget('nope')).not.toContain('nope')
  })
})

describe('bootstrapStepPlan', () => {
  const NEON = 'postgresql://u:secret@ep-x.neon.tech/neondb?sslmode=require'
  const LOCAL = 'postgresql://rocketflare:rocketflare_pass@localhost:5432/rocketflare_dev'
  const COMPOSE = { docker: true, database: 'compose', target: null, seedEnv: {} }

  it('is the Docker plan by default, unchanged from before --db-url', () => {
    expect(bootstrapStepPlan()).toEqual(COMPOSE)
    expect(bootstrapStepPlan({ dbUrl: null })).toEqual(COMPOSE)
  })

  it('--db-url: no Docker, an external database, and the seed may write to it', () => {
    expect(bootstrapStepPlan({ dbUrl: NEON })).toEqual({
      docker: false,
      database: 'external',
      target: 'ep-x.neon.tech/neondb',
      seedEnv: { SEED_ALLOW_REMOTE: '1' },
    })
  })

  it('--check skips Docker only for an off-box .dev.vars, and never allows a remote seed', () => {
    expect(bootstrapStepPlan({ check: true, devVarsDatabaseUrl: LOCAL })).toEqual(COMPOSE)
    expect(bootstrapStepPlan({ check: true, devVarsDatabaseUrl: undefined })).toEqual(COMPOSE)
    expect(bootstrapStepPlan({ check: true, devVarsDatabaseUrl: NEON })).toEqual({
      docker: false,
      database: 'external',
      target: 'ep-x.neon.tech/neondb',
      seedEnv: {},
    })
    // An off-box .dev.vars matters to preflight only; a plain bootstrap still owns its Docker db.
    expect(bootstrapStepPlan({ devVarsDatabaseUrl: NEON })).toEqual(COMPOSE)
  })
})

describe('localDriverFor (D35)', () => {
  const NEON = 'postgresql://u:pw@ep-x-123-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require'
  it('defaults to postgres — the Docker database over TCP, no proxy', () => {
    expect(localDriverFor({})).toBe('postgres')
  })
  it('keeps what .dev.vars says, so dev:db:up --neon survives a re-run', () => {
    expect(localDriverFor({ existing: 'neon' })).toBe('neon')
    expect(localDriverFor({ existing: 'bogus' })).toBe('postgres')
  })
  it('a Neon --db-url selects neon (a sandbox has no TCP out); any other URL postgres', () => {
    expect(localDriverFor({ dbUrl: NEON, existing: 'postgres' })).toBe('neon')
    expect(localDriverFor({ dbUrl: 'postgres://u:pw@db.example.com/x', existing: 'neon' })).toBe(
      'postgres'
    )
  })
  it('--driver wins over everything', () => {
    expect(localDriverFor({ flag: 'postgres', dbUrl: NEON, existing: 'neon' })).toBe('postgres')
  })
  it('isNeonDatabaseUrl reads the host, not a substring', () => {
    expect(isNeonDatabaseUrl(NEON)).toBe(true)
    expect(isNeonDatabaseUrl('postgres://u:pw@neon.tech.evil.example/x')).toBe(false)
    expect(isNeonDatabaseUrl('not a url')).toBe(false)
  })
})

describe('parseBootstrapSkip', () => {
  it('names steps 1–8 by their ✔-line names, never cli/run (those are --no-dev)', () => {
    expect(BOOTSTRAP_SKIPPABLE_STEPS).toEqual([
      'toolchain',
      'install',
      'secrets',
      'database',
      'migrate',
      'plugins',
      'seed',
      'cloudflare',
    ])
    expect(parseBootstrapSkip(undefined)).toEqual([])
    expect(parseBootstrapSkip('cloudflare,toolchain')).toEqual(['toolchain', 'cloudflare'])
  })

  it('is a usage error for an unknown name, so a typo never runs the step it meant to skip', () => {
    expect(() => parseBootstrapSkip('migrations')).toThrow(BootstrapUsageError)
    expect(() => parseBootstrapSkip('seed,run')).toThrow(/unknown step run/)
    expect(() => parseBootstrapArgs([], { ROCKETFLARE_BOOTSTRAP_SKIP: 'db-check' })).toThrow(
      /ROCKETFLARE_BOOTSTRAP_SKIP/
    )
  })
})

describe('bootstrap.mjs with steps skipped', () => {
  const BOOTSTRAP = path.resolve(WEB_DIR, '../../scripts/bootstrap.mjs')
  // The child allows root: a coding sandbox runs this suite as uid 0 (Launch's ship gate), and
  // the root refusal is not what these runs are about. The refusal has its own tests below.
  const runBootstrap = (args: string[], env: Record<string, string>, nodeArgs: string[] = []) =>
    spawnSync(process.execPath, [...nodeArgs, BOOTSTRAP, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DEV_VERBOSE: '', ROCKETFLARE_ALLOW_ROOT: '1', ...env },
      timeout: 30_000,
    })
  // Runs bootstrap.mjs as if uid 0, whoever runs the suite: `os.userInfo` reports uid 0.
  const AS_ROOT = [
    '--import',
    `data:text/javascript,${encodeURIComponent(
      "import os from 'node:os'; const real = os.userInfo; os.userInfo = o => ({ ...real(o), uid: 0 })"
    )}`,
  ]
  const ALL_SKIPPED = ['--no-install', '--no-dev', '--offline', '--yes']

  it('every step skipped is a no-op run: each line says skipped, nothing is spawned or written', () => {
    const tomls = ['wrangler.toml', 'wrangler.staging.toml'].map(readWeb)
    const result = runBootstrap(ALL_SKIPPED, {
      ROCKETFLARE_BOOTSTRAP_SKIP: BOOTSTRAP_SKIPPABLE_STEPS.join(','),
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/1\/10 toolchain\s+skipped \(ROCKETFLARE_BOOTSTRAP_SKIP\)/)
    expect(result.stdout).toMatch(/2\/10 install\s+skipped \(--no-install\); .*wrangler present/)
    expect(result.stdout).toMatch(/8\/10 cloudflare\s+skipped \(ROCKETFLARE_BOOTSTRAP_SKIP\)/)
    // A skipped cloudflare step leaves both tomls alone even under --offline.
    expect(['wrangler.toml', 'wrangler.staging.toml'].map(readWeb)).toEqual(tomls)
  })

  it('an unknown step name is exit 2 before any step runs', () => {
    const result = runBootstrap(['--no-dev'], { ROCKETFLARE_BOOTSTRAP_SKIP: 'nope' })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/unknown step nope/)
    expect(result.stdout).not.toMatch(/1\/10/)
  })

  it('as root it refuses before any step unless ROCKETFLARE_ALLOW_ROOT=1', () => {
    const skip = { ROCKETFLARE_BOOTSTRAP_SKIP: BOOTSTRAP_SKIPPABLE_STEPS.join(',') }
    const refused = runBootstrap(ALL_SKIPPED, { ...skip, ROCKETFLARE_ALLOW_ROOT: '' }, AS_ROOT)
    expect(refused.status).toBe(3)
    expect(refused.stderr).toMatch(/refusing to run as root .*ROCKETFLARE_ALLOW_ROOT=1/)
    expect(refused.stdout).not.toMatch(/1\/10/)

    const allowed = runBootstrap(ALL_SKIPPED, skip, AS_ROOT)
    expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0)
    expect(allowed.stdout).toMatch(/8\/10 cloudflare\s+skipped/)
  })
})
