/**
 * The boundary check over this app's units — its installed plugins and its own domains
 * (docs/CONCEPTS.md §20). Two halves:
 *
 * - **from source** (`scripts/lib/units.mjs`, the same findings `pnpm plugin check` prints): ids,
 *   `dependsOn` edges and cycles, table namespaces and collisions, and the import walk. A `fail`
 *   fails here; a `warn` (another unit's table used directly) is printed and passes.
 * - **from the evaluated lists** (`units/server.ts`, `units/ui.ts`, `@rocketflare/shared/units`):
 *   the namespaces only a module can answer — job types, events, routes, query keys, agent and
 *   prompt keys — strict for every unit and never shared between two, plugins and domains alike.
 *
 * It runs over whatever units this checkout has, so an app with no domains passes trivially.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { eventNameProblem } from '@rocketflare/shared/plugins'
import { sharedUnits } from '@rocketflare/shared/units'
import { describe, expect, it } from 'vitest'
import { APP_DOMAINS } from '@/app'
import { APP_DOMAIN_UIS } from '@/app-ui'
import { serverUnits } from '@/units/server'
import { uiUnits } from '@/units/ui'
import { parseToml } from '../../../../scripts/lib/toml-lite.mjs'
import { readUnits, unitFindings } from '../../../../scripts/lib/units.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
const units = readUnits(REPO_ROOT, { manifest })
const findings = unitFindings(REPO_ROOT, { manifest, units })

describe('the boundary check, from source', () => {
  it('finds no boundary a unit crosses', () => {
    const fails = findings.filter(f => f.severity === 'fail')
    expect(
      fails.map(f => `${f.file}${f.line ? `:${f.line}` : ''} — ${f.problem}\n  fix: ${f.fix}`)
    ).toEqual([])
  })

  it('reports direct use of another unit’s tables, without failing', () => {
    for (const w of findings.filter(f => f.severity === 'warn')) {
      console.warn(`[units] ${w.file}${w.line ? `:${w.line}` : ''} — ${w.problem}\n  ${w.fix}`)
    }
    expect(findings.every(f => f.severity === 'fail' || f.kind === 'table-use')).toBe(true)
  })
})

describe('the app’s domains', () => {
  const domains = serverUnits.filter(u => u.kind === 'domain')
  const staticDomains = units.filter(u => u.kind === 'domain')

  it('are the domains app.ts lists, each in a directory named after its id', () => {
    expect(domains.map(d => d.id)).toEqual(staticDomains.map(d => d.id))
    expect(APP_DOMAINS.length).toBe(domains.length)
  })

  it('declare at runtime the same edges the source says', () => {
    for (const d of domains) {
      const read = staticDomains.find(s => s.id === d.id)
      expect(d.dependsOn, d.id).toEqual(read?.dependsOn)
    }
  })

  it('have a shared half for every server half, and a UI half only for a domain that exists', () => {
    const shared = new Set(sharedUnits.map(s => s.id))
    for (const d of domains) expect(shared.has(d.id), d.id).toBe(true)
    const ids = new Set(domains.map(d => d.id))
    for (const ui of APP_DOMAIN_UIS as readonly { id: string }[])
      expect(ids.has(ui.id), ui.id).toBe(true)
  })

  it('run their crons only on an expression both tomls already trigger', () => {
    const crons = (file: string) =>
      new Set(
        (
          parseToml(readFileSync(path.join(REPO_ROOT, 'apps/web', file), 'utf8')) as {
            triggers?: { crons?: string[] }
          }
        ).triggers?.crons ?? []
      )
    for (const file of ['wrangler.toml', 'wrangler.staging.toml']) {
      const declared = crons(file)
      for (const d of domains) {
        for (const expr of Object.keys(d.scheduledTasks ?? {})) {
          // A domain has no manifest for `pnpm provision` to read a new expression from.
          expect(declared.has(expr), `${d.id}: cron '${expr}' is not in ${file}`).toBe(true)
        }
      }
    }
  })
})

/** A job schema's literal `type`. */
const jobType = (job: { shape: { type: unknown } }) =>
  String((job.shape.type as { value: unknown }).value)

/** `[owner, value]` pairs whose value two units both claim. */
function shared<T>(pairs: Array<[string, T]>): string[] {
  const holders = new Map<T, Set<string>>()
  for (const [owner, value] of pairs) {
    const set = holders.get(value) ?? new Set()
    set.add(owner)
    holders.set(value, set)
  }
  return [...holders]
    .filter(([, owners]) => owners.size > 1)
    .map(([value, owners]) => `${String(value)}: ${[...owners].join(', ')}`)
}

describe('every unit’s namespaces, plugins and domains together', () => {
  it('has unique ids across plugins and domains', () => {
    expect(shared(serverUnits.map(u => [u.kind, u.id] as [string, string]))).toEqual([])
    const ids = serverUnits.map(u => u.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('namespaces every job type, event, agent key and prompt key with the unit id', () => {
    const issues: string[] = []
    for (const s of sharedUnits) {
      for (const job of s.jobs ?? []) {
        const type = jobType(job)
        if (!type.startsWith(`${s.id}.`)) issues.push(`${s.id}: job type '${type}'`)
      }
      for (const name of Object.keys(s.events ?? {})) {
        const problem = eventNameProblem(s.id, name)
        if (problem) issues.push(`${s.id}: event ${problem}`)
      }
      if (!serverUnits.some(u => u.id === s.id && u.kind === 'domain')) continue
      for (const key of s.agentKeys ?? []) {
        if (!key.startsWith(`${s.id}.`)) issues.push(`${s.id}: agent key '${key}'`)
      }
      for (const key of s.promptKeys ?? []) {
        if (!key.startsWith(`${s.id}-`)) issues.push(`${s.id}: prompt key '${key}'`)
      }
    }
    expect(issues).toEqual([])
  })

  it('mounts a domain’s routes under /api/<id> only', () => {
    const issues: string[] = []
    for (const u of serverUnits.filter(x => x.kind === 'domain')) {
      for (const [prefix] of u.mounts ?? []) {
        if (prefix !== `/api/${u.id}` && !prefix.startsWith(`/api/${u.id}/`)) {
          issues.push(`${u.id}: mount '${prefix}'`)
        }
      }
      for (const [prefix] of u.publicMounts ?? []) {
        if (prefix !== `/api/hooks/${u.id}` && !prefix.startsWith(`/api/hooks/${u.id}/`)) {
          issues.push(`${u.id}: public mount '${prefix}'`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  it('roots every query-key family of a domain at <id>:', () => {
    const issues: string[] = []
    for (const u of uiUnits.filter(x => x.kind === 'domain')) {
      for (const root of Object.keys(u.queryKeys ?? {})) {
        if (!root.startsWith(`${u.id}:`)) issues.push(`${u.id}: query-key root '${root}'`)
      }
    }
    expect(issues).toEqual([])
  })

  it('never lets two units claim one job type, event, mount, query-key root or agent key', () => {
    expect(
      shared(
        sharedUnits.flatMap(s => (s.jobs ?? []).map(j => [s.id, jobType(j)] as [string, string]))
      )
    ).toEqual([])
    expect(
      shared(
        sharedUnits.flatMap(s =>
          Object.keys(s.events ?? {}).map(e => [s.id, e] as [string, string])
        )
      )
    ).toEqual([])
    expect(
      shared(serverUnits.flatMap(u => (u.mounts ?? []).map(([p]) => [u.id, p] as [string, string])))
    ).toEqual([])
    expect(
      shared(
        uiUnits.flatMap(u => Object.keys(u.queryKeys ?? {}).map(r => [u.id, r] as [string, string]))
      )
    ).toEqual([])
    expect(
      shared(sharedUnits.flatMap(s => (s.agentKeys ?? []).map(k => [s.id, k] as [string, string])))
    ).toEqual([])
  })
})
