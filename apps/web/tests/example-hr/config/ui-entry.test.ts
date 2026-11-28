/**
 * A domain's UI entry loads when it is the FIRST module a file imports, as a domain's own UI or
 * config test imports it. Its import of the UI wiring reaches `units/ui.ts`, which lists every
 * domain's UI entry, so `defineDomainUi` has to be bound before that walk reaches a second domain.
 */
import { describe, expect, it } from 'vitest'
import { exampleHrUi } from '../../../src/example-hr/ui'

describe("example-hr's UI entry", () => {
  it('loads when it is the first module imported', () => {
    expect(exampleHrUi.kind).toBe('domain')
    expect(exampleHrUi.id).toBe('example-hr')
  })
})
