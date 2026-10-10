/**
 * The pure half of `scripts/rename.mjs`: name derivation, the ordered replacement classes, the
 * exclusion list and the "careful row" computations. No I/O and nothing runs at import time, so
 * `apps/web/tests/kit-only/rename-lib.test.ts` can drive it under vitest; `rename-lib.d.mts` beside
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
  /**
   * Upstream references restored after the pass: anything in the `rocketflare-dev` GitHub org —
   * the org alone, or `rocketflare-dev/<repo>` (the kit, its plugins, the mirrored neon-proxy
   * image, the reusable plugin CI). A renamed app still pulls those from upstream; rewritten, they
   * pointed at `<slug>-dev/…`, an org that does not exist (#37). `rocketflare-dev-postgres` and
   * friends are container names, not the org, and still move.
   */
  preservedPattern: /\brocketflare-dev(?:\/[\w.-]+|(?![\w-]))/g,
  /**
   * Literal strings restored after the pass, longest first: the three filenames that keep the
   * KIT's name in a renamed app.
   *
   * `.rocketflare.json` is deliberately not renamed — it describes the KIT, and a fixed path is
   * what lets `kit:upgrade` and `pnpm plugin` find it (D27, D31). Its sidecar follows it, and
   * `rocketflare-plugin.json` is the ECOSYSTEM's filename, identical in every plugin repository.
   * Without these three, a copy renamed to `acme` looked for `.acme.json`, `.gitignore` stopped
   * ignoring the sidecar, and an app could never install any plugin at all.
   */
  preserved: ['.rocketflare.local.json', 'rocketflare-plugin.json', '.rocketflare.json'],
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
  // A newline here would break more than the rename: `scripts/upgrade.mjs` translates kit diffs
  // with these same replacements, and its hunk headers are only safe because every substitution
  // changes columns and never line counts.
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('display name must be a single line')
  }
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
const UPSTREAM_MARK = i => `\u0000U${i}\u0000`

/**
 * One pass over `text`: every class in order, counting matches per class. Returns the new text
 * (identical object when nothing matched) and `counts` keyed by class id.
 */
export function applyReplacements(text, names) {
  const counts = Object.fromEntries(CLASS_IDS.map(id => [id, 0]))
  let out = text
  let preservedHits = 0
  const upstream = []
  out = out.replace(KIT.preservedPattern, ref => {
    preservedHits += 1
    upstream.push(ref)
    return UPSTREAM_MARK(upstream.length - 1)
  })
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
  upstream.forEach((ref, i) => {
    out = out.split(UPSTREAM_MARK(i)).join(ref)
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
  '.claude/skills/rf-adapt/SKILL.md', // the skill that drives this tool — written in the kit's terms
  '.claude/skills/rf-adapt/checklist.md',
  // The provenance file names the KIT, not the app: its repo URL, version and surface manifest
  // must survive verbatim or `pnpm kit:upgrade` loses the thing it descends from. `rename.mjs`
  // writes its `app` block itself, at the end of the pass.
  '.rocketflare.json',
  // The upgrade toolchain, for the same reason `rename.mjs` is here: it must keep working after
  // this has run, and it addresses `.rocketflare.json` by that literal name.
  'scripts/upgrade.mjs',
  'scripts/release.mjs',
  'scripts/release-check.mjs',
  'scripts/lib/upgrade-lib.mjs',
  'scripts/lib/upgrade-lib.d.mts',
  'apps/web/tests/config/upgrade-lib.test.ts',
  'apps/web/tests/config/kit-manifest.test.ts',
  'CHANGELOG.md', // the kit's releases, described in the kit's own terms
])

/**
 * Excluded whole directories, matched by prefix. `docs/upgrades/` holds the kit's release notes —
 * an app accumulates them verbatim as a record of what it has absorbed, so they keep talking about
 * the kit's names. `.claude/skills/rf-upgrade/` drives the tool and names its files literally.
 * `apps/web/tests/kit-only/` is the kit's OWN tests (`kitOnly` in `.rocketflare.json`): they assert
 * on the kit's token strings, and `scripts/rename.mjs` deletes them before the pass anyway.
 */
export const EXCLUDED_PREFIXES = Object.freeze([
  'docs/upgrades/',
  '.claude/skills/rf-upgrade/',
  'apps/web/tests/kit-only/',
])

export function isExcluded(relPath) {
  const p = relPath.replaceAll('\\', '/')
  if (EXCLUDED_PATHS.includes(p)) return true
  if (EXCLUDED_PREFIXES.some(prefix => p.startsWith(prefix))) return true
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

const STRING_CONST_RE = name =>
  new RegExp(`export const ${name}(?::\\s*string)?\\s*=\\s*'([^'\\n]*)'`)

/**
 * The current value of `export const <name> = '<text>'` in a source, or null. Row (a) reads
 * `API_KEY_PREFIX` with it after the pass: it must equal `names.prefix` (`<snake>_`), because
 * the key format, the handle arithmetic and the tests all assume the snake form.
 */
export function readStringConstant(source, name) {
  const m = source.match(STRING_CONST_RE(name))
  return m ? m[1] : null
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

// ---------------------------------------------------------------- the Launch kit manifest

/** The Launch kit contract's file (D36, `docs/CONCEPTS.md` §13), kept by every copy. */
export const KIT_MANIFEST_FILE = 'launch.kit.json'

/** Index of the closing quote of the JSON string opening at `i`. */
function jsonStringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === '"') return j
  }
  return text.length - 1
}

/**
 * `[start, end)` of the OBJECT value of top-level `key` in a JSON text, or null — found by
 * scanning, not by parsing, so the bytes around it keep their exact formatting.
 */
export function topLevelObjectSpan(text, key) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      const end = jsonStringEnd(text, i)
      const colon = depth === 1 ? /^\s*:\s*/.exec(text.slice(end + 1)) : null
      if (colon && JSON.parse(text.slice(i, end + 1)) === key) {
        const start = end + 1 + colon[0].length
        if (text[start] !== '{') return null
        let inner = 0
        for (let k = start; k < text.length; k++) {
          const c = text[k]
          if (c === '"') k = jsonStringEnd(text, k)
          else if (c === '{' || c === '[') inner++
          else if ((c === '}' || c === ']') && --inner === 0) return [start, k + 1]
        }
        return null
      }
      i = end
    } else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return null
}

/**
 * `launch.kit.json` through the token map, EXCEPT its `kit` block. A copy keeps the manifest —
 * Launch reads the app's own for its sessions, gate and releases — so every command and env name
 * follows the rename like the files they point at (`ROCKETFLARE_BOOTSTRAP_SKIP` is read by a
 * bootstrap the pass renames too). The `kit` block names the KIT the app came from (`kit.id`,
 * `kit.name`, `kit.repo`), as `.rocketflare.json` `kit` does, so it is left byte for byte.
 * Same result shape as `applyReplacements`.
 */
export function renameKitManifest(text, names) {
  const span = topLevelObjectSpan(text, 'kit')
  if (!span) return applyReplacements(text, names)
  const head = applyReplacements(text.slice(0, span[0]), names)
  const tail = applyReplacements(text.slice(span[1]), names)
  const total = head.total + tail.total
  const counts = Object.fromEntries(CLASS_IDS.map(id => [id, head.counts[id] + tail.counts[id]]))
  return {
    text: total === 0 ? text : head.text + text.slice(span[0], span[1]) + tail.text,
    counts,
    total,
    preserved: head.preserved + tail.preserved,
  }
}

// ---------------------------------------------------------------- the app's own version

/** The root version a renamed copy starts at: its own first release, not the kit's number. */
export const APP_START_VERSION = '0.1.0'

/** A renamed copy's `CHANGELOG.md`: its own releases from here on. */
export const APP_CHANGELOG = `# Changelog

Releases of this app. The kit releases it has absorbed are recorded in \`.rocketflare.json\`
(\`kit\`, \`history\`) and described in \`docs/upgrades/\`.

## Unreleased
`

/**
 * Detach a copy's version from the kit's. The root `package.json` arrives carrying the kit's own
 * number and `CHANGELOG.md` the kit's releases; a copy is its own product, so its version restarts
 * at `APP_START_VERSION` and its changelog starts empty. Only while the root version still IS the
 * kit's (`kitVersion`, from `.rocketflare.json`): a re-run never resets an app's own numbering.
 * Only the top-level `"version"` value is rewritten, so the file's formatting survives.
 * Returns `null` when there is nothing to do.
 */
export function restartAppVersion(packageJson, kitVersion) {
  const pkg = JSON.parse(packageJson)
  if (typeof pkg.version !== 'string' || !kitVersion || pkg.version !== kitVersion) return null
  const text = packageJson.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${APP_START_VERSION}$2`)
  if (JSON.parse(text).version !== APP_START_VERSION) return null
  return { packageJson: text, from: pkg.version, to: APP_START_VERSION, changelog: APP_CHANGELOG }
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
