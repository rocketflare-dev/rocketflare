// `IfCan` / `IfCannot` follow the session's rules; outside an `AbilityProvider` they deny.
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IfCan, IfCannot } from '@/ui/components/permissions'
import { makeSession, makeTenant, renderWithProviders } from './helpers/renderWithProviders'

function Gates() {
  return (
    <>
      <IfCan action="manage" subject="TenantMember" fallback={<p>members are read-only</p>}>
        <button type="button">Invite</button>
      </IfCan>
      <IfCannot action="manage" subject="TenantMember">
        <p>ask an admin</p>
      </IfCannot>
    </>
  )
}

describe('permission gates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('an admin sees the gated control', async () => {
    renderWithProviders(<Gates />, {
      session: makeSession({ tenant: makeTenant({ role: 'admin' }) }),
    })
    expect(await screen.findByRole('button', { name: 'Invite' })).toBeInTheDocument()
    expect(screen.queryByText('ask an admin')).not.toBeInTheDocument()
  })

  it('a member sees the fallback and the IfCannot hint instead', async () => {
    renderWithProviders(<Gates />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
    })
    expect(await screen.findByText('members are read-only')).toBeInTheDocument()
    expect(screen.getByText('ask an admin')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
  })

  it('outside an AbilityProvider every gate denies', () => {
    render(<Gates />)
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
    expect(screen.getByText('members are read-only')).toBeInTheDocument()
    expect(screen.getByText('ask an admin')).toBeInTheDocument()
  })
})
