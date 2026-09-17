/**
 * The reference plugin's own contracts (D31) — pure, no database, no app.
 *
 * What it pins is the half of a plugin that the HOST cannot check for it: that every key this
 * plugin declares carries its id, that its declarations actually reach the kit's merged registries
 * once the barrel line exists, and that its request contracts refuse the bodies its routes rely on
 * being refused. `tests/config/plugins.test.ts` proves the structural rules for every plugin; this
 * proves this one's.
 */

import { FEATURE_FLAGS, FEATURE_KEYS } from '@rocketflare/shared/features'
import type { CoreJobType, JobOf, JobType } from '@rocketflare/shared/jobs'
import { JOB_TYPES, jobInputSchema } from '@rocketflare/shared/jobs'
import type { Subjects } from '@rocketflare/shared/permissions'
import { pluginNamespace } from '@rocketflare/shared/plugins'
import {
  createExampleNoteRequestSchema,
  EXAMPLE_FEATURE_FLAG,
  EXAMPLE_FEATURE_ID,
  EXAMPLE_NOTE_BODY_MAX,
  EXAMPLE_NOTE_SUBJECT,
  EXAMPLE_NOTE_TITLE_MAX,
  EXAMPLE_PING_JOB,
  exampleFeatureShared,
  updateExampleNoteRequestSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { exampleFeatureServer } from '../..'
import { EXAMPLE_NOTES_ENTITY } from '../../shared'
import { exampleFeatureUi } from '../../ui'

describe('the plugin namespaces everything it keys', () => {
  it('names its job type, its API prefix and its query-key root after its id', () => {
    expect(EXAMPLE_PING_JOB.startsWith(`${EXAMPLE_FEATURE_ID}.`)).toBe(true)
    expect(EXAMPLE_NOTES_ENTITY.startsWith(pluginNamespace(EXAMPLE_FEATURE_ID))).toBe(true)
    expect(exampleFeatureServer.mounts[0][0]).toBe(`/api/${EXAMPLE_FEATURE_ID}`)
    // The nudge's `entity` and the query-key family root are the SAME string — the kit's convention,
    // and what makes the plugin's realtime wiring zero lines of socket code.
    expect(Object.keys(exampleFeatureUi.queryKeys)).toEqual([EXAMPLE_NOTES_ENTITY])
  })

  it('declares exactly the subject its grants and routes use', () => {
    expect(exampleFeatureShared.subjects).toEqual([EXAMPLE_NOTE_SUBJECT])
  })
})

describe('it reaches the kit’s merged registries', () => {
  it('contributes its job variant to the one the consumer parses', () => {
    expect(JOB_TYPES).toContain(EXAMPLE_PING_JOB)
    const parsed = jobInputSchema.safeParse({
      type: EXAMPLE_PING_JOB,
      payload: { tenantId: '11111111-1111-4111-8111-111111111111' },
    })
    expect(parsed.success).toBe(true)
    // …and the payload is still validated, rather than waved through as an unknown type.
    expect(jobInputSchema.safeParse({ type: EXAMPLE_PING_JOB, payload: {} }).success).toBe(false)
  })

  it('contributes its flag to the registry the admin surface and the session read', () => {
    expect(FEATURE_KEYS).toContain(EXAMPLE_FEATURE_FLAG)
    expect(FEATURE_FLAGS[EXAMPLE_FEATURE_FLAG]).toMatchObject({
      defaultState: 'off',
      environmentGated: false,
    })
  })

  it('covers every job type it declared with a handler', () => {
    expect(Object.keys(exampleFeatureServer.jobHandlers)).toEqual([EXAMPLE_PING_JOB])
  })
})

describe('the note contracts', () => {
  it('refuse an empty or oversized title, and default the body', () => {
    expect(createExampleNoteRequestSchema.safeParse({ title: '  ' }).success).toBe(false)
    expect(
      createExampleNoteRequestSchema.safeParse({ title: 'x'.repeat(EXAMPLE_NOTE_TITLE_MAX + 1) })
        .success
    ).toBe(false)
    expect(
      createExampleNoteRequestSchema.safeParse({
        title: 'x',
        body: 'y'.repeat(EXAMPLE_NOTE_BODY_MAX + 1),
      }).success
    ).toBe(false)
    expect(createExampleNoteRequestSchema.parse({ title: 'x' })).toEqual({ title: 'x', body: '' })
  })

  it('refuse an empty PATCH, so a no-op write can never look like a success', () => {
    expect(updateExampleNoteRequestSchema.safeParse({}).success).toBe(false)
    expect(updateExampleNoteRequestSchema.safeParse({ title: 'x' }).success).toBe(true)
  })
})

/**
 * What this plugin contributes to the kit's closed sets, at the TYPE level.
 *
 * These belong here rather than in `tests/config/plugins.test.ts` because they name
 * `example-feature`, and `expectTypeOf` compiles to nothing — so a host assertion naming this
 * plugin is a `pnpm typecheck` that fails the moment somebody uninstalls it, which is the one thing
 * this plugin exists for. Here they are deleted along with the directory that makes them true.
 * The host keeps the plugin-agnostic half (core is a subset of the installed union, never wider).
 */
describe('what this plugin adds to the kit’s closed sets', () => {
  it('widens JobType by its own job, with a narrowed payload', () => {
    // `toMatchTypeOf`, not `toEqualTypeOf`: the union is the KIT's plus every installed plugin's,
    // so pinning it whole would make this plugin's test fail whenever a SECOND plugin is
    // installed. What this plugin can honestly assert is that the kit's types survived and that
    // its own arrived — the rest of the union belongs to whoever declared it.
    expectTypeOf<CoreJobType>().toMatchTypeOf<JobType>()
    expectTypeOf<'example-feature.ping'>().toMatchTypeOf<JobType>()
    expectTypeOf<JobOf<'example-feature.ping'>['payload']['tenantId']>().toEqualTypeOf<string>()
  })

  it('unions its CASL subject in beside the kit’s', () => {
    expectTypeOf<'ExampleNote'>().toMatchTypeOf<Subjects>()
  })
})
