/**
 * The host's own Biome, for the tools that WRITE translated kit or plugin files: `pnpm plugin`
 * (install, upgrade) and `pnpm kit:upgrade`. One copy, so the two cannot drift apart again.
 *
 * Run directly rather than through `pnpm exec`, which is a second Node start per call and fails
 * anyway, after that start, where Biome is not installed. A host without it gets the warning a
 * failed run gives, never a failed install or upgrade.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** `<root>/node_modules/.bin/biome`. */
export function biomeBin(root) {
  return path.join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'biome.cmd' : 'biome'
  )
}

/** Biome with these arguments in `root`, or a failed result when the host has none. */
export function runBiome(root, args, options = {}) {
  const bin = biomeBin(root)
  if (!existsSync(bin)) return { status: 1, error: new Error('no biome'), stdout: null }
  return spawnSync(bin, args, { cwd: root, ...options })
}

/** What Biome formats: a translated file of any other kind is left as written. */
export const BIOME_FILE_RE = /\.(?:[cm]?[jt]sx?|mts|cts|jsonc?|css)$/

/**
 * Biome over what was just written, and this is not tidiness.
 *
 * Kit and plugin files are authored in the KIT's vocabulary and translated on the way in, so their
 * import specifiers change length AND sort order: `@heroicons/react` sorts BEFORE
 * `@rocketflare/shared` and AFTER `@acme/shared`, and a longer app name pushes a line past 100
 * columns. The kit's file is correctly formatted; the same file translated is not, and `pnpm lint`
 * — the first step of the gate the tool tells you to run next — fails on a file the tool wrote.
 * `rename.mjs` solves the identical problem the identical way (`pnpm lint:fix` at the end).
 *
 * Scoped to `paths` (repo-relative), so it never reformats unrelated work in progress; no paths
 * would be the whole repository, which is never what an install or upgrade means. Returns the
 * line to print, or null when Biome did not run.
 */
export function formatWritten(root, paths, { warn = () => {} } = {}) {
  if (paths.length === 0) return null
  const r = runBiome(root, ['check', '--write', '--no-errors-on-unmatched', ...paths], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.error || r.status === null) {
    warn('note: biome did not run — check the formatting of the copied files with `pnpm lint`.')
    return null
  }
  if (r.status !== 0) {
    warn('note: biome reported problems it could not fix — `pnpm lint` will show them.')
  }
  return 'formatted with biome (translation changes import order and line length)'
}
