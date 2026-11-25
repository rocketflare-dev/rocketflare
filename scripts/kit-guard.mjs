#!/usr/bin/env node
/**
 * The guard: one Claude Code hook entry (`.claude/settings.json`) for four events.
 *
 * - `SessionStart` — about ten lines on what the guard does and where the ledger is.
 * - `PreToolUse` (Edit/Write/MultiEdit/NotebookEdit) — a generated file is refused, naming the
 *   command that regenerates it; an existing kit-core file gets one note per session on the seam
 *   that usually fits (silent once the path has a `localEdits` entry).
 * - `PostToolUse` (Edit/Write/MultiEdit) — a UI file is linted (`lib/ui-lint.mjs`) and its
 *   findings are reported as a review, each with its fix.
 * - `Stop` — UI bans still present, or changed kit-core files with no `localEdits` entry, hold
 *   the turn ONCE; reflexes are asked once and never hold it. `stop_hook_active` is honoured.
 *
 * Every decision is in `lib/kit-guard-lib.mjs`; the rules are `lib/kit-guard-rules.mjs`. The core
 * half runs in a copy (`.rocketflare.json` `app != null`) or with `ROCKETFLARE_GUARD=1`; the UI
 * half wherever the guard is enabled. `guard.enabled: false` or `ROCKETFLARE_GUARD=0` turns both
 * off. Per-session state is `$TMPDIR/rocketflare-guard/<session_id>.json`.
 *
 * Known gaps (docs/CONCEPTS.md §13): Claude Code only — an editor or a terminal never sees it —
 * and an edit made through Bash is seen only at Stop, through `git status`.
 *
 * Fails open: any error is silence and exit 0. A guard must never be the reason a session breaks.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  blockOutput,
  carriedPaths,
  denyOutput,
  guardSettings,
  guideOutput,
  normaliseState,
  noticeOutput,
  parsePorcelain,
  postToolDecision,
  preToolDecision,
  sessionStartText,
  stateName,
  stopDecision,
  toRepoPath,
} from './lib/kit-guard-lib.mjs'
import { MANIFEST_FILE } from './lib/manifest.mjs'
import { isUiPath, lintSource } from './lib/ui-lint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const roots = () => {
  const out = [ROOT]
  try {
    out.push(realpathSync(ROOT))
  } catch {}
  return out
}

/** The tool's path with symlinks resolved (macOS `/var` is `/private/var`); the file may not exist yet. */
function realFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return file
  let dir = path.dirname(file)
  const rest = [path.basename(file)]
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir))
    dir = path.dirname(dir)
  }
  try {
    return path.join(realpathSync(dir), ...rest)
  } catch {
    return file
  }
}

const stateFile = sessionId => path.join(os.tmpdir(), 'rocketflare-guard', stateName(sessionId))

const loadState = sessionId => normaliseState(readJson(stateFile(sessionId)))

function saveState(sessionId, state) {
  try {
    mkdirSync(path.dirname(stateFile(sessionId)), { recursive: true })
    writeFileSync(stateFile(sessionId), JSON.stringify(state))
  } catch {}
}

/**
 * Installed capability carriers (#183): `apps/web/src/plugins/<id>/capabilities/<name>/` holding
 * a `capability.diff` and a `NOTE.md`. None exist yet, so this returns [] and nothing consults it.
 */
function findCarriers() {
  const base = path.join(ROOT, 'apps/web/src/plugins')
  const carriers = []
  if (!existsSync(base)) return carriers
  for (const plugin of readdirSync(base, { withFileTypes: true })) {
    const dir = path.join(base, plugin.name, 'capabilities')
    if (!plugin.isDirectory() || !existsSync(dir)) continue
    for (const cap of readdirSync(dir, { withFileTypes: true })) {
      const diff = path.join(dir, cap.name, 'capability.diff')
      if (!cap.isDirectory() || !existsSync(diff)) continue
      carriers.push({
        name: cap.name,
        note: path.relative(ROOT, path.join(dir, cap.name, 'NOTE.md')),
        paths: carriedPaths(readFileSync(diff, 'utf8')),
      })
    }
  }
  return carriers
}

const lintFile = rel => {
  const full = path.join(ROOT, rel)
  return existsSync(full) ? lintSource(readFileSync(full, 'utf8'), rel) : []
}

function main() {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return
  }
  const manifest = readJson(path.join(ROOT, MANIFEST_FILE))
  if (!manifest) return
  const settings = guardSettings(manifest, process.env)
  if (!settings.lint && !settings.core) return
  const event = payload.hook_event_name
  const sessionId = payload.session_id

  if (event === 'SessionStart') {
    process.stdout.write(guideOutput('SessionStart', sessionStartText(settings)))
    return
  }

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (!EDIT_TOOLS.has(payload.tool_name)) return
    const input = payload.tool_input ?? {}
    const raw = input.file_path ?? input.notebook_path
    const rel = toRepoPath(roots(), raw) ?? toRepoPath(roots(), realFile(raw))
    if (!rel) return
    const state = loadState(sessionId)
    if (event === 'PreToolUse') {
      const { decision, state: next } = preToolDecision({
        rel,
        manifest,
        state,
        settings,
        exists: existsSync(path.join(ROOT, rel)),
        carriers: settings.core ? findCarriers() : [],
      })
      if (!decision) return
      if (decision.kind === 'guide') saveState(sessionId, next)
      process.stdout.write(
        decision.kind === 'deny'
          ? denyOutput(decision.reason)
          : guideOutput('PreToolUse', decision.context)
      )
      return
    }
    if (!isUiPath(rel)) return
    const { context, state: next } = postToolDecision({
      rel,
      findings: lintFile(rel),
      state,
      settings,
    })
    saveState(sessionId, next)
    if (context) process.stdout.write(guideOutput('PostToolUse', context))
    return
  }

  if (event === 'Stop') {
    if (payload.stop_hook_active === true) return
    const status = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const changes = parsePorcelain(status)
    const findings = settings.lint
      ? changes
          .filter(c => !c.status.includes('D') && isUiPath(c.path))
          .flatMap(c => lintFile(c.path))
      : []
    const { block, notice, state } = stopDecision({
      changes,
      manifest,
      findings,
      state: loadState(sessionId),
      settings,
      stopHookActive: false,
      carriers: settings.core ? findCarriers() : [],
    })
    saveState(sessionId, state)
    if (block) process.stdout.write(blockOutput(block))
    else if (notice) process.stdout.write(noticeOutput(notice))
  }
}

try {
  main()
} catch {
  // Fail open: the guard is advice, never the reason a session stops working.
}
process.exit(0)
