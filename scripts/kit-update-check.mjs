#!/usr/bin/env node
/**
 * A Claude Code `SessionStart` hook: once per session, tell the person when the Rocketflare kit
 * this app was made from has a newer release, and point them at `/rf-upgrade`.
 *
 * It runs only in a COPY of the kit (`.rocketflare.json` with an `app` block), only on a fresh
 * `startup` (not `resume`, `clear` or `compact`), never in CI, and never with
 * `ROCKETFLARE_UPDATE_CHECK=0`. The newest release is one `git ls-remote --tags` against
 * `kit.repo` — no API, no token — cached in the git-ignored `.claude/kit-update-check.json` for a
 * day, so a day of sessions costs one network call; a failed check is remembered for an hour, so an
 * offline laptop pays the 4-second timeout at most once an hour rather than on every session. The
 * one-line summaries come from the kit's `CHANGELOG.md` at the new tag (GitHub remotes only).
 *
 * Output is the hook's JSON `additionalContext`: Claude reads it and mentions the update once.
 * Every failure — offline, a slow remote, a malformed manifest — is SILENCE and exit 0: this must
 * never block or slow a session. The decisions are in `lib/update-check-lib.mjs`, unit-tested.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { MANIFEST_FILE } from './lib/manifest.mjs'
import {
  changelogSummaries,
  freshCache,
  latestVersion,
  rawFileUrl,
  skipReason,
  updateMessage,
} from './lib/update-check-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_FILE = path.join(REPO_ROOT, '.claude', 'kit-update-check.json')
const NETWORK_TIMEOUT_MS = 4000

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

async function newestRelease(repo) {
  const { stdout } = await promisify(execFile)('git', ['ls-remote', '--tags', '--refs', repo], {
    timeout: NETWORK_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return latestVersion(stdout.split('\n'))
}

async function summariesFor(repo, current, latest) {
  const url = rawFileUrl(repo, latest, 'CHANGELOG.md')
  if (!url) return []
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
    return res.ok ? changelogSummaries(await res.text(), current, latest) : []
  } catch {
    return []
  }
}

async function main() {
  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {}
  const manifestPath = path.join(REPO_ROOT, MANIFEST_FILE)
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null
  if (skipReason({ source: payload.source, manifest, env: process.env })) return

  const repo = manifest.kit.repo
  const current = manifest.kit.version
  const now = Date.now()
  let answer = freshCache(readJson(CACHE_FILE), { repo, current, now })
  if (!answer) {
    const latest = await newestRelease(repo).catch(() => undefined)
    const summaries = latest ? await summariesFor(repo, current, latest) : []
    answer =
      latest === undefined
        ? { repo, current, checkedAt: now, latest: null, summaries: [], failed: true }
        : { repo, current, checkedAt: now, latest, summaries }
    try {
      mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
      writeFileSync(CACHE_FILE, `${JSON.stringify(answer, null, 2)}\n`)
    } catch {}
  }

  const message = updateMessage({ current, latest: answer.latest, summaries: answer.summaries })
  if (!message) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
    })
  )
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
