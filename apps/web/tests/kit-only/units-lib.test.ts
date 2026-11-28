/**
 * `scripts/lib/units.mjs` — the boundary check over plugins and domains — against fixture trees,
 * one fault each: an internal import across domains, an undeclared dependency, a cycle, direct
 * table use (a warning), id and table collisions between a plugin and a domain, the examples'
 * shared namespace, a plugin importing a domain and core importing one. The check over THIS
 * checkout is `tests/config/units.test.ts`.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appDomainIds,
  DOMAIN_ROOTS,
  dependencyCycles,
  incomingPluginFindings,
  KIT_ROOT_NAMES,
  readDomainDefinition,
  readUnits,
  type UnitFinding,
  unitFindings,
  unitIdProblem,
} from '../../../../scripts/lib/units.mjs'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A repository with `files` (repo-relative path → text). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'units-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

const appTs = (...ids: string[]) =>
  `${ids.map((id, i) => `import { d${i} } from './${id}'`).join('\n')}\nexport const APP_DOMAINS = [${ids.map((_, i) => `d${i}`).join(', ')}] as const\n`

const domain = (id: string, extra = '', imports = '') =>
  `${imports}\nimport { defineDomain } from '@/plugins/api'\nexport const d = defineDomain({ id: '${id}', shared: {} as never${extra} })\n`

const table = (exportName: string, name: string) =>
  `import { pgTable, text } from 'drizzle-orm/pg-core'\nexport const ${exportName} = pgTable('${name}', { id: text('id') })\n`

const fails = (f: UnitFinding[]) => f.filter(x => x.severity === 'fail').map(x => x.kind)

/** Two domains, `sales` depending on `hr`, each with one table and a public door. */
function twoDomains(
  salesImports: string,
  salesExtra = ", dependsOn: ['hr']"
): Record<string, string> {
  return {
    'apps/web/src/app.ts': appTs('hr', 'sales'),
    'apps/web/src/hr/index.ts': domain('hr'),
    'apps/web/src/hr/db/schema.ts': table('hrLeave', 'hr_leave'),
    'apps/web/src/hr/server/leave.ts': 'export const secret = 1\n',
    'apps/web/src/hr/public.ts':
      "export { hrLeave } from './db/schema'\nexport async function onLeave() { return [] }\n",
    'apps/web/src/sales/index.ts': domain('sales', salesExtra),
    'apps/web/src/sales/db/schema.ts': table('salesLeads', 'sales_leads'),
    'apps/web/src/sales/server/routes.ts': `${salesImports}\nexport {}\n`,
  }
}

describe('reading the app from source', () => {
  it('finds the domains app.ts imports, in order, and nothing for a copy without app.ts', () => {
    const root = repo({ 'apps/web/src/app.ts': appTs('hr', 'sales') })
    expect(appDomainIds(root)).toEqual(['hr', 'sales'])
    expect(appDomainIds(repo({}))).toEqual([])
  })

  it('reads dependsOn, tablePrefix and tables as literals, and names a non-literal', () => {
    const read = readDomainDefinition(
      "defineDomain({ id: 'x', dependsOn: ['a', 'b'], tablePrefix: 'legacy_', tables: ['t'] })"
    )
    expect(read).toMatchObject({ found: true, dependsOn: ['a', 'b'], tablePrefix: 'legacy_' })
    expect(read.tables).toEqual(['t'])
    const bad = readDomainDefinition("defineDomain({ id: 'x', dependsOn: DEPS })")
    expect(bad.problems.map(p => p.property)).toEqual(['dependsOn'])
  })
})

describe('imports between domains', () => {
  it('passes a call through the other domain’s public.ts along a declared edge', () => {
    const root = repo(twoDomains("import { onLeave } from '@/hr/public'"))
    expect(fails(unitFindings(root))).toEqual([])
  })

  it('fails an import of another domain’s internals', () => {
    const root = repo(twoDomains("import { secret } from '@/hr/server/leave'"))
    expect(fails(unitFindings(root))).toEqual(['internal-import'])
  })

  it('fails an import from a domain that dependsOn does not list', () => {
    const root = repo(twoDomains("import { onLeave } from '@/hr/public'", ''))
    const found = unitFindings(root)
    expect(fails(found)).toEqual(['undeclared-dependency'])
    expect(found[0]?.fix).toContain("add 'hr' to dependsOn")
  })

  it('fails a cycle in dependsOn', () => {
    const files = twoDomains("import { onLeave } from '@/hr/public'")
    files['apps/web/src/hr/index.ts'] = domain('hr', ", dependsOn: ['sales']")
    const found = unitFindings(repo(files))
    expect(fails(found)).toEqual(['cycle'])
    expect(found[0]?.problem).toContain('hr → sales → hr')
    expect(
      dependencyCycles([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['c'] },
        { id: 'c', dependsOn: ['a'] },
      ])
    ).toEqual([['a', 'b', 'c']])
  })

  it('fails dependsOn naming itself, a stranger or a plugin', () => {
    const files = twoDomains('', ", dependsOn: ['sales', 'nobody', 'orders']")
    files['apps/web/src/plugins/orders/index.ts'] = 'export const ordersServer = {}\n'
    expect(fails(unitFindings(repo(files)))).toEqual(['depends-on', 'depends-on', 'depends-on'])
  })

  it('warns, and only warns, on another domain’s table objects — imported or re-exported', () => {
    const direct = unitFindings(repo(twoDomains("import { hrLeave } from '@/hr/db/schema'")))
    expect(fails(direct)).toEqual([])
    expect(direct.map(f => [f.severity, f.kind])).toEqual([['warn', 'table-use']])
    expect(direct[0]?.problem).toContain('hr_leave')
    expect(direct[0]?.fix).toContain("'@/hr/public'")
    const throughDoor = unitFindings(repo(twoDomains("import { hrLeave } from '@/hr/public'")))
    expect(throughDoor.map(f => [f.severity, f.kind])).toEqual([['warn', 'table-use']])
  })

  it('fails a domain reaching the kit outside the declared entries', () => {
    const root = repo(twoDomains("import { getDb } from '@/db/client'"))
    expect(fails(unitFindings(root))).toEqual(['kit-import'])
  })
})

describe('plugins and domains together', () => {
  it('fails a plugin and a domain sharing an id', () => {
    const files = twoDomains('')
    files['apps/web/src/plugins/hr/index.ts'] = 'export const hrServer = {}\n'
    expect(fails(unitFindings(repo(files)))).toContain('id-collision')
  })

  it('fails a plugin table inside a domain’s namespace, and passes an exact tables list', () => {
    const files = twoDomains('')
    files['apps/web/src/plugins/hr-tools/db/schema.ts'] = table('tools', 'hr_tools')
    expect(fails(unitFindings(repo(files)))).toEqual(['table-namespace-collision'])
    files['apps/web/src/hr/index.ts'] = domain('hr', ", tables: ['hr_leave']")
    expect(fails(unitFindings(repo(files)))).toEqual([])
  })

  it('fails two units defining one table name — examples included', () => {
    const files = twoDomains('')
    files['apps/web/src/sales/db/more.ts'] = table('dup', 'hr_leave')
    expect(fails(unitFindings(repo(files)))).toEqual(
      expect.arrayContaining(['table-collision', 'table-namespace'])
    )
  })

  it('lets the kit’s examples share the example_ namespace, and nobody else', () => {
    const files = {
      'apps/web/src/app.ts': appTs('example-hr'),
      'apps/web/src/example-hr/index.ts': domain('example-hr'),
      'apps/web/src/example-hr/db/schema.ts': table('leave', 'example_leave'),
      'apps/web/src/plugins/example-feature/db/schema.ts': table('notes', 'example_notes'),
    }
    const root = repo(files)
    expect(fails(unitFindings(root))).toEqual(['table-namespace-collision'])
    const manifest = {
      kit: { repo: 'https://github.com/o/kit.git' },
      surfaces: [
        { id: 'example-hr', kind: 'example' },
        { id: 'example-feature', kind: 'plugin', source: { repo: 'https://github.com/o/kit' } },
      ],
    }
    expect(readUnits(root, { manifest }).map(u => u.example)).toEqual([true, true])
    expect(fails(unitFindings(root, { manifest }))).toEqual([])
  })

  it('fails a domain table outside its own namespace', () => {
    const files = twoDomains('')
    files['apps/web/src/sales/db/schema.ts'] = table('leads', 'leads')
    expect(fails(unitFindings(repo(files)))).toEqual(['table-namespace'])
  })

  it('fails a plugin importing an app domain, and kit core importing one', () => {
    const files = twoDomains('')
    files['apps/web/src/plugins/orders/index.ts'] = "import { onLeave } from '@/hr/public'\n"
    files['apps/web/src/api/routes/thing.ts'] = "import { onLeave } from '../../hr/public'\n"
    expect(fails(unitFindings(repo(files))).sort()).toEqual([
      'core-imports-domain',
      'plugin-imports-domain',
    ])
  })

  it('refuses a plugin install whose id or tables a domain already holds', () => {
    const root = repo(twoDomains(''))
    expect(
      incomingPluginFindings(root, { id: 'hr', schema: { tables: [] } }).map(f => f.kind)
    ).toEqual(['id-collision'])
    expect(
      incomingPluginFindings(root, { id: 'leave', schema: { tables: ['hr_absences'] } }).map(
        f => f.kind
      )
    ).toEqual(['table-namespace-collision'])
    expect(
      incomingPluginFindings(root, { id: 'orders', schema: { tables: ['orders_x'] } })
    ).toEqual([])
  })
})

describe('ids', () => {
  it('reserves core, kit and app, and the names of the kit’s own modules', () => {
    for (const id of ['core', 'kit', 'app']) expect(unitIdProblem(id)).toContain('reserved')
    expect(unitIdProblem('api')).toContain('kit module')
    expect(unitIdProblem('units')).toContain('kit module')
    expect(unitIdProblem('expenses')).toBeNull()
    expect(unitIdProblem('Sales')).not.toBeNull()
  })
})

describe('the kit’s own tree', () => {
  it('names every top-level module of a domain root in KIT_ROOT_NAMES', () => {
    const REPO_ROOT = path.resolve(__dirname, '../../../..')
    const domains = new Set(appDomainIds(REPO_ROOT))
    const stray: string[] = []
    for (const root of DOMAIN_ROOTS) {
      for (const entry of readdirSync(path.join(REPO_ROOT, root))) {
        const stem = entry.replace(/\.(tsx?|mts|d\.ts)$/, '')
        if (stem === 'app' || domains.has(stem) || KIT_ROOT_NAMES.includes(stem)) continue
        stray.push(`${root}${entry}`)
      }
    }
    expect(stray).toEqual([])
  })
})
