import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type NavGuard, useNavGuard } from '@/ui/hooks/useNavGuard'
import {
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
} from './helpers/renderWithProviders'

const GUARDS: Record<string, NavGuard | undefined> = {
  none: undefined,
  admin: 'admin',
  globalAdmin: 'globalAdmin',
  manageTenant: { action: 'manage', subject: 'Tenant' },
  manageMembers: { action: 'manage', subject: 'TenantMember' },
  readKeys: { action: 'read', subject: 'ApiKey' },
  feature: { action: 'access', subject: 'Feature:analytics' },
}

function Probe() {
  const canAccess = useNavGuard()
  return (
    <ul>
      {Object.entries(GUARDS).map(([name, guard]) => (
        <li key={name} data-testid={name}>
          {String(canAccess(guard))}
        </li>
      ))}
    </ul>
  )
}

async function expectGuards(expected: Record<string, boolean>) {
  await waitFor(() => expect(screen.getByTestId('none')).toHaveTextContent('true'))
  for (const [name, value] of Object.entries(expected)) {
    expect(screen.getByTestId(name), name).toHaveTextContent(String(value))
  }
}

describe('useNavGuard with a real ability unpacked from the session rules', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('member: nothing but reads', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
    })
    await expectGuards({
      admin: false,
      globalAdmin: false,
      manageTenant: false,
      manageMembers: false,
      readKeys: true,
      feature: false,
    })
  })

  it('admin: manages members, not the tenant', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ tenant: makeTenant({ role: 'admin' }) }),
    })
    await expectGuards({
      admin: true,
      globalAdmin: false,
      manageTenant: false,
      manageMembers: true,
    })
  })

  it('owner: manages the tenant; feature flags come from `features`', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ tenant: makeTenant({ role: 'owner' }), features: ['analytics'] }),
    })
    await expectGuards({ admin: true, globalAdmin: false, manageTenant: true, feature: false })
  })

  it('support: admin-level in the org, still not a global admin flag', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ tenant: makeTenant({ role: 'support' }) }),
    })
    await expectGuards({ admin: true, globalAdmin: false, manageTenant: true, feature: true })
  })

  it('global admin: everything, even as a plain member of this org', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({
        user: makeUser({ isGlobalAdmin: true }),
        tenant: makeTenant({ role: 'member' }),
      }),
    })
    await expectGuards({ admin: true, globalAdmin: true, manageTenant: true, manageMembers: true })
  })

  it('global admin with no organisation: only the admin area (and unguarded items)', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }), tenant: null, tenants: [] }),
    })
    await expectGuards({
      admin: false,
      globalAdmin: true,
      manageTenant: false,
      manageMembers: false,
      readKeys: false,
      feature: false,
    })
  })

  it('logged out: only unguarded items', async () => {
    renderWithProviders(<Probe />, { session: null })
    await expectGuards({ admin: false, globalAdmin: false, manageTenant: false, readKeys: false })
  })
})
