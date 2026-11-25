/**
 * The guard's decisions (`scripts/lib/kit-guard-lib.mjs`, rules in `kit-guard-rules.mjs`): which
 * paths are sealed, steered or open, what a `localEdits` entry must say, and when a session's
 * Stop is held. Every case is built from fixtures — a manifest, a state, a finding list — so the
 * suite never judges the checkout it runs in and travels into every copy. The end-to-end run of
 * the hook through stdin is kit-only (`tests/kit-only/kit-guard-hook.test.ts`). The `config`
 * project: no database.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  carriedPaths,
  classifyGuardPath,
  guardSettings,
  ledgerProblems,
  normaliseState,
  parsePorcelain,
  postToolDecision,
  preToolDecision,
  stateName,
  stopDecision,
  toRepoPath,
} from '../../../../scripts/lib/kit-guard-lib.mjs'
import { GUARD_RULES } from '../../../../scripts/lib/kit-guard-rules.mjs'
import type { UiFinding } from '../../../../scripts/lib/ui-lint.d.mts'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const COPY = {
  app: { slug: 'acme' },
  kit: { repo: 'https://github.com/x/kit.git' },
  localEdits: [],
}
const ON = { lint: true, core: true }

const goodEntry = (p: string) => ({
  path: p,
  kind: 'change',
  reason: 'Adds the tenant region header the billing proxy reads',
  seamConsidered: 'ServerPlugin.mounts middleware — runs too late for the proxy',
  date: '2026-11-25',
})

const ban = (file: string): UiFinding => ({
  rule: 'palette-utility',
  severity: 'ban',
  file,
  line: 3,
  message: 'A Tailwind palette utility.',
  fix: 'A DaisyUI semantic class.',
})
const reflex = (file: string): UiFinding => ({
  ...ban(file),
  rule: 'hero-metric',
  severity: 'reflex',
})

describe('activation', () => {
  it('runs the core half only in a copy or when asked, and the lint wherever it is enabled', () => {
    expect(guardSettings({ app: null })).toEqual({ lint: true, core: false })
    expect(guardSettings({ app: null }, { ROCKETFLARE_GUARD: '1' })).toEqual({
      lint: true,
      core: true,
    })
    expect(guardSettings(COPY)).toEqual({ lint: true, core: true })
    expect(guardSettings({ ...COPY, guard: { enabled: false } })).toEqual({
      lint: false,
      core: false,
    })
    expect(guardSettings(COPY, { ROCKETFLARE_GUARD: '0' })).toEqual({ lint: false, core: false })
  })
})

describe('the rules', () => {
  it('seals generated files, opens the replaceable ones, and steers the core', () => {
    expect(classifyGuardPath('apps/web/worker-configuration.d.ts').tier).toBe('sealed')
    expect(classifyGuardPath('apps/web/migrations/meta/_journal.json').tier).toBe('sealed')
    expect(classifyGuardPath('apps/web/src/plugins/server.ts').tier).toBe('sealed')
    expect(classifyGuardPath('apps/web/src/ui/pages/Home.tsx').tier).toBe('open')
    expect(classifyGuardPath('apps/web/src/shared/theme-tokens.css').tier).toBe('open')
    expect(classifyGuardPath('.rocketflare.json').tier).toBe('open')
    expect(classifyGuardPath('apps/web/src/api/index.ts').tier).toBe('steer')
    expect(classifyGuardPath('apps/web/src/api/middleware/csrf.ts').tier).toBe('steer')
    expect(classifyGuardPath('apps/web/src/db/client.ts').tier).toBe('steer')
    expect(classifyGuardPath('scripts/lib/upgrade-lib.mjs').tier).toBe('steer')
    expect(classifyGuardPath('apps/web/src/billing/service.ts').tier).toBe('open')
  })

  it('opens every path of an example surface', () => {
    const manifest = {
      surfaces: [{ kind: 'example', paths: ['apps/web/src/api/routes/demo.ts'] }],
    }
    expect(classifyGuardPath('apps/web/src/api/routes/demo.ts', manifest).tier).toBe('open')
  })

  it('gives every sealed rule a command and every steer rule a seam (or says there is none)', () => {
    for (const rule of GUARD_RULES) {
      if (rule.tier === 'sealed') expect(rule.regenerate, rule.id).toMatch(/\S/)
      if (rule.tier === 'steer') expect(rule.instead, rule.id).toMatch(/`|no seam/)
      expect(rule.why, rule.id).toMatch(/\S/)
    }
  })

  it('names only seams this checkout carries', () => {
    // The members a steer rule tells you to reach for must exist where it says they do.
    const types = path.join(REPO_ROOT, 'apps/web/src/plugins/types.ts')
    if (!existsSync(types)) return
    const source = readFileSync(types, 'utf8')
    const members = new Set(
      GUARD_RULES.flatMap(r =>
        [...(r.instead ?? '').matchAll(/`ServerPlugin\.(\w+)`/g)].map(m => m[1])
      )
    )
    for (const member of members) expect(source, member).toMatch(new RegExp(`\\b${member}\\??:`))
  })
})

describe('the ledger', () => {
  it('accepts a good entry and says what is wrong with a bad one', () => {
    expect(ledgerProblems(goodEntry('apps/web/src/db/client.ts'))).toEqual([])
    expect(ledgerProblems({ ...goodEntry('x'), reason: 'tweak' }).join()).toMatch(/at least 20/)
    expect(
      ledgerProblems({ ...goodEntry('x'), reason: 'The user asked for this change today' }).join()
    ).toMatch(/not who asked/)
    expect(ledgerProblems({ ...goodEntry('x'), kind: 'tweak' }).join()).toMatch(/kind/)
    expect(ledgerProblems({ ...goodEntry('x'), capability: 'Region' }).join()).toMatch(/name@1/)
    expect(ledgerProblems({ ...goodEntry('x'), capability: 'tenant-region@1' })).toEqual([])
  })
})

describe('PreToolUse', () => {
  const rel = 'apps/web/src/db/client.ts'

  it('speaks once per path per session, with the seam ladder', () => {
    const first = preToolDecision({ rel, manifest: COPY, state: null, settings: ON, exists: true })
    expect(first.decision?.kind).toBe('guide')
    const text = first.decision && 'context' in first.decision ? first.decision.context : ''
    expect(text).toContain('tenantIsolation()')
    expect(text).toContain('localEdits')
    expect(text).toContain('tests/capabilities/<name>@1/app.test.ts')
    expect(text).toContain('https://github.com/x/kit/issues')
    const second = preToolDecision({
      rel,
      manifest: COPY,
      state: first.state,
      settings: ON,
      exists: true,
    })
    expect(second.decision).toBeNull()
  })

  it('is silent for a ledgered path, a new file, an open path, and outside a copy', () => {
    const ledgered = { ...COPY, localEdits: [goodEntry(rel)] }
    expect(
      preToolDecision({ rel, manifest: ledgered, state: null, settings: ON, exists: true }).decision
    ).toBeNull()
    const fresh = 'apps/web/src/api/middleware/region.ts'
    expect(
      preToolDecision({ rel: fresh, manifest: COPY, state: null, settings: ON, exists: false })
        .decision
    ).toBeNull()
    const open = 'apps/web/src/ui/pages/Home.tsx'
    expect(
      preToolDecision({ rel: open, manifest: COPY, state: null, settings: ON, exists: true })
        .decision
    ).toBeNull()
    const kit = { lint: true, core: false }
    expect(
      preToolDecision({ rel, manifest: COPY, state: null, settings: kit, exists: true }).decision
    ).toBeNull()
  })

  it('denies a sealed path, naming the command', () => {
    const { decision } = preToolDecision({
      rel: 'docs/plugin-api.md',
      manifest: COPY,
      state: null,
      settings: ON,
      exists: true,
    })
    expect(decision?.kind).toBe('deny')
    expect(decision && 'reason' in decision ? decision.reason : '').toContain(
      'node scripts/plugin-api-doc.mjs'
    )
  })

  it('points a carried path at its capability note (inert until a carrier exists)', () => {
    const carriers = [
      { name: 'region@1', note: 'NOTE.md', paths: carriedPaths(`+++ b/${rel}\n@@`) },
    ]
    const { decision } = preToolDecision({
      rel,
      manifest: COPY,
      state: null,
      settings: ON,
      exists: true,
      carriers,
    })
    expect(decision && 'context' in decision ? decision.context : '').toMatch(/region@1.*NOTE\.md/)
    expect(carriedPaths('')).toEqual([])
  })
})

describe('PostToolUse', () => {
  it('reports findings, and stays quiet until they change', () => {
    const rel = 'apps/web/src/ui/pages/X.tsx'
    const first = postToolDecision({ rel, findings: [ban(rel)], state: null, settings: ON })
    expect(first.context).toContain('palette-utility')
    expect(first.context).toContain('Fix:')
    const again = postToolDecision({ rel, findings: [ban(rel)], state: first.state, settings: ON })
    expect(again.context).toBeNull()
    const clean = postToolDecision({ rel, findings: [], state: first.state, settings: ON })
    expect(clean.context).toBeNull()
  })
})

describe('Stop', () => {
  const ui = 'apps/web/src/ui/pages/X.tsx'
  const core = 'apps/web/src/api/index.ts'

  it('holds once for a UI ban and lets the same bans go the second time', () => {
    const input = {
      changes: [{ status: ' M', path: ui }],
      manifest: COPY,
      settings: ON,
      stopHookActive: false,
    }
    const first = stopDecision({ ...input, findings: [ban(ui)], state: null })
    expect(first.block).toContain('palette-utility')
    const second = stopDecision({ ...input, findings: [ban(ui)], state: first.state })
    expect(second.block).toBeNull()
  })

  it('never holds for a reflex alone: it is a notice, asked once', () => {
    const input = {
      changes: [{ status: '??', path: ui }],
      manifest: COPY,
      settings: ON,
      stopHookActive: false,
    }
    const first = stopDecision({ ...input, findings: [reflex(ui)], state: null })
    expect(first.block).toBeNull()
    expect(first.notice).toMatch(/does the brief earn/)
    expect(stopDecision({ ...input, findings: [reflex(ui)], state: first.state }).notice).toBeNull()
  })

  it('asks for a localEdits entry for a changed core file, once, and rejects a vague one', () => {
    const changes = [{ status: ' M', path: core }]
    const input = { changes, findings: [], settings: ON, stopHookActive: false }
    const first = stopDecision({ ...input, manifest: COPY, state: null })
    expect(first.block).toContain(core)
    expect(first.block).toContain('show')
    expect(stopDecision({ ...input, manifest: COPY, state: first.state }).block).toBeNull()
    const vague = { ...COPY, localEdits: [{ ...goodEntry(core), reason: 'user asked' }] }
    expect(stopDecision({ ...input, manifest: vague, state: null }).block).toMatch(/not accepted/)
    const good = { ...COPY, localEdits: [goodEntry(core)] }
    expect(stopDecision({ ...input, manifest: good, state: null }).block).toBeNull()
  })

  it('ignores new files, honours stop_hook_active, and leaves the kit to its maintainers', () => {
    const fresh = stopDecision({
      changes: [{ status: '??', path: 'apps/web/src/api/middleware/region.ts' }],
      manifest: COPY,
      findings: [],
      state: null,
      settings: ON,
      stopHookActive: false,
    })
    expect(fresh.block).toBeNull()
    const active = stopDecision({
      changes: [{ status: ' M', path: core }],
      manifest: COPY,
      findings: [ban(ui)],
      state: null,
      settings: ON,
      stopHookActive: true,
    })
    expect(active.block).toBeNull()
    const kit = stopDecision({
      changes: [{ status: ' M', path: core }],
      manifest: { app: null },
      findings: [],
      state: null,
      settings: { lint: true, core: false },
      stopHookActive: false,
    })
    expect(kit.block).toBeNull()
  })
})

describe('plumbing', () => {
  it('reads git porcelain, including renames and quoted paths', () => {
    expect(parsePorcelain(' M a.ts\nR  old.ts -> new.ts\n?? "with space.tsx"\n')).toEqual([
      { status: ' M', path: 'a.ts' },
      { status: 'R ', path: 'new.ts' },
      { status: '??', path: 'with space.tsx' },
    ])
  })

  it('maps a tool path into the repository, and nothing outside it', () => {
    expect(toRepoPath(['/r', '/private/r'], '/private/r/apps/x.ts')).toBe('apps/x.ts')
    expect(toRepoPath('/r', '/elsewhere/x.ts')).toBeNull()
    expect(toRepoPath('/r', undefined)).toBeNull()
  })

  it('keeps a session id safe as a file name, and a corrupt state fresh', () => {
    expect(stateName('../../etc/passwd')).toBe('______etc_passwd.json')
    expect(normaliseState({ v: 99, steered: ['x'] }).steered).toEqual([])
  })
})
