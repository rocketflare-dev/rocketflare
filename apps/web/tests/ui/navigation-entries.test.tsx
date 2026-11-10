/**
 * `useNavigationEntries` / `navigationEntries`: every destination the reader may open, filtered by
 * the same guards that hide it in the nav, the settings page and Home. Driven by the REAL
 * `useNavGuard` and the real permission matrix, so a role's list is what that role would see.
 */
import { BeakerIcon } from '@heroicons/react/24/outline'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AnyUiPlugin } from '@/plugins/types'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import {
  type NavigationEntry,
  navigationEntries,
  useNavigationEntries,
} from '@/ui/hooks/useNavigationEntries'
import { makeSession, makeTenant, renderWithProviders } from './helpers/renderWithProviders'

const LAB_GUARD: NavGuard = { action: 'read', subject: 'Lab' }

/** A plugin with a nav item, a settings tab gated on its own subject, and a quick link. */
const labUi = {
  shared: { id: 'lab', label: 'Lab' },
  routes: [],
  nav: [
    { label: 'Science', items: [{ to: '/lab', label: 'Lab', icon: BeakerIcon, guard: LAB_GUARD }] },
  ],
  settingsTabs: ({ can }: { can: (action: string, subject: string) => boolean }) =>
    can('manage', 'Lab') ? [{ id: 'lab', label: 'Lab settings', content: null }] : [],
  homeLinks: [
    { to: '/lab/new', label: 'New experiment', description: 'Start one', icon: BeakerIcon },
  ],
} as unknown as AnyUiPlugin

/** A role-shaped check: `admin` for owner/admin, ability pairs from a fixed grant list. */
function checks(role: 'owner' | 'member', grants: string[] = []) {
  const can = (action: string, subject: string) =>
    grants.includes(`${action} ${subject}`) || (role === 'owner' && action === 'read')
  const canAccess = (guard: NavGuard | undefined): boolean => {
    if (guard === undefined) return true
    if (Array.isArray(guard)) return guard.every(canAccess)
    if (guard === 'admin') return role === 'owner'
    if (guard === 'globalAdmin') return false
    if (typeof guard === 'object' && 'feature' in guard) return false
    const pair = guard as { action: string; subject: string }
    return can(pair.action, pair.subject)
  }
  return { canAccess, can }
}

const byId = (entries: NavigationEntry[]) => new Map(entries.map(e => [e.id, e]))

describe('navigationEntries', () => {
  it('lists a plugin nav item under its group and source, and only when its guard passes', () => {
    const owner = byId(navigationEntries([labUi], checks('owner')))
    expect(owner.get('nav:/lab')).toMatchObject({
      label: 'Lab',
      to: '/lab',
      group: 'Science',
      source: 'lab',
    })
    expect(owner.get('nav:/chat')).toMatchObject({ group: 'Pages', source: 'kit' })
    expect(owner.get('link:/lab/new')).toMatchObject({ group: 'Quick links', source: 'lab' })

    const member = byId(navigationEntries([labUi], checks('member', ['read Conversation'])))
    expect(member.has('nav:/lab')).toBe(false)
    expect(member.has('nav:/chat')).toBe(true)
    expect(member.has('nav:/settings')).toBe(false)
  })

  it('lists the settings tabs as /settings?tab=, each behind the page guard and its own', () => {
    const owner = byId(navigationEntries([labUi], checks('owner', ['manage Lab', 'manage Group'])))
    expect(owner.get('settings:people')).toMatchObject({
      label: 'People',
      to: '/settings?tab=people',
      group: 'Settings',
      source: 'kit',
    })
    expect(owner.get('settings:people')?.keywords).toContain('invite')
    expect(owner.get('settings:groups')).toBeDefined()
    expect(owner.has('settings:usage')).toBe(false) // needs manage AiConfig
    expect(owner.get('settings:lab')).toMatchObject({
      label: 'Lab settings',
      to: '/settings?tab=lab',
      source: 'lab',
    })

    // No `admin`, no settings page, so no tab at all — even one whose own check would pass.
    const member = navigationEntries([labUi], checks('member', ['manage Lab']))
    expect(member.some(e => e.group === 'Settings')).toBe(false)
  })

  it('lists a path once, the first source winning', () => {
    const entries = navigationEntries([labUi], checks('owner'))
    expect(entries.filter(e => e.to === '/settings')).toHaveLength(1)
    expect(byId(entries).get('nav:/settings')?.group).toBe('Organisation')
  })
})

function Probe() {
  const entries = useNavigationEntries()
  return <output data-testid="entries">{entries.map(e => e.id).join(' ')}</output>
}

describe('useNavigationEntries', () => {
  it('gives an owner the settings tabs and a member neither them nor Settings', async () => {
    renderWithProviders(<Probe />, { session: makeSession() })
    const owner = (await screen.findByTestId('entries')).textContent ?? ''
    expect(owner.split(' ')).toEqual(
      expect.arrayContaining([
        'nav:/',
        'nav:/settings',
        'settings:people',
        'settings:usage',
        'link:/profile',
      ])
    )
  })

  it('a member sees the pages they may open and no settings', async () => {
    renderWithProviders(<Probe />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
    })
    const ids = ((await screen.findByTestId('entries')).textContent ?? '').split(' ')
    expect(ids).toEqual(expect.arrayContaining(['nav:/chat', 'nav:/documents', 'link:/profile']))
    expect(ids.some(id => id.startsWith('settings:'))).toBe(false)
    expect(ids).not.toContain('nav:/settings')
    expect(ids).not.toContain('nav:/admin')
  })
})
