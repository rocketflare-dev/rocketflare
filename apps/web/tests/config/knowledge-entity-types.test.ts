/**
 * The knowledge entity type registry (D43): the composition rules `knowledgeEntityTypes()`
 * enforces, each over a FIXTURE (a rule that runs only when a plugin happens to be installed proves
 * nothing), then the installed set itself, then the shared contract's pure helpers.
 */
import {
  ENTITY_TYPE_RE,
  entityFactsJsonSchema,
  entityTypeSchema,
  FACT_STATES,
  OPEN_REVIEW_FACT_STATES,
  SOURCE_TRUST,
  trustRank,
} from '@rocketflare/shared/ai/knowledge-facts'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { APP_ENTITY_TYPES } from '@/api/services/knowledge/entity-types'
import {
  composeEntityTypes,
  type EntityTypeSource,
  entityTypeIssues,
  knowledgeEntityTypes,
} from '@/api/services/knowledge/registry'
import { registrationTableIssues, resolverFor } from '@/api/services/knowledge/resolve'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { serverUnits } from '@/units/server'

const widgets = pgTable('fixture_widgets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  nicknames: text('nicknames').array(),
})
const gadgets = pgTable('fixture_gadgets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
})
const untenanted = pgTable('fixture_untenanted', {
  id: uuid('id').primaryKey(),
  name: text('name'),
})

const facts = z.object({ contact_name: z.string().describe('Who to call') })

function reg(over: Partial<EntityTypeRegistration> & { type: string }): EntityTypeRegistration {
  return { label: 'Thing', facts, ...over }
}

function issuesFor(owner: string | null, ...types: EntityTypeRegistration[]): string[] {
  return entityTypeIssues([{ owner, types }])
}

describe('entity type namespacing', () => {
  it('accepts a plugin type under its own id and a bare app type', () => {
    expect(issuesFor('acme-crm', reg({ type: 'acme-crm.customer' }))).toEqual([])
    expect(issuesFor(null, reg({ type: 'purchase_order' }))).toEqual([])
  })

  it("refuses a plugin type outside its id, or under another plugin's", () => {
    expect(issuesFor('acme-crm', reg({ type: 'customer' })).join()).toMatch(
      /must start with "acme-crm\."/
    )
    expect(issuesFor('acme-crm', reg({ type: 'acme.customer' })).join()).toMatch(/must start with/)
    expect(issuesFor('acme-crm', reg({ type: 'other.customer' })).join()).toMatch(/must start with/)
  })

  it('refuses an app type with a dot — a dot means a plugin owns it', () => {
    expect(issuesFor(null, reg({ type: 'kit.customer' })).join()).toMatch(
      /an app type is a bare name/
    )
  })

  it('refuses a malformed type name', () => {
    for (const bad of ['Customer', 'customer-name', '1customer', 'a..b', '']) {
      expect(ENTITY_TYPE_RE.test(bad), bad).toBe(false)
      expect(issuesFor(null, reg({ type: bad })).length, bad).toBeGreaterThan(0)
    }
  })
})

describe('entity type duplicates', () => {
  it('refuses one type registered twice, within one owner or across two', () => {
    const twice = issuesFor(null, reg({ type: 'customer' }), reg({ type: 'customer' }))
    expect(twice.join()).toMatch(/registered by both the app and the app/)
    const sources: EntityTypeSource[] = [
      { owner: 'acme', types: [reg({ type: 'acme.customer' })] },
      { owner: 'acme', types: [reg({ type: 'acme.customer' })] },
    ]
    expect(entityTypeIssues(sources).join()).toMatch(
      /registered by both plugin acme and plugin acme/
    )
    expect(() => composeEntityTypes(sources)).toThrow(/do not compose/)
  })
})

describe('fact keys and value schemas', () => {
  it('refuses a fact key that is not snake_case', () => {
    for (const key of ['contactName', 'Contact', 'contact-name', '_x', 'x__y']) {
      const issues = issuesFor(
        null,
        reg({ type: 'customer', facts: z.object({ [key]: z.string() }) })
      )
      expect(issues.join(), key).toMatch(/not snake_case/)
    }
  })

  it('refuses an empty facts object, and one that is not a zod object', () => {
    expect(issuesFor(null, reg({ type: 'customer', facts: z.object({}) })).join()).toMatch(
      /declares no key/
    )
    const notObject = reg({ type: 'customer', facts: z.string() as unknown as typeof facts })
    expect(issuesFor(null, notObject).join()).toMatch(/must be a zod object/)
  })

  it('refuses a value schema that cannot render as JSON schema (the extraction prompt needs it)', () => {
    const dated = reg({ type: 'customer', facts: z.object({ renewal_date: z.date() }) })
    expect(issuesFor(null, dated).join()).toMatch(/cannot be rendered as JSON schema/)
    const iso = reg({ type: 'customer', facts: z.object({ renewal_date: z.iso.date() }) })
    expect(issuesFor(null, iso)).toEqual([])
  })

  it('renders each key with its description', () => {
    const json = entityFactsJsonSchema(reg({ type: 'customer' })) as {
      properties: Record<string, { description?: string }>
    }
    expect(json.properties.contact_name?.description).toBe('Who to call')
  })
})

describe('the table half', () => {
  it('accepts a type with no table at all (staging only), and gives it no resolver', () => {
    const staging = reg({ type: 'supplier' })
    expect(issuesFor(null, staging)).toEqual([])
    expect(resolverFor(staging)).toBeNull()
  })

  it('accepts columns of the table, text and text[] alike', () => {
    const ok = reg({
      type: 'widget',
      table: widgets,
      labelColumn: widgets.name,
      aliasColumns: [widgets.nicknames],
    })
    expect(registrationTableIssues(ok)).toEqual([])
    expect(resolverFor(ok)).toBeTypeOf('function')
  })

  it("refuses another table's column, a table without tenantId, or no labelColumn", () => {
    const foreign = reg({ type: 'widget', table: widgets, labelColumn: gadgets.title })
    expect(registrationTableIssues(foreign).join()).toMatch(/not a column of fixture_widgets/)
    const noTenant = reg({ type: 'widget', table: untenanted, labelColumn: untenanted.name })
    expect(registrationTableIssues(noTenant).join()).toMatch(/has no tenantId column/)
    const noLabel = reg({ type: 'widget', table: widgets })
    expect(registrationTableIssues(noLabel).join()).toMatch(/labelColumn is required/)
    // With its own resolver it needs no label column.
    expect(registrationTableIssues({ ...noLabel, resolve: async () => [] })).toEqual([])
  })

  it('refuses columns named without a table', () => {
    const loose = reg({ type: 'widget', labelColumn: widgets.name })
    expect(registrationTableIssues(loose).join()).toMatch(/the type has no table/)
  })
})

describe('the installed set', () => {
  it('composes: the app types plus every unit type (plugins, then domains), each under its id', () => {
    const all = knowledgeEntityTypes()
    const expected = [
      ...APP_ENTITY_TYPES,
      ...serverUnits.flatMap(u => u.knowledgeEntityTypes ?? []),
    ].map(t => t.type)
    expect(all.map(t => t.type)).toEqual(expected)
    for (const unit of serverUnits) {
      for (const t of unit.knowledgeEntityTypes ?? []) {
        expect(t.type.startsWith(`${unit.id}.`)).toBe(true)
        expect(entityTypeSchema.safeParse(t).success).toBe(true)
      }
    }
  })
})

describe('the shared closed sets', () => {
  it('orders trust person > upload > agent > integration', () => {
    expect(SOURCE_TRUST).toEqual(['person', 'upload', 'agent', 'integration'])
    const ranks = SOURCE_TRUST.map(trustRank)
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks)
    expect(trustRank('person')).toBeGreaterThan(trustRank('integration'))
  })

  it('open review states are a subset of the fact states', () => {
    expect(FACT_STATES).toEqual([
      'accepted',
      'unconfirmed',
      'conflicting',
      'superseded',
      'rejected',
    ])
    for (const s of OPEN_REVIEW_FACT_STATES) expect(FACT_STATES).toContain(s)
  })
})
