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
 * Installed plugins (D31) are reported but never touched: `classifyPath` drops every file a
 * `kind: 'plugin'` surface owns as `skipped-plugin-owned`, because the plugin has its own
 * repository and its own release chain (`pnpm plugin upgrade <id>`, run AFTER this). Two things it
 * does say out loud: a kit change to a file listed in a plugin's `registries[]` — the five barrels
 * are shared, so the kit CAN move ground under a plugin — and a target kit version that leaves an
 * installed plugin's `minKit` floor, which is exit 6.
 *
 * Exit 0 ok · 1 error · 2 usage · 3 kit unreachable with no cached mirror · 4 applied with
 * rejects (work remains, not a failure) · 5 `.rocketflare.json` missing · 6 an installed plugin
 * does not support the target kit version (`--force` to proceed). Zero dependencies, Node ≥ 24.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectChanges,
  collectRenames,
  dirtyTree,
  ensureMirror,
  makeGit,
  makeWriter,
  notesBetween,
} from './lib/git-lib.mjs'
import { MANIFEST_FILE, pluginSurfaces, readManifest } from './lib/manifest.mjs'
import { unsupportedForKit } from './lib/plugin-lib.mjs'
import { applyReplacements, deriveNames } from './lib/rename-lib.mjs'
import {
  absentSurfaces,
  classifyPath,
  countLines,
  matchesAny,
  parseNote,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from './lib/upgrade-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
// Re-exported rather than restated: `manifest.mjs` is the one place the provenance file is named,
// and it builds the name from `KIT.slug` so a rename cannot rewrite it.
const MANIFEST = MANIFEST_FILE
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
  --force                run on a dirty git tree, and past an installed plugin that does not
                         support the target kit version
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
//
// The mirror, the git wrappers, the artifact writer and the note reader now live in
// `scripts/lib/git-lib.mjs` — `scripts/plugin.mjs` runs the same pipeline over a plugin's
// repository, and two copies of `ensureMirror` is how one of them grows a fallback the other
// never gets (D31, Phase B).

const { git, quiet: gitQuiet } = makeGit(REPO_ROOT)

// ---------------------------------------------------------------- plan

// ---------------------------------------------------------------- main

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

  const { manifest, isKit } = readManifest(REPO_ROOT)
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

  if (isKit) {
    warn(
      'error: this checkout IS the kit (no `app` block in .rocketflare.json), so there is nothing',
      'to upgrade. Run this in a copy made from the kit.'
    )
    return 1
  }

  if (!args.dryRun && !args.force) {
    const dirty = dirtyTree(REPO_ROOT)
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
  const kit = ensureMirror(manifest.kit.repo, path.join(REPO_ROOT, WORK_DIR, 'kit.git'), {
    fetch: args.fetch,
    cwd: REPO_ROOT,
    warn,
  })
  out(`✔ 1/6 kit       mirror ${WORK_DIR}/kit.git ready (${manifest.kit.repo})`)
  if (!gitQuiet(['check-ignore', '-q', WORK_DIR]).ok) {
    warn(`note: add \`${WORK_DIR}/\` to .gitignore — it is a cache, not part of your app`)
  }

  // refs
  const from = args.from ?? manifest.kit.commit ?? manifest.kit.version
  if (!kit.resolves(from)) {
    warn(
      `error: '${from}' is not in the kit's history. The kit does not rewrite released history, so`,
      'this usually means the ref was a local commit. Pass --from <tag> with the release you started from.'
    )
    return 1
  }
  const to = args.to ?? kit.latestTag()
  if (!to || !kit.resolves(to)) {
    warn(
      `error: cannot resolve the target ref${to ? ` '${to}'` : ' (no release tags in the mirror)'}`
    )
    return 1
  }
  const toVersion = /^\d+\.\d+\.\d+$/.test(to) ? to : null
  const fromVersion = /^\d+\.\d+\.\d+$/.test(from) ? from : manifest.kit.version

  if (kit.commitOf(from) === kit.commitOf(to)) {
    out('', `Already on ${to} — nothing to do.`)
    return 0
  }
  // Going BACKWARDS. Not an error — replaying an older kit on purpose is a legitimate, if rare,
  // thing to want — but silently it reads as "the kit deleted 22 file(s)", including whole
  // subsystems, which is alarming and easy to act on by mistake. The usual cause is an untagged
  // branch head as `--from`, leaving `latestTag()` to pick an OLDER release as the target.
  if (kit.isAncestor(to, from)) {
    warn(
      `warning: '${to}' is an ancestor of '${from}' — this diff runs BACKWARDS, so kit additions`,
      'read as deletions. Pass --to <later ref> unless you meant to go back.'
    )
  }

  // 2/6 — surfaces
  const tracked = git(['ls-files']).trim().split('\n')
  const absent = absentSurfaces(manifest, tracked)
  const presentCount = manifest.surfaces.length - absent.length
  out(
    `✔ 2/6 surfaces  ${presentCount} of ${manifest.surfaces.length} present` +
      (absent.length > 0 ? ` — absent: ${absent.join(', ')}` : '')
  )

  // 2b — installed plugins. Reported before anything is classified, because "which plugins are
  // installed" changes what this run may write (their files are skipped wholesale) and what has to
  // happen after it (one `pnpm plugin upgrade` each).
  const plugins = pluginSurfaces(manifest).filter(p => !absent.includes(p.id))
  if (plugins.length > 0) {
    out(
      `  plugins     ${plugins.map(p => `${p.id}@${p.source?.version ?? '?'}`).join(', ')}` +
        ` — owned by their own repos; upgrade each with \`pnpm plugin upgrade <id>\` after this`
    )
  }
  // A vendored plugin is exempt, for the reason `plugin check` gives: the kit release that moves
  // the kit moves it too, so its range names the kit it shipped inside. One predicate, both tools.
  const unsupported = unsupportedForKit(plugins, {
    kitRepo: manifest.kit.repo,
    version: toVersion,
  })
  if (unsupported.length > 0 && !args.force) {
    warn(
      `error: ${unsupported.length} installed plugin(s) do not support kit ${toVersion}:`,
      ...unsupported.map(p => `  ${p.id} needs kit ${p.minKit} or newer`),
      '',
      'Three honest answers: stay on this kit version, `pnpm plugin remove <id>` first, or pass',
      '--force and fix what breaks — the gate is what will tell you.'
    )
    return 6
  }
  for (const p of unsupported) {
    warn(`warning: ${p.id} needs kit ${p.minKit} or newer — forced past it`)
  }

  // 3/6 — notes
  const notes = notesBetween(kit, to, { after: fromVersion, through: toVersion })
  const applicableNotes = notes.filter(n => {
    // `parseNote`, never a regex over the raw text: a hand-rolled `^requires_surfaces:\s*\[(.*)\]`
    // matches INLINE lists only, so a note written as a block sequence read as EMPTY and the whole
    // release was deemed applicable to an app that does not have the surface. README.md permits
    // both spellings, and `parseNote` is the one reader that knows it (and is quote-aware).
    const declared = parseNote(n.text)?.data?.requires_surfaces
    // `Array.isArray`, not `?? []`: a malformed `requires_surfaces: feature-agents` parses as a
    // SCALAR, and `.some` on a string is a TypeError — a generic crash on the upgrade path, which
    // is the failure shape this read was fixed to remove. An unreadable value means "not gated".
    const req = Array.isArray(declared) ? declared : []
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
  const changes = collectChanges(kit, from, to)
  const renames = collectRenames(kit, from, to)
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

  // A plugin's `registries[]` are the kit's own files (the five barrels), so the kit may change
  // them and this run may apply that change — but the line the plugin owns lives there, so a
  // conflict lands on somebody who did not write either side. Annotate rather than skip.
  for (const f of files) {
    const owners = plugins
      .filter(p => (p.registries ?? []).some(r => r === f.path || matchesAny(f.path, [r])))
      .map(p => p.id)
    if (owners.length > 0) f.touchesPluginRegistry = owners
  }

  const byClass = {}
  for (const f of files) byClass[f.class] = (byClass[f.class] ?? 0) + 1

  // 5/6 — artifacts
  const workRoot = path.join(REPO_ROOT, WORK_DIR, 'work', toVersion ?? to.slice(0, 12))
  const artifacts = makeWriter(workRoot)
  const write = artifacts.write

  const patches = []
  const addedFiles = []
  const warnings = []
  if (!args.dryRun) {
    artifacts.reset()
    for (const f of files) {
      if (f.class === 'modified' || f.class === 'verbatim') {
        const raw = kit.run(['diff', '--no-renames', from, to, '--', f.path])
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
        const body = kit.show(to, f.path)
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
        if (f.change !== 'deleted') write(path.join('reference', f.path), kit.show(to, f.path))
      }
    }
    for (const n of notes) write(path.join('notes', path.basename(n.file)), n.text)
    write('apply.patch', patches.join(''))
  }

  const plan = {
    from: {
      ref: from,
      commit: kit.commitOf(from),
      version: fromVersion,
    },
    to: { ref: to, commit: kit.commitOf(to), version: toVersion },
    names: {
      slug: names.slug,
      snake: names.snake,
      upper: names.upper,
      display: names.display,
      domain: names.domain,
    },
    plugins: plugins.map(p => ({
      id: p.id,
      version: p.source?.version ?? null,
      minKit: p.minKit ?? null,
      // Same answer the text report gives, vendored exemption included. Read `minKit`, not the
      // deleted `requires.kit`: reading the old field left `supported` permanently null for every
      // plugin, so `--json` answered "cannot tell" where the text report answered correctly.
      supported: toVersion && p.minKit ? !unsupported.includes(p) : null,
    })),
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
      touchesPluginRegistry: f.touchesPluginRegistry,
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
  const registryTouches = plan.files.filter(f => f.touchesPluginRegistry?.length > 0)
  if (registryTouches.length > 0) {
    lines.push(
      '',
      'touches-plugin-registry — the kit changed a file an installed plugin also writes a line',
      'into. Apply the kit change, then check the plugin line survived it:'
    )
    for (const f of registryTouches) {
      lines.push(`  ${f.path} — ${f.touchesPluginRegistry.join(', ')}`)
    }
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
