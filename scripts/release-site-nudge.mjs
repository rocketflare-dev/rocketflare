#!/usr/bin/env node
/**
 * A Claude Code `PreToolUse` hook: when a `git commit` changes the root `package.json` version —
 * which is what a release commit does — remind Claude to update the website (rocketflare-www)
 * once the tag is out. The changelog on rocketflare.dev is synced by hand from the GitHub Releases,
 * and a release that never reaches it is invisible to everybody reading the site.
 *
 * It runs in the kit (`.rocketflare.json` with no `app` block) and in the plugins monorepo (a
 * `plugins/<id>/rocketflare-plugin.json`), and exits silently anywhere else — an app's version is
 * its own business. The plugins repository carries a copy of this file and `lib/nudge-lib.mjs`.
 *
 * Advisory: it writes `additionalContext` (what Claude reads) and exits 0. Never fails a commit on
 * its own error. `ROCKETFLARE_WWW_DIR` names the site checkout in the reminder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitsAll, hookJson, isGitCommit, siteReminder, versionChange } from './lib/nudge-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** `kit`, `plugins` or `null` (anything else — an app, or not ours at all). */
function repoKind() {
  const manifest = path.join(REPO_ROOT, '.rocketflare.json')
  if (existsSync(manifest)) {
    return JSON.parse(readFileSync(manifest, 'utf8')).app == null ? 'kit' : null
  }
  const plugins = path.join(REPO_ROOT, 'plugins')
  if (!existsSync(plugins)) return null
  const hasPlugin = readdirSync(plugins, { withFileTypes: true }).some(
    d => d.isDirectory() && existsSync(path.join(plugins, d.name, 'rocketflare-plugin.json'))
  )
  return hasPlugin ? 'plugins' : null
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function main() {
  const payload = (() => {
    try {
      return JSON.parse(readStdin())
    } catch {
      return {}
    }
  })()
  const command = payload?.tool_input?.command ?? ''
  if (payload.tool_name !== 'Bash' || !isGitCommit(command)) return
  const kind = repoKind()
  if (!kind) return

  const before = git(['show', 'HEAD:package.json'])
  // `-a` commits the working tree's tracked changes; otherwise only what is staged.
  const after = commitsAll(command)
    ? readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    : git(['show', ':package.json'])
  const change = versionChange(before, after)
  if (!change) return

  const message = siteReminder({ ...change, kind, wwwDir: process.env.ROCKETFLARE_WWW_DIR })
  process.stdout.write(
    hookJson(message, `Release ${change.to}: remember to update rocketflare-www after tagging.`)
  )
}

try {
  main()
} catch {
  // A hook must never be the reason a commit fails.
}
process.exit(0)
