/**
 * The git and filesystem half of `pnpm gate --changed` (the decisions are `gate-changed.mjs`).
 * The changed set is the same one vitest's own `--changed <ref>` uses: committed since the merge
 * base, staged, unstaged and untracked (not ignored).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}

/**
 * The commit `--changed` compares against: `ref` when given, else the merge base of HEAD with
 * `origin/main` (or `main` when there is no remote branch).
 * @returns {{ base: string, label: string } | { error: string }}
 */
export function resolveBase(root, ref) {
  const candidates = ref ? [ref] : ['origin/main', 'main']
  for (const c of candidates) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]) === null) continue
    const base = git(root, ['merge-base', 'HEAD', c])?.trim()
    if (base) return { base, label: `merge base with ${c}` }
  }
  return {
    error: ref
      ? `'${ref}' is not a commit this checkout has`
      : 'neither origin/main nor main exists here — name the base: --changed=<ref>',
  }
}

/** Every path that differs from `base`, repo-relative and sorted; `existing` drops the deleted. */
export function changedFiles(root, base) {
  const lists = [
    ['diff', '--name-only', '-z', `${base}...HEAD`],
    ['diff', '--name-only', '-z', '--cached'],
    ['ls-files', '-z', '--others', '--modified', '--exclude-standard'],
  ].map(args => git(root, args) ?? '')
  const changed = [...new Set(lists.flatMap(l => l.split('\0')).filter(Boolean))].sort()
  return { changed, existing: changed.filter(f => existsSync(path.join(root, f))) }
}

/** The workspace's packages (`apps/*`, `packages/*`), with their workspace deps and scripts. */
export function workspacePackages(root) {
  const out = []
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, 'package.json')
      if (!entry.isDirectory() || !existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      const all = { ...pkg.dependencies, ...pkg.devDependencies }
      out.push({
        dir: `${group}/${entry.name}`,
        name: pkg.name,
        deps: Object.keys(all).filter(k => String(all[k]).startsWith('workspace:')),
        scripts: Object.keys(pkg.scripts ?? {}),
      })
    }
  }
  return out
}
