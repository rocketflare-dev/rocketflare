import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEmailList } from '@/ui/pages/settings/InviteModal'
import People from '@/ui/pages/settings/People'
import {
  IDS,
  makeSession,
  makeTenant,
  makeUser,
  paged,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const ADMIN_ID = '44444444-4444-4444-8444-444444444444'
const MEMBER_ID = '55555555-5555-4555-8555-555555555555'
const now = '2025-06-01T00:00:00Z'
const member = (userId: string, name: string, role: string) => ({
  userId,
  email: `${name.toLowerCase()}@example.test`,
  name,
  avatarUrl: null,
  role,
  joinedAt: now,
  lastLoginAt: now,
  invitedByUserId: null,
})
const MEMBERS = paged([
  member(IDS.user, 'Olive', 'owner'),
  member(ADMIN_ID, 'Adam', 'admin'),
  member(MEMBER_ID, 'Mia', 'member'),
])

function renderAs(role: 'owner' | 'admin' | 'member', self = IDS.user) {
  const fetchMock = stubFetch({
    '/api/members': MEMBERS,
    '/api/invitations': paged([]),
    'POST /api/invitations': (init: RequestInit | undefined) => ({
      id: '66666666-6666-4666-8666-666666666666',
      tenantId: IDS.tenant,
      ...(JSON.parse(String(init?.body)) as object),
      status: 'pending',
      invitedByUserId: IDS.user,
      invitedByName: 'Olive',
      expiresAt: now,
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
    }),
    'POST /api/invitations/bulk': { sent: 3 },
    'PATCH /api/members/55555555-5555-4555-8555-555555555555': member(MEMBER_ID, 'Mia', 'admin'),
  })
  renderWithProviders(<People />, {
    session: makeSession({ user: makeUser({ id: self }), tenant: makeTenant({ role }) }),
  })
  return fetchMock
}

const optionValues = (select: HTMLElement) =>
  Array.from(select.querySelectorAll('option')).map(o => o.getAttribute('value'))
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement

describe('Settings → People', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('member: read-only — badges, no selects, no invite, no actions column', async () => {
    renderAs('member', MEMBER_ID)
    await screen.findByText('Adam')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Invite/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument()
    expect(within(row('Olive')).getByText('owner')).toBeInTheDocument()
  })

  it('admin: can change member roles but not owners, never offers the owner role, cannot remove owners', async () => {
    const fetchMock = renderAs('admin', ADMIN_ID)
    await screen.findByText('Adam')
    // Owner row is locked to a badge; own row is locked too
    expect(within(row('Olive')).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(row('Adam')).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(row('Olive')).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()

    const select = within(row('Mia')).getByRole('combobox', {
      name: 'Role for Mia',
    })
    expect(optionValues(select)).toEqual(['admin', 'member'])
    fireEvent.change(select, { target: { value: 'admin' } })
    await waitFor(() =>
      expect(requestBody(fetchMock, `PATCH /api/members/${MEMBER_ID}`)).toEqual({ role: 'admin' })
    )
    expect(within(row('Mia')).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('owner: may assign owner and remove admins, but not themselves', async () => {
    renderAs('owner')
    await screen.findByText('Adam')
    const select = within(row('Adam')).getByRole('combobox', {
      name: 'Role for Adam',
    })
    expect(optionValues(select)).toEqual(['owner', 'admin', 'member'])
    expect(within(row('Adam')).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    expect(within(row('Olive')).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(row('Olive')).getByText('(you)')).toBeInTheDocument()
  })

  it('invite modal: single invite posts { email, role } validated by the shared schema', async () => {
    const fetchMock = renderAs('owner')
    fireEvent.click(await screen.findByRole('button', { name: /Invite/ }))
    const form = document.getElementById('invite-form') as HTMLFormElement

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'nope' } })
    fireEvent.submit(form)
    expect(await screen.findByRole('alert')).toHaveTextContent(/email/i)
    expect(requestBody(fetchMock, 'POST /api/invitations')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'New.Person@Example.Test' },
    })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    fireEvent.submit(form)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/invitations')).toEqual({
        email: 'new.person@example.test',
        role: 'admin',
      })
    )
  })

  it('invite modal: bulk posts the parsed list', async () => {
    const fetchMock = renderAs('admin', ADMIN_ID)
    fireEvent.click(await screen.findByRole('button', { name: /Invite/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Several' }))
    fireEvent.change(screen.getByLabelText(/Email addresses/), {
      target: { value: 'a@x.io\nB@x.io, c@x.io;a@x.io' },
    })
    fireEvent.submit(document.getElementById('invite-form') as HTMLFormElement)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/invitations/bulk')).toEqual({
        emails: ['a@x.io', 'b@x.io', 'c@x.io'],
        role: 'member',
      })
    )
  })
})

describe('parseEmailList', () => {
  it('splits on whitespace, commas and semicolons; lower-cases; de-duplicates', () => {
    expect(parseEmailList(' A@x.io,b@x.io;\n\nc@x.io a@x.io ')).toEqual([
      'a@x.io',
      'b@x.io',
      'c@x.io',
    ])
  })
})
