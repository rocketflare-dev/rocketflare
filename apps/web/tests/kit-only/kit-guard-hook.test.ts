/**
 * The guard hook (`scripts/kit-guard.mjs`) end to end, as Claude Code drives it: JSON on stdin,
 * JSON on stdout, in a throwaway git repository shaped like a RENAMED copy (`app != null`) — the
 * kit's own checkout has `app: null`, so its core half is off here. The decisions themselves are
 * unit-tested in `tests/config/kit-guard-lib.test.ts`; this proves the wiring: the state file
 * between calls, `git status` at Stop, the lint reading the file from disk.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GUARD_RULES } from '../../../../scripts/lib/kit-guard-rules.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const LEDGERED = {
  path: 'apps/web/src/api/routes/tenant.ts',
  kind: 'change',
  reason: 'Adds the tenant region field the billing proxy reads',
  seamConsidered: 'ServerPlugin.mounts — the route is the kit one, not a new prefix',
  date: '2026-11-25',
}

let copy: string
let stateDir: string

const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true })
  writeFileSync(path.join(copy, rel), text)
}

function hook(payload: Record<string, unknown>) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: stateDir }
  delete env.ROCKETFLARE_GUARD
  const result = spawnSync(process.execPath, [path.join(copy, 'scripts/kit-guard.mjs')], {
    input: JSON.stringify({ session_id: 'e2e', cwd: copy, ...payload }),
    encoding: 'utf8',
    env,
  })
  expect(result.status).toBe(0)
  return result.stdout.trim() === '' ? null : JSON.parse(result.stdout)
}

const edit = (event: 'PreToolUse' | 'PostToolUse', rel: string) =>
  hook({
    hook_event_name: event,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(copy, rel) },
  })

beforeAll(() => {
  copy = mkdtempSync(path.join(tmpdir(), 'kit-guard-copy-'))
  stateDir = mkdtempSync(path.join(tmpdir(), 'kit-guard-state-'))
  cpSync(path.join(REPO_ROOT, 'scripts/kit-guard.mjs'), path.join(copy, 'scripts/kit-guard.mjs'))
  cpSync(path.join(REPO_ROOT, 'scripts/lib'), path.join(copy, 'scripts/lib'), { recursive: true })
  write(
    '.rocketflare.json',
    `${JSON.stringify({ kit: { repo: 'https://example.test/kit.git' }, app: { slug: 'acme' }, guard: { enabled: true }, localEdits: [LEDGERED], surfaces: [] }, null, 2)}\n`
  )
  write('apps/web/src/api/index.ts', 'export const app = 1\n')
  write('apps/web/src/db/client.ts', 'export const db = 1\n')
  write('apps/web/src/api/routes/members.ts', 'export const members = 1\n')
  write('apps/web/src/api/routes/tenant.ts', 'export const tenant = 1\n')
  write('docs/plugin-api.md', '# generated\n')
  write(
    'apps/web/src/ui/pages/Thing.tsx',
    'export const Thing = () => <div className="bg-base-200" />\n'
  )
  const git = (...args: string[]) => execFileSync('git', args, { cwd: copy, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'copy')
}, 30_000)

afterAll(() => {
  rmSync(copy, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe('the guard in a renamed copy', () => {
  it('tells the session what it does', () => {
    const out = hook({ hook_event_name: 'SessionStart', source: 'startup' })
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toContain('localEdits')
  })

  it('pauses the first edit to core with the seam, then lets the retry through silently', () => {
    const first = edit('PreToolUse', 'apps/web/src/db/client.ts')
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny')
    const reason = first.hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('before you make this edit')
    expect(reason).toContain('tenantIsolation()')
    expect(reason).toContain('make it again; it will go through')
    expect(edit('PreToolUse', 'apps/web/src/db/client.ts')).toBeNull()
  })

  it('is silent for a ledgered core path', () => {
    expect(edit('PreToolUse', 'apps/web/src/api/routes/tenant.ts')).toBeNull()
  })

  it("pauses an edit to a kit route file, and leaves an app's own new route alone", () => {
    const first = edit('PreToolUse', 'apps/web/src/api/routes/members.ts')
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain('ServerPlugin.mounts')
    expect(edit('PreToolUse', 'apps/web/src/api/routes/members.ts')).toBeNull()
    expect(edit('PreToolUse', 'apps/web/src/api/routes/billing.ts')).toBeNull()
  })

  it('refuses a generated file, naming the command', () => {
    const out = edit('PreToolUse', 'docs/plugin-api.md')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('plugin-api-doc.mjs')
  })

  it('reviews a UI ban after the edit', () => {
    write(
      'apps/web/src/ui/pages/Thing.tsx',
      'export const Thing = () => <div className="bg-blue-50" />\n'
    )
    const out = edit('PostToolUse', 'apps/web/src/ui/pages/Thing.tsx')
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.additionalContext).toContain('palette-utility')
  })

  it('holds the Stop once for the ban and the unledgered core change, then lets it go', () => {
    write('apps/web/src/db/client.ts', 'export const db = 2\n')
    const first = hook({ hook_event_name: 'Stop', stop_hook_active: false })
    expect(first.decision).toBe('block')
    expect(first.reason).toContain('palette-utility')
    expect(first.reason).toContain('apps/web/src/db/client.ts')
    expect(first.reason).toContain('localEdits')
    expect(hook({ hook_event_name: 'Stop', stop_hook_active: true })).toBeNull()
    expect(hook({ hook_event_name: 'Stop', stop_hook_active: false })).toBeNull()
  })

  it("lists every route the kit ships, and nothing that isn't one", () => {
    const routes = readdirSync(path.join(REPO_ROOT, 'apps/web/src/api/routes'))
      .filter(f => f.endsWith('.ts'))
      .map(f => `apps/web/src/api/routes/${f}`)
      .sort()
    const rule = GUARD_RULES.find(r => r.id === 'kit-routes')
    expect([...(rule?.paths ?? [])].sort()).toEqual(routes)
  })

  it('fails open on input it cannot read', () => {
    const result = spawnSync(process.execPath, [path.join(copy, 'scripts/kit-guard.mjs')], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: stateDir },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
