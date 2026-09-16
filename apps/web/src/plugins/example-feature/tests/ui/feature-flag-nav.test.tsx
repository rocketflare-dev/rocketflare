/**
 * The nav side of a feature flag (D30, D31), driven through the REAL `useNavGuard`.
 *
 * It lives inside the plugin because the item it looks for is the plugin's: the flag, the nav
 * entry, the route and the page all arrive and leave together, and a test that outlived them would
 * be a false failure the day somebody runs `pnpm plugin remove example-feature`. What it exercises
 * is the KIT's guard, through `SideNav`, with this plugin's group spliced in by `composeNav` — so
 * it is also the proof that a plugin's nav item obeys exactly the rules a kit one does.
 *
 * Driving the real hook is the whole point. An app on this kit wrote this test against a
 * re-implementation of the guard logic, and the re-implementation is precisely what hid the bug it
 * was meant to catch: the server gate read the CASL ability, where a global admin's `manage all`
 * satisfies every `Feature:` subject, so unreleased routes were open to platform staff. Anything
 * here that re-derives what the hook does is worthless.
 *
 * So: every assertion runs for an OWNER (who holds every tenant permission) and for a GLOBAL ADMIN
 * (who holds `manage all`). Neither may see a surface whose flag is off.
 */

import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SideNav from '@/ui/components/SideNav'
import { featureGuard } from '@/ui/lib/feature-guards'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  rulesFor,
} from '../../../../../tests/ui/helpers/renderWithProviders'
import { EXAMPLE_FEATURE_GUARD } from '../../ui'

const KEY = EXAMPLE_FEATURE_FLAG

/** An owner, or a global admin who is also an owner — both hold every permission in this tenant. */
function session(opts: { globalAdmin?: boolean; features?: string[] } = {}) {
  const user = makeUser({ isGlobalAdmin: opts.globalAdmin ?? false })
  return makeSession({
    user,
    permissions: rulesFor('owner', user.isGlobalAdmin, opts.features ?? []),
    features: opts.features ?? [],
  })
}

const CASES = [
  ['an owner', false],
  ['a global admin', true],
] as const

describe('a feature that is off hides its nav item', () => {
  for (const [who, globalAdmin] of CASES) {
    it(`is hidden from ${who}`, async () => {
      renderWithProviders(<SideNav />, { session: session({ globalAdmin }) })
      expect(await screen.findByText('Home')).toBeInTheDocument()
      expect(screen.queryByText('Example feature')).not.toBeInTheDocument()
    })

    it(`is shown to ${who} once the flag is on`, async () => {
      renderWithProviders(<SideNav />, { session: session({ globalAdmin, features: [KEY] }) })
      expect(await screen.findByText('Example feature')).toBeInTheDocument()
    })
  }

  /**
   * The assertion that pins the rule. The global admin's packed rules DO contain
   * `access Feature:*` (via `manage all`), so an ability-based guard would answer "show it". The
   * flag must still win.
   */
  it('stays hidden from a global admin whose ability covers every Feature subject', async () => {
    const admin = session({ globalAdmin: true })
    const abilityWouldAllow = JSON.stringify(admin.permissions).includes('manage')
    expect(abilityWouldAllow, 'precondition: the admin holds a wildcard rule').toBe(true)

    renderWithProviders(<SideNav />, { session: admin })
    expect(await screen.findByText('Home')).toBeInTheDocument()
    expect(screen.queryByText('Example feature')).not.toBeInTheDocument()
  })
})

describe('featureGuard composes the flag with a permission', () => {
  it('is a list, so both have to pass', () => {
    expect(featureGuard(EXAMPLE_FEATURE_GUARD, { action: 'read', subject: 'Document' })).toEqual([
      EXAMPLE_FEATURE_GUARD,
      { action: 'read', subject: 'Document' },
    ])
  })
})
