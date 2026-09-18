/**
 * The IMPURE half the porting scripts share: git wrappers, the blobless bare mirror, the artifact
 * writer and the release-note reader (D31, Phase B step 1).
 *
 * `scripts/upgrade.mjs` grew all four while it was the only thing that ported a repository into
 * this one. `scripts/plugin.mjs` ports a second kind — a plugin's repository — through exactly the
 * same pipeline (mirror → notes → classify → translate → artifacts → apply), so either they are
 * shared or they are copied, and a copied `ensureMirror` is the sort of thing that grows a
 * different fallback on one side and nowhere else.
 *
 * `upgrade-lib.mjs` stays pure and untouched; this file is where the `child_process` and `fs` calls
 * live. `git-lib.d.mts` beside it is the hand-written type surface (no `allowJs`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The `-z` field separator every `--name-status` / `--numstat` read below splits on. */
const NUL = '\0'

/**
 * `{ git, quiet }` bound to one working directory. `git` throws on a non-zero status (the caller
 * wants the failure); `quiet` returns `{ ok, out, err }` for the calls whose failure is an ANSWER —
 * "this ref does not resolve", "there is no remote" — rather than an error.
 */
export function makeGit(cwd) {
  const git = (args, opts = {}) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
    })
  const quiet = (args, opts = {}) => {
    try {
      return { ok: true, out: git(args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
    } catch (err) {
      return { ok: false, out: '', err }
    }
  }
  return { git, quiet }
}

/** True when the working tree at `cwd` has no uncommitted change. Returns the porcelain text. */
export function dirtyTree(cwd) {
  return makeGit(cwd).quiet(['status', '--porcelain']).out.trim()
}

/**
 * Where a PLUGIN repository's mirror lives, relative to the repository root. One constant, because
 * `scripts/plugin.mjs` and `scripts/release.mjs` mirror the same repositories: a second spelling
 * would mean two clones of one plugin, and whichever the release read would be the stale one.
 */
export const PLUGIN_MIRROR_ROOT = path.join('.upgrade', 'plugins')

/**
 * `<root>/<last path segment of repo>.git` — the directory a repository's bare mirror occupies.
 *
 * Shared for the same reason as the constant above. `root` is absolute; the caller decides which
 * work directory it is mirroring into.
 */
export function mirrorDirFor(repo, root) {
  const name = String(repo)
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean)
    .pop()
  return path.join(root, `${name}.git`)
}

/**
 * A blobless bare mirror of `repo` at `dir`, reused across runs — never a remote on the host
 * repository, whose tags would collide with the mirrored one's and whose objects the host would
 * push. `rm -rf .upgrade` is a complete uninstall.
 *
 * Throws with `exitCode: 3` when the remote cannot be reached and there is no usable cache, which
 * is the one failure a caller reports differently from a genuine error.
 */
export function ensureMirror(
  repo,
  dir,
  { fetch = true, cwd = process.cwd(), warn = () => {} } = {}
) {
  if (!existsSync(dir)) {
    if (!fetch) throw new Error(`no cached mirror at ${dir} and --no-fetch was given`)
    mkdirSync(path.dirname(dir), { recursive: true })
    const clone = spawnSync(
      'git',
      ['clone', '--bare', '--filter=blob:none', '--no-tags', repo, dir],
      {
        cwd,
        stdio: 'inherit',
      }
    )
    if (clone.status !== 0) {
      // A git too old for partial clone, or a server that refuses it.
      rmSync(dir, { recursive: true, force: true })
      const plain = spawnSync('git', ['clone', '--bare', repo, dir], { cwd, stdio: 'inherit' })
      if (plain.status !== 0)
        throw Object.assign(new Error(`cannot clone ${repo}`), { exitCode: 3 })
    }
    makeGit(cwd).git([
      '-C',
      dir,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ])
  } else {
    const url = makeGit(cwd).quiet(['-C', dir, 'remote', 'get-url', 'origin']).out.trim()
    if (url && url !== repo) {
      throw new Error(`${dir} points at ${url}, not ${repo} — delete it and re-run`)
    }
  }
  if (fetch) {
    const fetched = makeGit(cwd).quiet(['-C', dir, 'fetch', '--prune', '--tags', 'origin'])
    if (!fetched.ok && !existsSync(path.join(dir, 'HEAD'))) {
      throw Object.assign(new Error(`cannot reach ${repo}`), { exitCode: 3 })
    }
    if (!fetched.ok) warn('note: fetch failed — using the cached mirror as it is')
  }
  return mirror(dir)
}

/** The read-only handle onto a bare mirror: everything either script asks of one. */
export function mirror(dir) {
  const { git, quiet } = makeGit(dir)
  return {
    dir,
    run: args => git(args),
    quiet,
    resolves: ref => quiet(['rev-parse', '--verify', `${ref}^{commit}`]).ok,
    commitOf: ref => git(['rev-parse', `${ref}^{commit}`]).trim(),
    show: (ref, file) => git(['show', `${ref}:${file}`]),
    /** The blob as BYTES — the only safe read for a file that may not be UTF-8. */
    showRaw: (ref, file) => git(['show', `${ref}:${file}`], { encoding: 'buffer' }),
    tryShow: (ref, file) => quiet(['show', `${ref}:${file}`]),
    /** Every file at `ref` under `prefix` ('' = the whole tree), as repo-relative paths. */
    listFiles: (ref, prefix = '') => {
      const args = ['ls-tree', '-r', '--name-only', '-z', ref]
      if (prefix !== '') args.push('--', `${prefix.replace(/\/$/, '')}/`)
      return quiet(args).out.split(NUL).filter(Boolean)
    },
    /**
     * True when `ancestor` is reachable from `descendant` — i.e. the diff from `descendant` to
     * `ancestor` runs BACKWARDS. A target that is an ancestor of the source is almost always a
     * mistake (an untagged branch head as `--from`, so `latestTag()` picks an older release as
     * `--to`), and the report it produces reads as "the kit deleted 22 files".
     */
    isAncestor: (ancestor, descendant) =>
      quiet(['merge-base', '--is-ancestor', ancestor, descendant]).ok,
    /** Newest `X.Y.Z` tag, or null. */
    latestTag: () =>
      quiet(['tag', '--list', '--sort=-v:refname'])
        .out.trim()
        .split('\n')
        .filter(t => /^\d+\.\d+\.\d+$/.test(t))[0] ?? null,
  }
}

const CHANGE_OF = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }

/**
 * `[{ path, change }]` between two refs. `relative` limits the diff to a subdirectory AND strips
 * the prefix from every path, which is what lets a plugin live in a subdirectory of its repository
 * and still arrive at host-relative paths.
 */
export function collectChanges(m, from, to, { relative = null } = {}) {
  const rel = relative ? [`--relative=${relative.replace(/\/$/, '')}`] : []
  const nameStatus = m.run(['diff', '--no-renames', '--name-status', '-z', ...rel, from, to])
  const numstat = m.run(['diff', '--no-renames', '--numstat', '-z', ...rel, from, to])

  const binary = new Set()
  const numFields = numstat.split(NUL).filter(Boolean)
  for (let i = 0; i + 2 < numFields.length + 1; i += 3) {
    const [adds, dels, file] = [numFields[i], numFields[i + 1], numFields[i + 2]]
    if (file && adds === '-' && dels === '-') binary.add(file)
  }

  const fields = nameStatus.split(NUL).filter(Boolean)
  const changes = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = fields[i + 1]
    changes.push({
      path: file,
      change: binary.has(file) ? 'binary' : (CHANGE_OF[fields[i][0]] ?? 'modified'),
    })
  }
  return changes
}

/** The `-M` pass is narrative only — never bytes that are applied. */
export function collectRenames(m, from, to, { relative = null } = {}) {
  const rel = relative ? [`--relative=${relative.replace(/\/$/, '')}`] : []
  const fields = m
    .quiet(['diff', '-M', '--name-status', '-z', ...rel, from, to])
    .out.split(NUL)
    .filter(Boolean)
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

/**
 * The `docs/upgrades/X.Y.Z.md` notes visible at `ref`, oldest first, bounded by version.
 *
 * `after` is exclusive (the release the host already has) and `through` inclusive (the release it
 * is moving to); either may be null, which means "no bound on that end". The files are read from
 * the TARGET tree rather than from each tag, so a note edited after its release is read in its
 * current form — the same rule `upgrade.mjs` has always used.
 */
export function notesBetween(m, ref, { after = null, through = null, dir = 'docs/upgrades' } = {}) {
  const listed = m.quiet(['ls-tree', '--name-only', `${ref}:${dir}`]).out
  const files = listed.trim() === '' ? [] : listed.trim().split('\n')
  const notes = []
  for (const f of files) {
    const version = f.match(/^(\d+\.\d+\.\d+)\.md$/)?.[1]
    if (!version) continue
    if (after && cmp(version, after) <= 0) continue
    if (through && cmp(version, through) > 0) continue
    notes.push({ version, file: `${dir}/${f}`, text: m.quiet(['show', `${ref}:${dir}/${f}`]).out })
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

/**
 * A writer rooted at one directory: `write('added/x.ts', text)` creates the parents and writes.
 * `reset()` empties the root first, so a re-run never mixes this run's artifacts with the last.
 */
export function makeWriter(root) {
  const write = (rel, text) => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
    return abs
  }
  return { root, write, reset: () => rmSync(root, { recursive: true, force: true }) }
}
