/**
 * The pure half of the Claude Code guard (`scripts/kit-guard.mjs`): every decision the hook
 * makes, as functions of the hook payload, the manifest, the session state and the lint
 * findings. The hook does the I/O (stdin, git, the state file) and nothing else, so everything
 * here is unit-tested in `apps/web/tests/config/kit-guard-lib.test.ts`.
 *
 * Two jobs, one entry:
 *
 * - **The UI lint** (`lib/ui-lint.mjs`): findings reported after an edit to a UI file, and bans
 *   still present holding the Stop once. On wherever the guard is enabled, the kit included.
 * - **The core guard**: steer, then record. An edit to kit core (`lib/kit-guard-rules.mjs`) is
 *   allowed, with a word first about the seam that usually serves better; an edit that stands is
 *   recorded in `.rocketflare.json` `localEdits`, so `/rf-upgrade` can show WHY a local line
 *   differs from the kit when a later release changes it. On in a copy (`app != null`) or with
 *   `ROCKETFLARE_GUARD=1`; generated files are the one deny.
 *
 * `guard.enabled: false` in `.rocketflare.json`, or `ROCKETFLARE_GUARD=0`, turns both off.
 *
 * Capabilities (#183) are read but inert: no carrier exists yet, so `carriedPaths` of nothing is
 * nothing and every branch that consults it is a no-op until one does.
 */
import { GUARD_RULES, TIER_ORDER } from './kit-guard-rules.mjs'
import { formatFinding } from './ui-lint.mjs'
import { matchesAny } from './upgrade-lib.mjs'

/** Shortest `localEdits` reason accepted: long enough to say what and why. */
export const REASON_MIN = 20

const VAGUE_REASON =
  /^\s*(?:(?:the\s+)?user\s+(?:asked|wanted|requested|said)|as\s+(?:asked|requested)|requested|asked\s+for|needed|required|per\s+(?:the\s+)?(?:user|request)|because\s+(?:i|we)\s+(?:had|needed)\s+to)\b/i

const STATE_VERSION = 1

// ------------------------------------------------------------------ activation

/**
 * `{ lint, core }` — which halves run. `env` is `process.env`-shaped.
 */
export function guardSettings(manifest, env = {}) {
  if (env.ROCKETFLARE_GUARD === '0' || manifest?.guard?.enabled === false) {
    return { lint: false, core: false }
  }
  const copy = manifest != null && manifest.app != null
  return { lint: true, core: copy || env.ROCKETFLARE_GUARD === '1' }
}

// ------------------------------------------------------------------ paths

/** A repository-relative POSIX path for a tool's `file_path`, or null when it is outside. */
export function toRepoPath(roots, filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null
  const norm = p => p.replaceAll('\\', '/').replace(/\/+$/, '')
  const file = norm(filePath)
  if (!file.startsWith('/') && !/^[A-Za-z]:\//.test(file)) {
    return file.startsWith('../') ? null : file.replace(/^\.\//, '')
  }
  for (const root of (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map(norm)) {
    if (file.startsWith(`${root}/`)) return file.slice(root.length + 1)
  }
  return null
}

/**
 * `{ tier, rule }` for a path. Sealed first, then open (which includes every path of an
 * `example` surface in the manifest), then steer; anything else is the app's own and open.
 */
export function classifyGuardPath(rel, manifest = null, rules = GUARD_RULES) {
  for (const tier of TIER_ORDER) {
    for (const rule of rules.filter(r => r.tier === tier)) {
      if (matchesAny(rel, rule.paths)) return { tier, rule }
    }
    if (tier === 'sealed') {
      const example = (manifest?.surfaces ?? []).find(
        s => s.kind === 'example' && matchesAny(rel, s.paths ?? [])
      )
      if (example) return { tier: 'open', rule: null }
    }
  }
  return { tier: 'open', rule: null }
}

// ------------------------------------------------------------------ the ledger

/** The `localEdits` entries, whatever the manifest holds. */
export const ledgerOf = manifest => (Array.isArray(manifest?.localEdits) ? manifest.localEdits : [])

/** The entry recorded for a path (a glob entry counts), or null. */
export function ledgerEntryFor(manifest, rel) {
  return (
    ledgerOf(manifest).find(
      e => typeof e?.path === 'string' && (e.path === rel || matchesAny(rel, [e.path]))
    ) ?? null
  )
}

/** What is wrong with one `localEdits` entry — empty when it is a good record. */
export function ledgerProblems(entry) {
  const problems = []
  if (!entry || typeof entry !== 'object') return ['not an object']
  if (typeof entry.path !== 'string' || entry.path === '') problems.push('`path` is missing')
  if (entry.kind !== 'fix' && entry.kind !== 'change')
    problems.push('`kind` must be "fix" or "change"')
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : ''
  if (reason.length < REASON_MIN) {
    problems.push(`\`reason\` must say what changed and why, in at least ${REASON_MIN} characters`)
  } else if (VAGUE_REASON.test(reason)) {
    problems.push('`reason` must say why the change is needed, not who asked for it')
  }
  if (typeof entry.seamConsidered !== 'string' || entry.seamConsidered.trim() === '') {
    problems.push('`seamConsidered` must name the seam you looked at (or "none exists")')
  }
  if (entry.capability != null && !/^[a-z][a-z0-9-]*@\d+$/.test(String(entry.capability))) {
    problems.push('`capability` must look like `name@1`')
  }
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    problems.push('`date` must be YYYY-MM-DD')
  }
  return problems
}

/** A good entry for the path, or null — a rejected entry does not count as recorded. */
export function validLedgerEntry(manifest, rel) {
  const entry = ledgerEntryFor(manifest, rel)
  return entry && ledgerProblems(entry).length === 0 ? entry : null
}

// ------------------------------------------------------------------ capabilities (#183, inert)

/** The files a `capability.diff` touches (`+++ b/<path>` lines). */
export function carriedPaths(diffText) {
  if (typeof diffText !== 'string') return []
  const paths = new Set()
  for (const m of diffText.matchAll(/^\+\+\+ b\/(\S+)/gm)) paths.add(m[1])
  return [...paths]
}

/** The carrier whose diff covers a path: `{ name, note, paths }` or null. */
export function carrierFor(carriers, rel) {
  return (carriers ?? []).find(c => (c.paths ?? []).includes(rel)) ?? null
}

// ------------------------------------------------------------------ the words

const ledgerShape = rel =>
  `{ "path": "${rel}", "kind": "change", "reason": "<what changed and why>", ` +
  `"seamConsidered": "<the seam you looked at, or none exists>", "date": "<YYYY-MM-DD>" }`

/** The PreToolUse guidance for a steer path, said once per path per session. */
export function steerGuidance(rule, rel, { carrier = null, entry = null, repo = null } = {}) {
  if (carrier) {
    const ledger = entry ? ` Your localEdits entry for it says: "${entry.reason}".` : ''
    return (
      `${rel} is carried by the capability ${carrier.name}: follow its NOTE.md${carrier.note ? ` (${carrier.note})` : ''} ` +
      `rather than editing around it.${ledger}`
    )
  }
  const upstream = repo ? ` (${repo.replace(/\.git$/, '')}/issues)` : ''
  return [
    `${rel} is kit core — ${rule.why} Editing it is fine; it is also the line a later kit release`,
    'is most likely to change under you, so a word before you do:',
    `  1. The seam that usually fits: ${rule.instead}`,
    '  2. If none does, a NEW file beside it (wired in with one line) keeps the kit file close to upstream.',
    '  3. If it is a capability other code builds on, name it `name@1` and give it a test at',
    '     `apps/web/tests/capabilities/<name>@1/app.test.ts`, then record `capability` in the entry below.',
    `  4. Otherwise go ahead, and record it in .rocketflare.json \`localEdits\`: ${ledgerShape(rel)}`,
    `A bug in the kit itself is \`"kind": "fix"\` — worth reporting upstream${upstream} so the entry can go`,
    'once a release carries the fix.',
  ].join('\n')
}

/** The PreToolUse deny reason for a sealed path. */
export function sealedReason(rule, rel) {
  return (
    `${rel} is generated — ${rule.why} A hand edit is undone by the next run, so change its source ` +
    `and run \`${rule.regenerate}\` instead.`
  )
}

/** The SessionStart context: what the guard does, in about ten lines. */
export function sessionStartText({ core }) {
  const lines = [
    'This repository has a guard (scripts/kit-guard.mjs, Claude Code hooks).',
    'UI: edits under apps/web/src/ui/** and plugins/*/ui/** are checked against .claude/rules/ui.md',
    '"Visual quality" (`pnpm design:lint`); read docs/design/DESIGN.md first if it exists.',
  ]
  if (core) {
    lines.push(
      'Kit core is editable but steered: before an edit to a core file you get one note on the seam',
      'that usually fits (plugin slots in apps/web/src/plugins/types.ts, `@/plugins/api`, theme tokens,',
      'docs/design/brand.css). Your own code, the examples, Home and the design docs are free.',
      'An edit to core that stands gets an entry in .rocketflare.json `localEdits`',
      '({ path, kind: "fix"|"change", reason, seamConsidered, capability?, date }); /rf-upgrade shows',
      'that reason when a kit release changes the same lines. Generated files are refused: the guard',
      'names the command that regenerates each one.'
    )
  }
  return lines.join('\n')
}

/** The PostToolUse context for one UI file's findings (empty findings → null). */
export function postToolText(rel, findings) {
  if (!findings || findings.length === 0) return null
  const bans = findings.filter(f => f.severity === 'ban')
  const reflexes = findings.filter(f => f.severity === 'reflex')
  const lines = [`UI review of ${rel} (.claude/rules/ui.md "Visual quality"):`]
  for (const f of bans) lines.push(`  ${formatFinding(f)}`)
  for (const f of reflexes) lines.push(`  note: ${formatFinding(f)}`)
  if (bans.length > 0) {
    lines.push(
      'Bans are worth fixing now; an exception that is earned takes `// ui-allow <rule>: <reason>`.'
    )
  }
  if (reflexes.length > 0) lines.push('Notes are questions: keep one if the brief earns it.')
  return lines.join('\n')
}

// ------------------------------------------------------------------ session state

/** A fresh, or a sanitised, session state. */
export function normaliseState(raw) {
  const s = raw && typeof raw === 'object' && raw.v === STATE_VERSION ? raw : {}
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  return {
    v: STATE_VERSION,
    steered: list(s.steered),
    post: s.post && typeof s.post === 'object' ? { ...s.post } : {},
    stopBlocked: list(s.stopBlocked),
    reflexAsked: list(s.reflexAsked),
  }
}

/** A session id safe as a file name. */
export const stateName = sessionId =>
  `${
    String(sessionId ?? 'unknown')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 120) || 'unknown'
  }.json`

/** A stable fingerprint of a list of strings. */
export const fingerprint = items => [...new Set(items)].sort().join('\n')

const findingKey = f => `${f.file}:${f.rule}:${f.message}`

// ------------------------------------------------------------------ git

/**
 * `git status --porcelain=v1` lines → `[{ status, path }]`. A rename reports its new path; a
 * quoted path (spaces, unicode) is unquoted.
 */
export function parsePorcelain(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let file = line.slice(3)
    if (file.includes(' -> ')) file = file.split(' -> ').pop()
    if (file.startsWith('"') && file.endsWith('"')) {
      try {
        file = JSON.parse(file)
      } catch {}
    }
    out.push({ status, path: file })
  }
  return out
}

/** A tracked kit file this tree changed: modified, deleted or renamed — not new. */
export const changesTrackedFile = status => !/^(?:\?\?|A.|.A)$/.test(status) && status !== '!!'

// ------------------------------------------------------------------ the hook's decisions

/**
 * PreToolUse for one edited path: `{ kind: 'deny', reason } | { kind: 'guide', context } | null`,
 * and the next state. `exists` is whether the file is already on disk — a NEW file under a core
 * directory is the app's own, and is left alone.
 */
export function preToolDecision({ rel, manifest, state, settings, exists, carriers = [] }) {
  const next = normaliseState(state)
  if (!settings.core || !rel) return { decision: null, state: next }
  const { tier, rule } = classifyGuardPath(rel, manifest)
  if (tier === 'sealed')
    return { decision: { kind: 'deny', reason: sealedReason(rule, rel) }, state: next }
  if (tier !== 'steer' || !exists) return { decision: null, state: next }
  const carrier = carrierFor(carriers, rel)
  const entry = ledgerEntryFor(manifest, rel)
  if (!carrier && validLedgerEntry(manifest, rel)) return { decision: null, state: next }
  if (next.steered.includes(rel)) return { decision: null, state: next }
  next.steered.push(rel)
  const context = steerGuidance(rule, rel, { carrier, entry, repo: manifest?.kit?.repo ?? null })
  return { decision: { kind: 'guide', context }, state: next }
}

/**
 * PostToolUse for one UI file: the context to report, or null when there is nothing new since
 * the last report for that file in this session.
 */
export function postToolDecision({ rel, findings, state, settings }) {
  const next = normaliseState(state)
  if (!settings.lint || !rel) return { context: null, state: next }
  const fp = fingerprint(findings.map(findingKey))
  if ((next.post[rel] ?? '') === fp) return { context: null, state: next }
  next.post[rel] = fp
  return { context: postToolText(rel, findings), state: next }
}

/**
 * Stop: `{ block: reason | null, notice: text | null }` and the next state.
 *
 * - UI bans in changed files hold the Stop once (for a given set of bans).
 * - Changed core files with no good `localEdits` entry hold it once (for a given set of files),
 *   asking the agent to draft each entry and show it to the person.
 * - Reflexes never hold it: they are asked once — inside a block that happens anyway, or as a
 *   notice in the transcript.
 */
export function stopDecision({
  changes,
  manifest,
  findings,
  state,
  settings,
  stopHookActive,
  carriers = [],
}) {
  const next = normaliseState(state)
  if (stopHookActive) return { block: null, notice: null, state: next }
  const parts = []

  const bans = settings.lint ? findings.filter(f => f.severity === 'ban') : []
  const reflexes = settings.lint ? findings.filter(f => f.severity === 'reflex') : []
  const banFp = fingerprint(bans.map(findingKey))
  if (bans.length > 0 && !next.stopBlocked.includes(`ui\n${banFp}`)) {
    next.stopBlocked.push(`ui\n${banFp}`)
    parts.push(
      [
        `The UI review still has ${bans.length} ban(s) in files changed here:`,
        ...bans.map(f => `  ${formatFinding(f)}`),
        'Fix them, or mark an earned exception with `// ui-allow <rule>: <reason>`.',
      ].join('\n')
    )
  }

  if (settings.core) {
    const missing = []
    for (const { status, path } of changes) {
      if (!changesTrackedFile(status)) continue
      if (classifyGuardPath(path, manifest).tier !== 'steer') continue
      if (carrierFor(carriers, path)) continue
      if (validLedgerEntry(manifest, path)) continue
      const entry = ledgerEntryFor(manifest, path)
      missing.push({ path, problems: entry ? ledgerProblems(entry) : null })
    }
    const coreFp = fingerprint(missing.map(m => `${m.path}:${(m.problems ?? []).join(',')}`))
    if (missing.length > 0 && !next.stopBlocked.includes(`core\n${coreFp}`)) {
      next.stopBlocked.push(`core\n${coreFp}`)
      parts.push(
        [
          'Kit core changed in this tree without a `localEdits` record in .rocketflare.json:',
          ...missing.map(m =>
            m.problems
              ? `  ${m.path} — its entry is not accepted: ${m.problems.join('; ')}`
              : `  ${m.path}`
          ),
          'Draft one entry per file from this conversation — { path, kind: "fix"|"change", reason,',
          'seamConsidered, capability?, date } — with a reason that says what changed and why',
          `(${REASON_MIN}+ characters; "user asked" is not a reason), add it to \`localEdits\`, and show`,
          'the entries to the person in your final message. If the edit should not stand, revert it instead.',
        ].join('\n')
      )
    }
  }

  const reflexFp = fingerprint(reflexes.map(findingKey))
  let notice = null
  if (reflexes.length > 0 && !next.reflexAsked.includes(reflexFp)) {
    next.reflexAsked.push(reflexFp)
    const text = [
      `Design notes on files changed here (${reflexes.length}) — does the brief earn each one?`,
      ...reflexes.map(f => `  ${f.file}:${f.line} ${f.rule}: ${f.message}`),
    ].join('\n')
    if (parts.length > 0) parts.push(`${text}\n(A question, not a blocker.)`)
    else notice = text
  }

  return { block: parts.length > 0 ? parts.join('\n\n') : null, notice, state: next }
}

// ------------------------------------------------------------------ hook output

/** PreToolUse: refuse the call, with the reason Claude reads. */
export const denyOutput = reason =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

/**
 * PreToolUse: let the call go through the normal permission flow, with guidance attached. No
 * `permissionDecision`, on purpose: `allow` would also skip the person's permission prompt.
 */
export const guideOutput = (event, context) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  })

/** Stop: hold the turn open with a reason Claude acts on. */
export const blockOutput = reason => JSON.stringify({ decision: 'block', reason })

/** A transcript notice for the person; Claude is not asked to act. */
export const noticeOutput = text => JSON.stringify({ systemMessage: text })
