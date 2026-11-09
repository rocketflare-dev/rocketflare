/**
 * The one rule for a path that came from somewhere else — a plugin's manifest, a plugin's git
 * tree, a kit release — and is about to be used inside a checkout.
 *
 * `path.join` normalises `..` segments, so a string prefix test on the raw path and a join on the
 * result can disagree about where a file lands. So the rule is stated on the path's own segments:
 * every one is a plain name, and none of them is a git directory. A symlink cannot be seen in the
 * text, so the write check also walks the path on disk from the root down.
 *
 * `repoPathProblem` is pure; `writePathProblem` and `containedPath` read the filesystem.
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'

/** A segment naming a git directory on any filesystem: `.git`, `.GIT`, `.git.`, `.git `. */
const GIT_SEGMENT = /^\.git[. ]*$/i

/** `null` when `rel` is a plain repo-relative path inside its root, else the sentence why not. */
export function repoPathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'is not a repository-relative path'
  if (rel.includes('\0') || rel.includes('\\')) return 'contains a backslash or a NUL'
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'is an absolute path'
  const segments = rel.split('/')
  const odd = segments.find(s => s === '' || s === '.' || s === '..')
  if (odd !== undefined) return `has a ${odd === '' ? 'empty' : `'${odd}'`} path segment`
  if (segments.some(s => GIT_SEGMENT.test(s))) return 'is inside a .git directory'
  return null
}

/** The first existing component of `rel` below `root` that is a symlink, or null. */
function symlinkOnPath(root, rel) {
  let current = root
  for (const segment of rel.split('/')) {
    current = path.join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      return null
    }
    if (stat.isSymbolicLink()) return path.relative(root, current).split(path.sep).join('/')
  }
  return null
}

/**
 * `null` when `rel` may be written under `root`, else the sentence why not: the textual rule, plus
 * a symlink anywhere between the root and the file (the file itself included, since a write
 * follows it).
 */
export function writePathProblem(root, rel) {
  const problem = repoPathProblem(rel)
  if (problem) return problem
  const link = symlinkOnPath(root, rel)
  return link ? `passes through the symlink ${link}` : null
}

/** `rel` under `root` as an absolute path, or a thrown error when it may not be written there. */
export function containedPath(root, rel) {
  const problem = writePathProblem(root, rel)
  if (problem) throw new Error(`refusing to write '${rel}': it ${problem}`)
  return path.join(root, rel)
}
