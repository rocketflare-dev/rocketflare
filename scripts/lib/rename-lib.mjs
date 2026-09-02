/**
 * The pure half of `scripts/rename.mjs`: name derivation, the ordered replacement classes, the
 * exclusion list and the "careful row" computations. No I/O and nothing runs at import time, so
 * `apps/web/tests/config/rename-lib.test.ts` can drive it under vitest; `rename-lib.d.mts` beside
 * this file is the hand-written type surface (no `allowJs`).
 *
 * Every token the kit ships under its own name is one of nine classes, applied per file in the
 * order below — longest / most specific first — so a partial form can never win over a longer one:
 *
 *   scope    `@rocketflare/`             → `@<slug>/`        package scope + every import specifier
 *   env      `ROCKETFLARE` (any)         → `<UPPER>`         CLI env prefix, incl. the bare `ENV_PREFIX`
 *   domain   `rocketflare.dev|.local`    → `<domain>`        `noreply@`, `app.`, `staging.` prefixes kept
 *   cfgdir   `.rocketflare` (config dir) → `.<slug>`         `~/.rocketflare`, `CONFIG_DIR_NAME`
 *   dbuser   `postgresql://rocketflare:` → `<snake>`         the Postgres OWNER must stay a plain
 *            `POSTGRES_USER: rocketflare`, `-U rocketflare`  identifier (db-roles.ts refuses `my-app`)
 *   snake    `rocketflare_`              → `<snake>_`        db names, RLS role, password, key prefix
 *   kebab    `rocketflare-`              → `<slug>-`         worker, queue, workflow, bucket, themes
 *   display  `Rocketflare`               → display name      APP_NAME, titles, prose
 *   bare     `rocketflare` (word)        → `<slug>`          bin, `cfld.name`, root package, containers
 *
 * `domain` runs before `cfgdir` because `app.rocketflare.dev` contains `.rocketflare`; `dbuser`
 * runs before `bare` for the identifier reason above. Case-sensitive throughout.
 */

/** What the kit calls itself today — the left-hand side of every replacement. */
export const KIT = Object.freeze({
  slug: 'rocketflare',
  upper: 'ROCKETFLARE',
  display: 'Rocketflare',
  domains: ['rocketflare.dev', 'rocketflare.local'],
  /** Literal strings restored after the pass: the kit's origin, not the app's. */
  preserved: ['github.com/rocketflare-dev/rocketflare'],
})

export const SLUG_RE = /^[a-z][a-z0-9-]*$/
export const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/

/** `null` when the slug is acceptable, else the sentence to print. */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return 'a slug is required'
  if (!SLUG_RE.test(slug)) {
    return `slug '${slug}' must match ${SLUG_RE} (lowercase, digits, hyphens; starts with a letter)`
  }
  if (slug === KIT.slug) return `slug '${slug}' is the kit's own name — pick the app's`
  if (slug.endsWith('-')) return `slug '${slug}' must not end with a hyphen`
  return null
}

/** `my-app` → `My App`. */
export function titleCase(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Every derived form of the new name. `display` defaults to Title Case of the slug; `domain`
 * to `<slug>.example.com` (a placeholder that is obviously not yours, like the kit's `.dev`).
 */
export function deriveNames(slug, display, options = {}) {
  const problem = validateSlug(slug)
  if (problem) throw new Error(problem)
  const snake = slug.replaceAll('-', '_')
  const domain = options.domain ?? `${slug}.example.com`
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error(`domain '${domain}' does not look like an apex host (example.com)`)
  }
  const colour = options.colour ?? null
  if (colour !== null && !HEX_COLOUR_RE.test(colour)) {
    throw new Error(`colour '${colour}' must be a 6-digit hex like #2563eb`)
  }
  const trimmed = typeof display === 'string' ? display.trim() : ''
  return Object.freeze({
    slug,
    snake,
    upper: snake.toUpperCase(),
    display: trimmed.length > 0 ? trimmed : titleCase(slug),
    domain: domain.toLowerCase(),
    /** The API-key prefix as stored: `<snake>_`. */
    prefix: `${snake}_`,
    colour: colour === null ? null : colour.toLowerCase(),
  })
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The ordered classes for one set of names. Each `pattern` is a fresh global RegExp. */
export function buildReplacements(names) {
  const kit = KIT.slug
  return [
    {
      id: 'scope',
      label: `@${kit}/`,
      pattern: new RegExp(`@${kit}/`, 'g'),
      replacement: `@${names.slug}/`,
    },
    { id: 'env', label: KIT.upper, pattern: new RegExp(KIT.upper, 'g'), replacement: names.upper },
    {
      id: 'domain',
      label: KIT.domains.join(' | '),
      pattern: new RegExp(`${kit}\\.(?:dev|local)\\b`, 'g'),
      replacement: names.domain,
    },
    {
      id: 'cfgdir',
      label: `.${kit} (config dir)`,
      pattern: new RegExp(`\\.${kit}(?![\\w.-])`, 'g'),
      replacement: `.${names.slug}`,
    },
    {
      id: 'dbuser',
      label: `${kit} (Postgres owner)`,
      pattern: new RegExp(`(postgresql://|POSTGRES_USER: |-U )${kit}\\b`, 'g'),
      replacement: `$1${names.snake}`,
    },
    {
      id: 'snake',
      label: `${kit}_`,
      pattern: new RegExp(`${kit}_`, 'g'),
      replacement: `${names.snake}_`,
    },
    {
      id: 'kebab',
      label: `${kit}-`,
      pattern: new RegExp(`${kit}-`, 'g'),
      replacement: `${names.slug}-`,
    },
    {
      id: 'display',
      label: KIT.display,
      pattern: new RegExp(escapeRegExp(KIT.display), 'g'),
      replacement: names.display,
    },
    { id: 'bare', label: kit, pattern: new RegExp(`\\b${kit}\\b`, 'g'), replacement: names.slug },
  ]
}

/** The class ids in application order — the columns of the dry-run table. */
export const CLASS_IDS = Object.freeze(buildReplacements(deriveNames('x')).map(c => c.id))

const PRESERVE_MARK = i => `\u0000P${i}\u0000`

/**
 * One pass over `text`: every class in order, counting matches per class. Returns the new text
 * (identical object when nothing matched) and `counts` keyed by class id.
 */
export function applyReplacements(text, names) {
  const counts = Object.fromEntries(CLASS_IDS.map(id => [id, 0]))
  let out = text
  let preservedHits = 0
  KIT.preserved.forEach((literal, i) => {
    const parts = out.split(literal)
    preservedHits += parts.length - 1
    out = parts.join(PRESERVE_MARK(i))
  })
  for (const cls of buildReplacements(names)) {
    out = out.replace(cls.pattern, (...m) => {
      counts[cls.id] += 1
      // `$1` in the replacement is the captured context (dbuser); everything else is literal.
      return cls.replacement.includes('$1') ? cls.replacement.replace('$1', m[1]) : cls.replacement
    })
  }
  KIT.preserved.forEach((literal, i) => {
    out = out.split(PRESERVE_MARK(i)).join(literal)
  })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text: total === 0 ? text : out, counts, total, preserved: preservedHits }
}

/**
 * Paths (repo-relative, POSIX) the pass never touches. Directories are matched as a leading
 * segment anywhere in the path; files exactly.
 */
export const EXCLUDED_DIRS = Object.freeze([
  'node_modules',
  'dist',
  '.git',
  '.wrangler',
  'coverage',
])
export const EXCLUDED_PATHS = Object.freeze([
  'pnpm-lock.yaml', // rewritten by the `pnpm install` the script runs at the end
  'LICENSE',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'apps/web/public/logo.svg',
  'apps/web/public/favicon.svg',
  'apps/web/src/ui/public/logo.svg', // the kit's mark — a human replaces it (row f)
  'apps/web/src/ui/public/favicon.svg',
  'scripts/rename.mjs', // the tool must keep working after it has run
  'scripts/lib/rename-lib.mjs',
  'scripts/lib/rename-lib.d.mts',
  'apps/web/tests/config/rename-lib.test.ts', // asserts on the kit's own token strings
  '.claude/skills/adapt/SKILL.md', // the skill that drives this tool — written in the kit's terms
  '.claude/skills/adapt/checklist.md',
])

export function isExcluded(relPath) {
  const p = relPath.replaceAll('\\', '/')
  if (EXCLUDED_PATHS.includes(p)) return true
  return p.split('/').some(seg => EXCLUDED_DIRS.includes(seg))
}

/** Ignored-by-git files the pass still wants, when they exist: local config that names the DB. */
export const OPT_IN_IGNORED_PATHS = Object.freeze(['apps/web/.dev.vars'])

/** A NUL byte in the first 8 KiB is a binary; the pass skips it. */
export function isBinary(buffer) {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i++) if (buffer[i] === 0) return true
  return false
}

// ---------------------------------------------------------------- careful rows

/** Margins the kit's two display-handle constants keep beyond the `<prefix>_` (hash.ts, config.ts). */
export const API_KEY_HANDLE_MARGIN = 8 // `rocketflare_` (12) + 8 = 20, the server's `keyPrefix`
export const REDACTED_KEY_MARGIN = 4 // `rocketflare_` (12) + 4 = 16, the CLI's masked form

/**
 * Row (a): the two handle lengths as they must read for the new prefix. The CLI tests assume
 * `REDACTED_KEY_CHARS === prefix.length + 4` exactly (`<prefix>_test…`), so both are SET to
 * prefix + margin rather than merely bumped; a shorter prefix therefore also shrinks them.
 */
export function prefixGuard(names, current) {
  const prefixLength = names.prefix.length
  const want = (margin, cur) => ({
    current: cur,
    required: prefixLength + margin,
    change: cur === null || cur !== prefixLength + margin,
  })
  return {
    prefix: names.prefix,
    prefixLength,
    apiKeyPrefixLength: want(API_KEY_HANDLE_MARGIN, current.apiKeyPrefixLength ?? null),
    redactedKeyChars: want(REDACTED_KEY_MARGIN, current.redactedKeyChars ?? null),
  }
}

const CONST_RE = name => new RegExp(`(export const ${name} = )(\\d+)([^\\n]*)`)

/** The current value of `export const <name> = <int>` in a source, or null. */
export function readIntConstant(source, name) {
  const m = source.match(CONST_RE(name))
  return m ? Number(m[2]) : null
}

/**
 * Rewrites `export const <name> = <old>` to `<value>` and refreshes the trailing comment's
 * `(<n>)` + `<margin>` arithmetic so the comment keeps telling the truth. Applied AFTER the token
 * pass, so the example handle in the comment already carries the new prefix.
 */
export function rewriteIntConstant(source, name, value, prefix, margin) {
  return source.replace(CONST_RE(name), (_m, head, _old, tail) => {
    const comment = tail.replace(/\(\d+\) \+ \d+/, `(${prefix.length}) + ${margin}`)
    return `${head}${value}${comment}`
  })
}

/** Also fix a `\`<prefix>\` (12) + 4` docblock line above the constant, if present. */
export function rewritePrefixComments(source, prefix, margin) {
  return source.replace(
    new RegExp(`(\`${escapeRegExp(prefix)}\` )\\(\\d+\\) \\+ \\d+`, 'g'),
    `$1(${prefix.length}) + ${margin}`
  )
}

/** `#2563eb` → `37, 99, 235`. */
export function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ')
}

/**
 * Row (e): the light theme's `--color-primary` hex (read from the file, never assumed) replaced
 * everywhere it appears in `index.css` (`--color-primary`, `--surface-active`, `--focus-ring`),
 * the matching `--dc-primary-rgb` triple, and `<meta name="theme-color">` in `index.html`. The
 * dark theme's primary, the `-content` colours and the `--tone-primary-*` tints are reported as
 * manual: they are separate design decisions (contrast), not the same value.
 */
export function applyColour({ css, html }, colour) {
  const m = css.match(/--color-primary:\s*(#[0-9a-fA-F]{6})/)
  if (!m) throw new Error('index.css has no `--color-primary: #hex` line to rewrite')
  const from = m[1].toLowerCase()
  const cssOut = css
    .replace(new RegExp(from, 'gi'), colour)
    .replace(/(--dc-primary-rgb:\s*)\d+,\s*\d+,\s*\d+/, `$1${hexToRgb(colour)}`)
  const htmlOut = html.replace(
    /(<meta name="theme-color" content=")#[0-9a-fA-F]{6}(")/,
    `$1${colour}$2`
  )
  const cssHits = (css.match(new RegExp(from, 'gi')) ?? []).length
  const dark = [...css.matchAll(/--color-primary:\s*(#[0-9a-fA-F]{6})/g)]
    .map(x => x[1].toLowerCase())
    .filter(hex => hex !== from)
  return {
    css: cssOut,
    html: htmlOut,
    from,
    to: colour,
    cssReplacements: cssHits,
    htmlReplaced: htmlOut !== html,
    manual: [
      ...dark.map(
        hex => `dark theme \`--color-primary: ${hex}\` (+ its --surface-active / --focus-ring)`
      ),
      '`--color-primary-content` in both themes (text on the accent — check contrast)',
      "`--tone-primary-surface` / `--tone-primary-border` (the accent's 100 / 300 tints)",
      '`--color-accent` (the secondary accent), if the palette has one',
      `the "/* blue-600 */"-style comments beside the rewritten values (now stale)`,
    ],
  }
}

// ---------------------------------------------------------------- argv

export const USAGE = `usage: node scripts/rename.mjs [--dry-run] [--force] [--skip-install]
                              [--domain <apex>] [--colour <#hex>] <slug> ["Display Name"]

  <slug>            lowercase, digits, hyphens (my-app); becomes @<slug>/*, the worker, bin, themes
  "Display Name"    what people see (APP_NAME, titles); default: Title Case of the slug
  --domain <apex>   replaces rocketflare.dev / rocketflare.local; default <slug>.example.com
  --colour <#hex>   the primary brand colour (light theme); then run: pnpm web test:ui
  --dry-run         print the table of replacements per file and change nothing
  --force           run on a dirty git tree (commit or stash first, normally)
  --skip-install    do not run pnpm install / biome at the end (offline; run them yourself)

exit 0 ok · 1 error · 2 usage`

/** Parses argv (without node + script). Returns `{ error }` for a usage problem. */
export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    skipInstall: false,
    domain: undefined,
    colour: undefined,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--skip-install') opts.skipInstall = true
    else if (a === '--domain' || a === '--colour' || a === '--color') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` }
      opts[a === '--domain' ? 'domain' : 'colour'] = v
      i += 1
    } else if (a === '-h' || a === '--help') return { help: true }
    else if (a.startsWith('--')) return { error: `unknown option ${a}` }
    else positional.push(a)
  }
  if (positional.length === 0) return { error: 'a slug is required' }
  if (positional.length > 2) return { error: `unexpected argument '${positional[2]}'` }
  const [slug, display] = positional
  const problem = validateSlug(slug)
  if (problem) return { error: problem }
  if (opts.colour !== undefined && !HEX_COLOUR_RE.test(opts.colour)) {
    return { error: `--colour '${opts.colour}' must be a 6-digit hex like #2563eb` }
  }
  return { ...opts, slug, display }
}
