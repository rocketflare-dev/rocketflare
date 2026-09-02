#!/usr/bin/env node
/**
 * Rename a fresh copy of the kit to your app — `docs/ADAPTING.md` §1 as one command.
 *
 *   node scripts/rename.mjs [--dry-run] [--force] [--skip-install]
 *                           [--domain <apex>] [--colour <#hex>] <slug> ["Display Name"]
 *
 * Walks every text file git knows about (tracked + untracked, `.gitignore` honoured, plus
 * `apps/web/.dev.vars` when it exists so the local DB URL follows the compose file), applies the
 * nine ordered replacement classes from `scripts/lib/rename-lib.mjs`, then checks and reports the
 * rows a rename cannot do blindly ("careful rows", the letters in `docs/ADAPTING.md`):
 *
 *   (a) the API-key display handles `API_KEY_PREFIX_LENGTH` / `REDACTED_KEY_CHARS` — fixed
 *   (b) `apps/web/migrations/**` names the RLS role — rename BEFORE the first migration — warned
 *   (c) the docker `container_name`s / volume — renamed, reported
 *   (d) staging names keep `-staging` — the parity test is the proof — reported
 *   (e) `--colour` rewrites the light theme's primary hex; the rest of the palette is yours — reported
 *   (f) `LogoMark` / `logo.svg` / `favicon.svg` are a human choice — reported
 *
 * `--dry-run` prints the per-file table and touches nothing (and skips the dirty-tree check).
 * The real run refuses a dirty tree without `--force`, writes, runs `pnpm install` (the lockfile
 * follows the package names) and `biome check --write` (a shorter or longer name re-wraps lines),
 * then prints the verify line. Exit 0 ok · 1 error · 2 usage. Zero dependencies, Node ≥ 24.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_KEY_HANDLE_MARGIN,
  applyColour,
  applyReplacements,
  CLASS_IDS,
  deriveNames,
  isBinary,
  isExcluded,
  KIT,
  OPT_IN_IGNORED_PATHS,
  parseArgs,
  prefixGuard,
  REDACTED_KEY_MARGIN,
  readIntConstant,
  rewriteIntConstant,
  rewritePrefixComments,
  USAGE,
} from './lib/rename-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HASH_TS = 'apps/web/src/api/utils/core/hash.ts'
const CLI_CONFIG_TS = 'apps/cli/src/config.ts'
const INDEX_CSS = 'apps/web/src/ui/index.css'
const INDEX_HTML = 'apps/web/src/ui/index.html'
const MIGRATIONS_DIR = 'apps/web/migrations/'
const DEV_VARS = 'apps/web/.dev.vars'

const out = (...lines) => console.log(lines.join('\n'))
const warn = (...lines) => console.error(lines.join('\n'))

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
}

/** Best-effort: running containers by name, or [] when docker is absent. */
function runningContainers() {
  try {
    return execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Repo-relative POSIX paths of every candidate file: git's view + the opt-in ignored ones. */
function candidateFiles() {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
  const set = new Set(listed)
  for (const p of OPT_IN_IGNORED_PATHS) if (existsSync(path.join(REPO_ROOT, p))) set.add(p)
  const files = []
  for (const rel of [...set].sort()) {
    if (isExcluded(rel)) continue
    let st
    try {
      st = lstatSync(path.join(REPO_ROOT, rel))
    } catch {
      continue // in the index, gone on disk (a staged deletion)
    }
    if (!st.isFile()) continue // symlinks (AGENTS.md → CLAUDE.md) and directories
    files.push(rel)
  }
  return files
}

function renderTable(rows) {
  const header = ['file', ...CLASS_IDS, 'total']
  const body = rows.map(r => [r.rel, ...CLASS_IDS.map(id => r.counts[id] || ''), r.total])
  const totals = ['TOTAL', ...CLASS_IDS.map(id => rows.reduce((n, r) => n + r.counts[id], 0))]
  totals.push(rows.reduce((n, r) => n + r.total, 0))
  const all = [header, ...body, totals].map(row => row.map(String))
  const widths = header.map((_, i) => Math.max(...all.map(row => row[i].length)))
  const line = row =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')
  const rule = widths.map(w => '-'.repeat(w)).join('  ')
  return [line(all[0]), rule, ...all.slice(1, -1).map(line), rule, line(all.at(-1))].join('\n')
}

function main(argv) {
  const args = parseArgs(argv)
  if ('help' in args) {
    out(USAGE)
    return 0
  }
  if ('error' in args) {
    warn(`error: ${args.error}`, '', USAGE)
    return 2
  }
  let names
  try {
    names = deriveNames(args.slug, args.display, { domain: args.domain, colour: args.colour })
  } catch (err) {
    warn(`error: ${err.message}`, '', USAGE)
    return 2
  }

  // ------------------------------------------------------------- preconditions
  let top
  try {
    top = git(['rev-parse', '--show-toplevel']).trim()
  } catch {
    warn('error: not a git checkout — the walker uses `git ls-files` for .gitignore semantics')
    return 1
  }
  if (path.resolve(top) !== REPO_ROOT) {
    warn(`error: git toplevel ${top} is not the repo this script lives in (${REPO_ROOT})`)
    return 1
  }
  const dirty = git(['status', '--porcelain']).trim()
  if (dirty && !args.dryRun && !args.force) {
    warn(
      'error: the git tree is not clean — commit or stash first so the rename is one reviewable diff',
      '       (or pass --force). `git status --short` shows:',
      dirty
        .split('\n')
        .slice(0, 10)
        .map(l => `         ${l}`)
        .join('\n')
    )
    return 1
  }

  out(
    `${args.dryRun ? 'DRY RUN — ' : ''}renaming ${KIT.display} → ${names.display}`,
    `  slug ${names.slug} · snake ${names.snake} · UPPER ${names.upper} · domain ${names.domain}` +
      (names.colour ? ` · colour ${names.colour}` : ''),
    ''
  )

  // ------------------------------------------------------------- the pass
  const rows = []
  const skippedBinary = []
  const edits = new Map() // rel → new content, written at the end
  for (const rel of candidateFiles()) {
    const abs = path.join(REPO_ROOT, rel)
    const buf = readFileSync(abs)
    if (isBinary(buf)) {
      skippedBinary.push(rel)
      continue
    }
    const before = buf.toString('utf8')
    const result = applyReplacements(before, names)
    if (result.total === 0) continue
    rows.push({ rel, counts: result.counts, total: result.total })
    edits.set(rel, result.text)
  }
  const current = rel => edits.get(rel) ?? readFileSync(path.join(REPO_ROOT, rel), 'utf8')

  // ------------------------------------------------------------- careful rows
  const report = []
  // (a) API-key display handles
  {
    const hash = current(HASH_TS)
    const cli = current(CLI_CONFIG_TS)
    const guard = prefixGuard(names, {
      apiKeyPrefixLength: readIntConstant(hash, 'API_KEY_PREFIX_LENGTH'),
      redactedKeyChars: readIntConstant(cli, 'REDACTED_KEY_CHARS'),
    })
    const a = guard.apiKeyPrefixLength
    const r = guard.redactedKeyChars
    if (a.current === null || r.current === null) {
      report.push(
        `(a) API-key handles: could not read API_KEY_PREFIX_LENGTH (${HASH_TS}) or REDACTED_KEY_CHARS ` +
          `(${CLI_CONFIG_TS}) — set them to ${a.required} / ${r.required} by hand (prefix \`${guard.prefix}\` is ${guard.prefixLength} chars)`
      )
    } else {
      if (a.change) {
        edits.set(
          HASH_TS,
          rewriteIntConstant(
            hash,
            'API_KEY_PREFIX_LENGTH',
            a.required,
            guard.prefix,
            API_KEY_HANDLE_MARGIN
          )
        )
      }
      if (r.change) {
        edits.set(
          CLI_CONFIG_TS,
          rewritePrefixComments(
            rewriteIntConstant(
              cli,
              'REDACTED_KEY_CHARS',
              r.required,
              guard.prefix,
              REDACTED_KEY_MARGIN
            ),
            guard.prefix,
            REDACTED_KEY_MARGIN
          )
        )
      }
      const show = (label, v) =>
        `${label} ${v.current}${v.change ? ` → ${v.required}` : ' (unchanged)'}`
      report.push(
        `(a) API-key handles for prefix \`${guard.prefix}\` (${guard.prefixLength} chars): ` +
          `${show('API_KEY_PREFIX_LENGTH', a)} in ${HASH_TS}; ${show('REDACTED_KEY_CHARS', r)} in ${CLI_CONFIG_TS}` +
          ` — set to prefix + ${API_KEY_HANDLE_MARGIN} / + ${REDACTED_KEY_MARGIN} so a listed key still shows token characters` +
          ' (the CLI tests assume exactly prefix + 4). Existing keys keep working; only the display handle changes.'
      )
    }
  }
  // (b) migrations / RLS role / EMBEDDING_DIM
  {
    const migrationRows = rows.filter(row => row.rel.startsWith(MIGRATIONS_DIR))
    const containers = runningContainers()
    const oldDev = `${KIT.slug}-dev-postgres`
    const oldTest = `${KIT.slug}-test-postgres`
    // The dev container carries a per-checkout suffix (scripts/dev-db.mjs), the test one does not.
    const live = containers.filter(c => c === oldTest || c === oldDev || c.startsWith(`${oldDev}-`))
    const hasDevVars = existsSync(path.join(REPO_ROOT, DEV_VARS))
    const lines = [
      `(b) ${migrationRows.length} files under ${MIGRATIONS_DIR} rename the RLS role \`${KIT.slug}_app\` → \`${names.snake}_app\` ` +
        '(SQL + meta snapshots). A database that already ran the OLD migrations keeps the old role and policies:',
      '    rename BEFORE the first migration. If a dev DB exists, drop it and migrate again —',
      `    \`pnpm dev:db:down\` BEFORE the rename (the compose file names the old container), or afterwards`,
      `    \`pnpm dev:db:status\` names this checkout's container and volume (both carry a per-checkout`,
      `    suffix); \`docker rm -f <container>\` + \`docker volume rm <project>_${KIT.slug}-dev-data\`, then \`pnpm dev:db:up && pnpm db:migrate\`.`,
      '    The renamed compose volume is a fresh, empty database, so the new migrations apply cleanly.',
    ]
    if (live.length > 0) {
      lines.push(
        `    WARNING: ${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} RUNNING right now — that database was migrated under the old name.`
      )
    } else if (hasDevVars) {
      lines.push(
        `    NOTE: ${DEV_VARS} exists (${edits.has(DEV_VARS) ? 'its DB URL is renamed too; counts only, never echoed' : 'unchanged'}) — if its database was ever migrated, drop it as above.`
      )
    }
    lines.push(
      '    EMBEDDING_DIM (1024, packages/shared/src/ai/config.ts) is a column type in the same migrations —',
      '    change it now or never (docs/ADAPTING.md §3), not after data exists.'
    )
    report.push(lines.join('\n'))
  }
  // (c) containers
  report.push(
    `(c) Docker names: container_name \`${names.slug}-dev-postgres\` / \`${names.slug}-test-postgres\`, volume ` +
      `\`${names.slug}-dev-data\`, database \`${names.snake}_dev\` / \`${names.snake}_test\`, owner \`${names.snake}\` ` +
      `(kept a plain SQL identifier: db-roles.ts refuses a hyphenated owner, so a hyphenated slug uses its snake form here). Renamed automatically. ` +
      'Two checkouts never collide either way: scripts/dev-db.mjs gives each its own compose project, container suffix and port.'
  )
  // (d) staging suffix
  report.push(
    `(d) Staging names keep their suffix: \`${names.slug}-staging\`, \`${names.slug}-jobs-staging\`, ` +
      `\`${names.slug}-agent-run-staging\`, \`${names.slug}-files-staging\` in apps/web/wrangler.staging.toml. ` +
      'apps/web/tests/config/wrangler-parity.test.ts is the check — `pnpm web test:config`.'
  )
  // (e) colour
  if (names.colour) {
    const r = applyColour({ css: current(INDEX_CSS), html: current(INDEX_HTML) }, names.colour)
    edits.set(INDEX_CSS, r.css)
    edits.set(INDEX_HTML, r.html)
    report.push(
      [
        `(e) Colour: light-theme primary ${r.from} → ${r.to} in ${INDEX_CSS} (${r.cssReplacements} occurrences: ` +
          '--color-primary, --surface-active, --focus-ring; plus --dc-primary-rgb)' +
          `${r.htmlReplaced ? ` and <meta name="theme-color"> in ${INDEX_HTML}` : ''}. Left for you:`,
        ...r.manual.map(m => `      - ${m}`),
        '    Then run the contrast gate: `pnpm web test:ui` (tests/ui/contrast.test.ts).',
      ].join('\n')
    )
  } else {
    report.push(
      `(e) Colour: unchanged (no --colour). The brand hexes live in the header block of ${INDEX_CSS}; ` +
        'after any change run `pnpm web test:ui` (contrast gate).'
    )
  }
  // (f) logo
  report.push(
    '(f) Logo: apps/web/src/ui/components/shared/LogoMark.tsx, apps/web/src/ui/public/logo.svg and ' +
      'favicon.svg still carry the kit mark — replace the paths in all three yourself (not touched).'
  )

  // ------------------------------------------------------------- output
  if (args.dryRun) {
    out(renderTable(rows), '')
  } else {
    const totals = Object.fromEntries(
      CLASS_IDS.map(id => [id, rows.reduce((n, r) => n + r.counts[id], 0)])
    )
    out(
      `${rows.length} files, ${rows.reduce((n, r) => n + r.total, 0)} replacements: ` +
        CLASS_IDS.map(id => `${id} ${totals[id]}`).join(' · '),
      ''
    )
  }
  if (skippedBinary.length > 0) {
    out(`skipped ${skippedBinary.length} binary file(s): ${skippedBinary.join(', ')}`, '')
  }
  out('Careful rows (docs/ADAPTING.md §1):', ...report.map(r => `  ${r}`), '')
  out(
    `Preserved as the kit's origin: ${KIT.preserved.join(', ')}. Not touched by design: ` +
      'LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, the two svgs, this tool, its test and the adapt skill.',
    ''
  )

  if (args.dryRun) {
    out('Dry run — nothing written. Re-run without --dry-run to apply.')
    return 0
  }

  // ------------------------------------------------------------- write + finish
  let written = 0
  for (const [rel, content] of edits) {
    writeFileSync(path.join(REPO_ROOT, rel), content)
    written += 1
  }
  out(`wrote ${written} files.`, '')

  if (args.skipInstall) {
    out(
      '--skip-install: run `pnpm install` (relinks @' +
        names.slug +
        '/* and rewrites pnpm-lock.yaml)'
    )
    out('and `pnpm lint:fix` (the new name re-wraps some lines) yourself, then:')
  } else {
    out('$ pnpm install')
    const install = spawnSync('pnpm', ['install'], { cwd: REPO_ROOT, stdio: 'inherit' })
    if (install.status !== 0) {
      warn(
        'error: pnpm install failed — fix it (offline? use --skip-install and install later), ' +
          'then run `pnpm install && pnpm lint:fix` before the verify line.'
      )
      return 1
    }
    out('', '$ pnpm lint:fix   (biome re-wraps the lines the new name changed)')
    const fix = spawnSync('pnpm', ['lint:fix'], { cwd: REPO_ROOT, stdio: 'inherit' })
    if (fix.status !== 0) {
      warn('note: biome reported problems it could not fix — `pnpm lint` will show them.')
    }
    out('')
  }
  out(
    'Verify (the gate, no database needed for the first three):',
    '  pnpm types && pnpm lint && pnpm typecheck && pnpm test',
    '',
    'Then review the diff (`git diff --stat`), commit, and update docs/ADAPTING.md §1 for your app.'
  )
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  warn(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
