#!/usr/bin/env node
/**
 * Port later kit improvements into this app — the other half of `docs/ADAPTING.md` §0.
 *
 *   node scripts/upgrade.mjs [--to <ref>] [--from <ref>] [--no-fetch] [--apply]
 *                            [--apply-deletes] [--include-kit-tooling] [--adopt <ref>]
 *                            [--dry-run] [--force] [--json]
 *
 * A copy of the kit is detached and renamed, so it can never merge from upstream. What it CAN do
 * is replay a kit diff that has been translated into its own names and filtered down to the parts
 * it still has. That is all this script does:
 *
 *   1. fetch the kit into a git-ignored bare mirror (`.upgrade/kit.git`) — never a remote on this
 *      repo, whose tags would collide with the kit's and whose objects the adopter would push;
 *   2. read `.rocketflare.json` for the commit this app came from and the manifest of replaceable
 *      surfaces, and work out which of those surfaces still exist here (the anchor file decides);
 *   3. classify every changed path, dropping anything belonging to a surface that is gone;
 *   4. translate the survivors through `scripts/lib/rename-lib.mjs` — the same token map the
 *      rename used — and write a patch, the whole text of every added file, and a plan;
 *   5. with `--apply`, write the added files and `git apply` the patch, falling back to per-file
 *      `--reject` so one stale file cannot block the rest.
 *
 * It never applies a kit migration (port the schema, then `pnpm db:generate` — the kit's snapshot
 * chain would tell drizzle your own tables do not exist), never writes a resource id into a
 * wrangler toml, and never deletes a file without `--apply-deletes`. Resolving rejects and making
 * the judgement calls is the agent's job: `.claude/skills/rf-upgrade/`.
 *
 * Exit 0 ok · 1 error · 2 usage · 3 kit unreachable with no cached mirror · 4 applied with
 * rejects (work remains, not a failure) · 5 `.rocketflare.json` missing. Zero dependencies, Node ≥ 24.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyReplacements, deriveNames } from './lib/rename-lib.mjs'
import {
  absentSurfaces,
  classifyPath,
  countLines,
  isKitManifest,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from './lib/upgrade-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const MANIFEST = '.rocketflare.json'
const WORK_DIR = '.upgrade'

const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE = `usage: node scripts/upgrade.mjs [--to <ref>] [--from <ref>] [--no-fetch]
                                [--apply] [--apply-deletes] [--include-kit-tooling]
                                [--adopt <ref>] [--dry-run] [--force] [--json]

  --to <ref>             kit tag or commit to move to (default: newest release tag in the mirror)
  --from <ref>           override the adopted ref (default: kit.commit, else the kit.version tag)
  --no-fetch             use the cached mirror as-is (offline)
  --apply                write the added files and apply the patch; without it the run is a plan
  --apply-deletes        also delete the files the kit deleted (off by default — you may have
                         built on one)
  --include-kit-tooling  port scripts/rename.mjs and its lib, untranslated
  --adopt <ref>          one-off: stamp this ref into .rocketflare.json and exit (for a copy made
                         before the manifest existed)
  --dry-run              resolve and classify, write nothing at all
  --force                run on a dirty git tree
  --json                 print the plan as JSON on stdout (what /rf-upgrade reads)
  -h, --help`

export function parseArgs(argv) {
  const args = {
    to: null,
    from: null,
    fetch: true,
    apply: false,
    applyDeletes: false,
    includeKitTooling: false,
    adopt: null,
    dryRun: false,
    force: false,
    json: false,
  }
  const takesValue = { '--to': 'to', '--from': 'from', '--adopt': 'adopt' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return { help: true }
    if (a in takesValue) {
      const v = argv[++i]
      if (!v || v.startsWith('-')) return { error: `${a} needs a value` }
      args[takesValue[a]] = v
      continue
    }
    if (a === '--no-fetch') args.fetch = false
    else if (a === '--apply') args.apply = true
    else if (a === '--apply-deletes') args.applyDeletes = true
    else if (a === '--include-kit-tooling') args.includeKitTooling = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--force') args.force = true
    else if (a === '--json') args.json = true
    else return { error: `unknown option '${a}'` }
  }
  return args
}

// ---------------------------------------------------------------- git helpers

const git = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  })

const gitQuiet = (args, opts = {}) => {
  try {
    return { ok: true, out: git(args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (err) {
    return { ok: false, out: '', err }
  }
}

const mirrorDir = () => path.join(REPO_ROOT, WORK_DIR, 'kit.git')
const inMirror = args => git(['-C', mirrorDir(), ...args])
const inMirrorQuiet = args => gitQuiet(['-C', mirrorDir(), ...args])

/** A blobless bare mirror, reused across runs. `rm -rf .upgrade` is a complete uninstall. */
function ensureMirror(repo, doFetch) {
  const dir = mirrorDir()
  if (!existsSync(dir)) {
    if (!doFetch)
      throw new Error(`no cached mirror at ${WORK_DIR}/kit.git and --no-fetch was given`)
    mkdirSync(path.dirname(dir), { recursive: true })
    const clone = spawnSync(
      'git',
      ['clone', '--bare', '--filter=blob:none', '--no-tags', repo, dir],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    )
    if (clone.status !== 0) {
      // A git too old for partial clone, or a server that refuses it.
      rmSync(dir, { recursive: true, force: true })
      const plain = spawnSync('git', ['clone', '--bare', repo, dir], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      })
      if (plain.status !== 0)
        throw Object.assign(new Error(`cannot clone ${repo}`), { exitCode: 3 })
    }
    inMirror(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  } else {
    const url = inMirrorQuiet(['remote', 'get-url', 'origin']).out.trim()
    if (url && url !== repo) {
      throw new Error(`${WORK_DIR}/kit.git points at ${url}, not ${repo} — delete it and re-run`)
    }
  }
  if (doFetch) {
    const fetched = inMirrorQuiet(['fetch', '--prune', '--tags', 'origin'])
    if (!fetched.ok && !existsSync(path.join(dir, 'HEAD'))) {
      throw Object.assign(new Error(`cannot reach ${repo}`), { exitCode: 3 })
    }
    if (!fetched.ok) warn('note: fetch failed — using the cached mirror as it is')
  }
}

/** Newest `X.Y.Z` tag in the mirror. */
function latestTag() {
  const tags = inMirrorQuiet(['tag', '--list', '--sort=-v:refname'])
    .out.trim()
    .split('\n')
    .filter(t => /^\d+\.\d+\.\d+$/.test(t))
  return tags[0] ?? null
}

const resolves = ref => inMirrorQuiet(['rev-parse', '--verify', `${ref}^{commit}`]).ok

// ---------------------------------------------------------------- plan

const CHANGE_OF = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }

function collectChanges(from, to) {
  const nameStatus = inMirror(['diff', '--no-renames', '--name-status', '-z', from, to])
  const numstat = inMirror(['diff', '--no-renames', '--numstat', '-z', from, to])

  const binary = new Set()
  const numFields = numstat.split('\0').filter(Boolean)
  for (let i = 0; i + 2 < numFields.length + 1; i += 3) {
    const [adds, dels, file] = [numFields[i], numFields[i + 1], numFields[i + 2]]
    if (file && adds === '-' && dels === '-') binary.add(file)
  }

  const fields = nameStatus.split('\0').filter(Boolean)
  const changes = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i][0]
    const file = fields[i + 1]
    changes.push({
      path: file,
      change: binary.has(file) ? 'binary' : (CHANGE_OF[status] ?? 'modified'),
    })
  }
  return changes
}

/** The `-M` pass is narrative only — never bytes that are applied. */
function collectRenames(from, to) {
  const raw = inMirrorQuiet(['diff', '-M', '--name-status', '-z', from, to]).out
  const fields = raw.split('\0').filter(Boolean)
  const renames = []
  for (let i = 0; i < fields.length; i++) {
    if (/^R\d+$/.test(fields[i])) {
      renames.push({
        from: fields[i + 1],
        to: fields[i + 2],
        similarity: Number(fields[i].slice(1)),
      })
      i += 2
    } else if (/^[AMDT]$/.test(fields[i])) i += 1
  }
  return renames
}

function notesBetween(from, to, fromVersion, toVersion) {
  const listed = inMirrorQuiet(['ls-tree', '--name-only', `${to}:docs/upgrades`]).out
  const files = listed.trim() === '' ? [] : listed.trim().split('\n')
  const notes = []
  for (const f of files) {
    const m = f.match(/^(\d+\.\d+\.\d+)\.md$/)
    if (!m) continue
    const version = m[1]
    if (fromVersion && cmp(version, fromVersion) <= 0) continue
    if (toVersion && cmp(version, toVersion) > 0) continue
    const text = inMirrorQuiet(['show', `${to}:docs/upgrades/${f}`]).out
    notes.push({ version, file: `docs/upgrades/${f}`, text })
  }
  return notes.sort((a, b) => cmp(a.version, b.version))
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  return 0
}

// ---------------------------------------------------------------- main

function readManifest() {
  const file = path.join(REPO_ROOT, MANIFEST)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeManifest(manifest) {
  writeFileSync(path.join(REPO_ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return 0
  }
  if (args.error) {
    warn(`error: ${args.error}`, '', USAGE)
    return 2
  }

  const manifest = readManifest()
  if (!manifest) {
    warn(
      `error: ${MANIFEST} not found — this copy predates the upgrade path.`,
      '',
      'Find the kit commit you started from (the installer records it in the first commit):',
      '  git log --format=%B -1 $(git rev-list --max-parents=0 HEAD)',
      'then stamp it in:',
      '  node scripts/upgrade.mjs --adopt <commit-or-tag>'
    )
    return 5
  }

  if (args.adopt) {
    manifest.kit.commit = args.adopt
    writeManifest(manifest)
    out(
      `adopted — ${MANIFEST} now records kit commit ${args.adopt}.`,
      '',
      'Verify: node scripts/upgrade.mjs'
    )
    return 0
  }

  if (isKitManifest(manifest)) {
    warn(
      'error: this checkout IS the kit (no `app` block in .rocketflare.json), so there is nothing',
      'to upgrade. Run this in a copy made from the kit.'
    )
    return 1
  }

  if (!args.dryRun && !args.force) {
    const dirty = gitQuiet(['status', '--porcelain']).out.trim()
    if (dirty !== '') {
      warn(
        'error: the git tree is not clean — commit or stash first so the upgrade is one reviewable',
        'diff (or pass --force). `git status --short` shows:',
        dirty
      )
      return 1
    }
  }

  const names = deriveNames(manifest.app.slug, manifest.app.display, {
    domain: manifest.app.domain,
  })

  // 1/6 — the mirror
  ensureMirror(manifest.kit.repo, args.fetch)
  out(`✔ 1/6 kit       mirror ${WORK_DIR}/kit.git ready (${manifest.kit.repo})`)
  if (!gitQuiet(['check-ignore', '-q', WORK_DIR]).ok) {
    warn(`note: add \`${WORK_DIR}/\` to .gitignore — it is a cache, not part of your app`)
  }

  // refs
  const from = args.from ?? manifest.kit.commit ?? manifest.kit.version
  if (!resolves(from)) {
    warn(
      `error: '${from}' is not in the kit's history. The kit does not rewrite released history, so`,
      'this usually means the ref was a local commit. Pass --from <tag> with the release you started from.'
    )
    return 1
  }
  const to = args.to ?? latestTag()
  if (!to || !resolves(to)) {
    warn(
      `error: cannot resolve the target ref${to ? ` '${to}'` : ' (no release tags in the mirror)'}`
    )
    return 1
  }
  const toVersion = /^\d+\.\d+\.\d+$/.test(to) ? to : null
  const fromVersion = /^\d+\.\d+\.\d+$/.test(from) ? from : manifest.kit.version

  if (
    inMirror(['rev-parse', `${from}^{commit}`]).trim() ===
    inMirror(['rev-parse', `${to}^{commit}`]).trim()
  ) {
    out('', `Already on ${to} — nothing to do.`)
    return 0
  }

  // 2/6 — surfaces
  const tracked = git(['ls-files']).trim().split('\n')
  const absent = absentSurfaces(manifest, tracked)
  const presentCount = manifest.surfaces.length - absent.length
  out(
    `✔ 2/6 surfaces  ${presentCount} of ${manifest.surfaces.length} present` +
      (absent.length > 0 ? ` — absent: ${absent.join(', ')}` : '')
  )

  // 3/6 — notes
  const notes = notesBetween(from, to, fromVersion, toVersion)
  const applicableNotes = notes.filter(n => {
    const req = (n.text.match(/^requires_surfaces:\s*\[(.*)\]/m)?.[1] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    return !req.some(id => absent.includes(id))
  })
  out(
    `✔ 3/6 notes     ${notes.length} release note(s)` +
      (notes.length !== applicableNotes.length
        ? `, ${notes.length - applicableNotes.length} not applicable to this app`
        : '')
  )

  // 4/6 — classify
  const localSet = new Set(tracked)
  const changes = collectChanges(from, to)
  const renames = collectRenames(from, to)
  const files = changes.map(c => ({
    ...c,
    ...classifyPath(c.path, {
      manifest,
      absent,
      existsLocally: localSet.has(c.path),
      change: c.change,
      includeKitTooling: args.includeKitTooling,
    }),
  }))

  const byClass = {}
  for (const f of files) byClass[f.class] = (byClass[f.class] ?? 0) + 1

  // 5/6 — artifacts
  const workRoot = path.join(REPO_ROOT, WORK_DIR, 'work', toVersion ?? to.slice(0, 12))
  const write = (rel, text) => {
    const abs = path.join(workRoot, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }

  const patches = []
  const addedFiles = []
  const warnings = []
  if (!args.dryRun) {
    rmSync(workRoot, { recursive: true, force: true })
    for (const f of files) {
      if (f.class === 'modified' || f.class === 'verbatim') {
        const raw = inMirror(['diff', '--no-renames', from, to, '--', f.path])
        const blocks = splitDiff(raw)
        if (blocks.length === 0) continue
        let translated
        try {
          translated = blocks
            .map(b => {
              const t = translateBlock(b, names, { translate: f.translate })
              // The hunk headers are only valid because a substitution moves columns, never
              // lines. Assert it rather than trust it.
              if (countLines(stripIndexLines(b.raw)) !== countLines(t)) {
                throw new Error(`translation changed the line count of ${f.path}`)
              }
              return t
            })
            .join('')
        } catch (err) {
          warnings.push(`${f.path}: ${err.message}`)
          f.class = 'binary'
          continue
        }
        write(path.join('files', `${f.path}.patch`), translated)
        patches.push(translated)
      } else if (f.class === 'added' || f.class === 'added-collides') {
        const body = inMirror(['show', `${to}:${f.path}`])
        const text = f.translate ? applyNames(body, names) : body
        write(path.join('added', f.path), text)
        if (f.class === 'added') addedFiles.push(f.path)
      } else if (
        f.class === 'migration-derived' ||
        f.class === 'manual-toml' ||
        f.class === 'manual-env' ||
        f.class === 'manual' ||
        f.class === 'binary'
      ) {
        if (f.change !== 'deleted')
          write(path.join('reference', f.path), inMirror(['show', `${to}:${f.path}`]))
      }
    }
    for (const n of notes) write(path.join('notes', path.basename(n.file)), n.text)
    write('apply.patch', patches.join(''))
  }

  const plan = {
    from: {
      ref: from,
      commit: inMirror(['rev-parse', `${from}^{commit}`]).trim(),
      version: fromVersion,
    },
    to: { ref: to, commit: inMirror(['rev-parse', `${to}^{commit}`]).trim(), version: toVersion },
    names: {
      slug: names.slug,
      snake: names.snake,
      upper: names.upper,
      display: names.display,
      domain: names.domain,
    },
    surfaces: {
      present: manifest.surfaces.map(s => s.id).filter(id => !absent.includes(id)),
      absent,
    },
    notes: notes.map(n => ({
      version: n.version,
      file: n.file,
      applicable: applicableNotes.includes(n),
    })),
    files: files.map(f => ({
      path: f.path,
      class: f.class,
      change: f.change,
      reason: f.reason,
      surface: f.surface,
    })),
    renames,
    counts: byClass,
    warnings,
    workDir: path.relative(REPO_ROOT, workRoot),
  }
  if (!args.dryRun) {
    write('plan.json', `${JSON.stringify(plan, null, 2)}\n`)
    write('plan.md', renderPlan(plan, notes))
  }
  out(
    `✔ 4/6 patch     ${files.length} changed file(s): ` +
      Object.entries(byClass)
        .sort()
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')
  )
  out(`✔ 5/6 plan      ${args.dryRun ? '(dry run — nothing written)' : `${plan.workDir}/plan.md`}`)

  // 6/6 — apply
  let rejected = 0
  if (args.apply && !args.dryRun) {
    for (const rel of addedFiles) {
      const abs = path.join(REPO_ROOT, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, readFileSync(path.join(workRoot, 'added', rel), 'utf8'))
    }
    if (patches.length > 0) {
      const combined = path.join(workRoot, 'apply.patch')
      const check = gitQuiet([
        '-c',
        'core.autocrlf=false',
        'apply',
        '--check',
        '--whitespace=nowarn',
        '-p1',
        combined,
      ])
      if (check.ok) {
        git(['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-p1', combined])
      } else {
        for (const f of files.filter(x => x.class === 'modified' || x.class === 'verbatim')) {
          const one = path.join(workRoot, 'files', `${f.path}.patch`)
          if (!existsSync(one)) continue
          const r = gitQuiet([
            '-c',
            'core.autocrlf=false',
            'apply',
            '--reject',
            '--whitespace=nowarn',
            '-p1',
            one,
          ])
          if (!r.ok) rejected += 1
        }
      }
    }
    out(
      `✔ 6/6 apply     ${addedFiles.length} added, ${patches.length - rejected} patched` +
        (rejected > 0 ? `, ${rejected} with rejects (*.rej beside the file)` : '')
    )
    if (rejected === 0) {
      manifest.kit.version = toVersion ?? manifest.kit.version
      manifest.kit.commit = plan.to.commit
      manifest.history.push({
        from: plan.from.commit,
        to: plan.to.commit,
        at: new Date().toISOString().slice(0, 10),
      })
      writeManifest(manifest)
    }
  } else {
    out(`✔ 6/6 apply     not applied (re-run with --apply)`)
  }

  if (args.json) out(JSON.stringify(plan, null, 2))
  else out('', ...report(plan, notes, applicableNotes), '')

  out(
    'Verify (the gate):',
    '  pnpm install && pnpm types && pnpm lint && pnpm typecheck && pnpm test',
    ...(files.some(f => f.class === 'migration-derived')
      ? ["  pnpm db:generate   your OWN migration for the kit schema change — never copy the kit's"]
      : [])
  )
  if (rejected > 0) return 4
  return 0
}

/** The token map applied to a whole file — only for files whose body is translated. */
function applyNames(text, names) {
  return applyReplacements(text, names).text
}

function report(plan, notes, applicable) {
  const lines = []
  const bucket = cls => plan.files.filter(f => f.class === cls)
  const skippedSurface = bucket('skipped-surface-absent').length
  const skippedLocal = bucket('skipped-locally-deleted').length
  if (skippedSurface > 0) {
    lines.push(
      `Skipped ${skippedSurface} file(s) belonging to surfaces this app does not have ` +
        `(${plan.surfaces.absent.join(', ')}). That is by design, not an error.`
    )
  }
  if (skippedLocal > 0) lines.push(`Skipped ${skippedLocal} file(s) you had already deleted.`)
  // D31: a plugin ships its own release chain, so a KIT diff never touches its files. Reported
  // rather than silently dropped, because "the kit changed nothing here" and "the kit is not
  // allowed to change anything here" are different answers.
  const pluginOwned = bucket('skipped-plugin-owned')
  if (pluginOwned.length > 0) {
    const ids = [...new Set(pluginOwned.map(f => f.surface).filter(Boolean))]
    lines.push(
      `Skipped ${pluginOwned.length} file(s) owned by installed plugin(s) (${ids.join(', ')}). ` +
        `Upgrade those with \`pnpm plugin upgrade <id>\`, after this.`
    )
  }
  const manual = [
    ...bucket('manual'),
    ...bucket('manual-toml'),
    ...bucket('manual-env'),
    ...bucket('added-collides'),
    ...bucket('binary'),
  ]
  if (manual.length > 0) {
    lines.push('', 'Decide these yourself (the kit version is under reference/):')
    for (const f of manual) lines.push(`  ${f.path} — ${f.reason}`)
  }
  const migrations = bucket('migration-derived')
  if (migrations.length > 0) {
    lines.push(
      '',
      `The kit added ${migrations.length} migration file(s). Do NOT copy them: their snapshot carries the`,
      "kit's whole schema, so your next `pnpm db:generate` would emit DROP TABLE for your own tables.",
      'The schema change itself is in this patch — run `pnpm db:generate` to get your own migration,',
      'then compare it with reference/apps/web/migrations/ and hand-port anything drizzle cannot',
      'derive from schema (data backfills, CREATE EXTENSION, triggers).'
    )
  }
  const deletes = bucket('deleted')
  if (deletes.length > 0) {
    lines.push(
      '',
      `The kit deleted ${deletes.length} file(s); left in place (pass --apply-deletes to remove them):`
    )
    for (const f of deletes.slice(0, 10)) lines.push(`  ${f.path}`)
  }
  if (plan.renames.length > 0) {
    lines.push('', 'Moved in the kit — carry your local edits across:')
    for (const r of plan.renames) lines.push(`  ${r.from} → ${r.to} (${r.similarity}% similar)`)
  }
  if (notes.length > 0) {
    lines.push('', 'Release notes:')
    for (const n of notes) {
      lines.push(
        `  ${n.version}  ${n.file}${applicable.includes(n) ? '' : '  (not applicable here)'}`
      )
    }
  }
  for (const w of plan.warnings) lines.push(`  warning: ${w}`)
  return lines
}

function renderPlan(plan, notes) {
  const lines = [
    `# Upgrade ${plan.from.version ?? plan.from.ref} → ${plan.to.version ?? plan.to.ref}`,
    '',
    `App: ${plan.names.display} (${plan.names.slug})`,
    `Surfaces present: ${plan.surfaces.present.join(', ') || 'none'}`,
    `Surfaces absent: ${plan.surfaces.absent.join(', ') || 'none'}`,
    '',
    '## Files',
    '',
    '| path | class | why |',
    '|---|---|---|',
    ...plan.files.map(f => `| ${f.path} | ${f.class} | ${f.reason} |`),
    '',
    '## Release notes',
    '',
  ]
  for (const n of notes) lines.push(`### ${n.version}`, '', n.text, '')
  return `${lines.join('\n')}\n`
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  warn(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = err?.exitCode ?? 1
}
