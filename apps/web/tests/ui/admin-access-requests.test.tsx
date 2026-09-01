import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessRequests from '@/ui/pages/admin/AccessRequests'
import {
  IDS,
  makeSession,
  makeUser,
  paged,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const REQ_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const request = {
  id: REQ_ID,
  email: 'newbie@example.test',
  userId: null,
  requestedTenantId: null,
  requestedTenantName: null,
  message: 'I work with Olive',
  status: 'pending',
  decidedByUserId: null,
  decidedAt: null,
  createdAt: '2025-06-01T00:00:00Z',
}
const org = (id: string, name: string, slug: string) => ({
  id,
  name,
  slug,
  status: 'active',
  memberCount: 3,
  seedDataCreated: false,
  lastAccessedAt: null,
  createdAt: '2025-01-01T00:00:00Z',
})

function renderAs(tenancyMode: 'multi' | 'single') {
  const fetchMock = stubFetch({
    '/api/admin/access-requests': paged([request]),
    '/api/admin/tenants': paged([
      org(IDS.tenant, 'Acme', 'acme'),
      org(IDS.otherTenant, 'Beta', 'beta'),
    ]),
    [`POST /api/admin/access-requests/${REQ_ID}/decide`]: { ok: true },
  })
  renderWithProviders(<AccessRequests />, {
    session: makeSession({ user: makeUser({ isGlobalAdmin: true }), tenancyMode }),
  })
  return fetchMock
}

describe('Admin → Access requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('multi mode: approve offers "new organisation" and posts the nested decide body', async () => {
    const fetchMock = renderAs('multi')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(screen.getByText('I work with Olive', { exact: false })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'New organisation' }))
    fireEvent.change(screen.getByLabelText('Organisation name'), {
      target: { value: 'Newbie Labs' },
    })
    fireEvent.submit(document.getElementById('approve-form') as HTMLFormElement)

    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/admin/access-requests/${REQ_ID}/decide`)).toEqual({
        decision: 'approve',
        approve: { mode: 'new_org', name: 'Newbie Labs', slug: 'newbie-labs' },
      })
    )
  })

  it('multi mode: join posts tenantId + role from the picker', async () => {
    const fetchMock = renderAs('multi')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Beta (@beta)' })).toBeInTheDocument()
    )
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: IDS.otherTenant } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    fireEvent.submit(document.getElementById('approve-form') as HTMLFormElement)

    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/admin/access-requests/${REQ_ID}/decide`)).toEqual({
        decision: 'approve',
        approve: { mode: 'join', tenantId: IDS.otherTenant, role: 'admin' },
      })
    )
  })

  it('single mode: the new_org branch is hidden (D25)', async () => {
    renderAs('single')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(screen.queryByRole('tab', { name: 'New organisation' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Organisation name')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Organisation')).toBeInTheDocument()
  })

  it('reject posts { decision: reject, reason }', async () => {
    const fetchMock = renderAs('multi')
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Unknown requester' } })
    fireEvent.submit(document.getElementById('reject-form') as HTMLFormElement)
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/admin/access-requests/${REQ_ID}/decide`)).toEqual({
        decision: 'reject',
        reason: 'Unknown requester',
      })
    )
  })
})
