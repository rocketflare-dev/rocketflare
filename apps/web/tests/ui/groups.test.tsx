/**
 * Settings → Groups and the visibility picker (D29). Two things worth a test: the admin flow that
 * creates a type and a group, and the warning `AccessPicker` shows for an EMPTY selection — the
 * state that is legal, meaningful ("only me and admins") and easy to reach by accident.
 */
import type { GroupRef } from '@rocketflare/shared/groups'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { AccessPicker } from '@/ui/components/shared'
import GroupsSettings from '@/ui/pages/settings/Groups'
import {
  IDS,
  makeSession,
  makeTenant,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const TYPE_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const now = '2025-06-01T00:00:00Z'

const type = (overrides: Record<string, unknown> = {}) => ({
  id: TYPE_ID,
  tenantId: IDS.tenant,
  name: 'Department',
  description: null,
  groupCount: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const group = (overrides: Record<string, unknown> = {}) => ({
  id: GROUP_ID,
  tenantId: IDS.tenant,
  groupTypeId: TYPE_ID,
  typeName: 'Department',
  name: 'Finance',
  description: null,
  memberCount: 2,
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

function mount(routes: RouteTable = {}, role: 'owner' | 'member' = 'owner') {
  const fetchMock = stubFetch({
    '/api/groups/types': { items: [type()] },
    '/api/groups': { items: [group()] },
    ...routes,
  })
  renderWithProviders(<GroupsSettings />, {
    session: makeSession({ tenant: makeTenant({ role }) }),
  })
  return fetchMock
}

describe('Settings → Groups', () => {
  it('lists types with their group count, and the selected type’s groups', async () => {
    mount()
    expect(await screen.findByRole('button', { name: /Department/ })).toBeInTheDocument()
    expect(await screen.findByText('Finance')).toBeInTheDocument()
    // The member count comes from the list query, never from a call per group.
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('creates a group type and selects it', async () => {
    const fetchMock = mount({
      'POST /api/groups/types': type({ id: TYPE_ID, name: 'Region', groupCount: 0 }),
    })
    fireEvent.change(await screen.findByLabelText('New group type'), {
      target: { value: 'Region' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0] as HTMLElement)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/api/groups/types') && (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  it('creates a group under the selected type', async () => {
    const fetchMock = mount({ 'POST /api/groups': group({ name: 'Operations' }) })
    fireEvent.change(await screen.findByLabelText('New group'), {
      target: { value: 'Operations' },
    })
    // The second "Add" is the groups panel's; the first belongs to the types panel.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1] as HTMLElement)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/api/groups') && (init as RequestInit)?.method === 'POST'
      )
      expect(JSON.parse(String((call?.[1] as RequestInit)?.body))).toMatchObject({
        groupTypeId: TYPE_ID,
        name: 'Operations',
      })
    })
  })

  it('quotes the 409 counts before letting an admin delete a group that still grants access', async () => {
    mount({
      'DELETE /api/groups/22222222-2222-4222-8222-222222222222': new Response(
        JSON.stringify({
          error: 'in use',
          statusCode: 409,
          code: 'group_in_use',
          details: { documents: 3, dashboards: 1 },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      ),
    })
    fireEvent.click(await screen.findByLabelText('Delete Finance'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/3 document\(s\) and 1 dashboard\(s\)/)).toBeInTheDocument()
    // And it says which way the change goes — narrower, never wider.
    expect(screen.getByText(/owner and to administrators only/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeInTheDocument()
  })
})

describe('AccessPicker', () => {
  const available: GroupRef[] = [
    { id: 'g-1', name: 'Finance', typeName: 'Department' },
    { id: 'g-2', name: 'EMEA', typeName: 'Region' },
  ]

  function Harness() {
    const [value, setValue] = useState<{
      visibility: 'tenant' | 'groups'
      groupIds: string[]
    }>({ visibility: 'tenant', groupIds: [] })
    return (
      <AccessPicker
        visibility={value.visibility}
        groupIds={value.groupIds}
        available={available}
        tenantName="Acme"
        onChange={setValue}
      />
    )
  }

  it('warns that an empty selection means only you and admins — and does not block it', () => {
    renderWithProviders(<Harness />, { session: makeSession() })
    fireEvent.click(screen.getByRole('radio', { name: /Only these groups/ }))
    expect(screen.getByRole('status')).toHaveTextContent(
      /only you and administrators will see this/i
    )
  })

  it('groups the chips by type and toggles one on', () => {
    renderWithProviders(<Harness />, { session: makeSession() })
    fireEvent.click(screen.getByRole('radio', { name: /Only these groups/ }))
    expect(screen.getByText('Department')).toBeInTheDocument()
    expect(screen.getByText('Region')).toBeInTheDocument()
    const finance = screen.getByRole('button', { name: 'Finance' })
    expect(finance).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(finance)
    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says so when a member belongs to no groups at all', () => {
    renderWithProviders(
      <AccessPicker
        visibility="groups"
        groupIds={[]}
        available={[]}
        onChange={() => {}}
        tenantName="Acme"
      />,
      { session: makeSession() }
    )
    expect(screen.getByText(/not in any groups/i)).toBeInTheDocument()
  })
})
