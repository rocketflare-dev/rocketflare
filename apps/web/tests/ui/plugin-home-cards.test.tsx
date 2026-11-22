/**
 * `UiPlugin.homeCards` — Home's "what needs doing" section. Through the REAL `useNavGuard` (a
 * failing guard hides the card, a feature guard hides it from a global admin too), each card
 * isolated (a throw costs only that card), the order deterministic, and no section at all when no
 * card passes.
 */

import { screen } from '@testing-library/react'
import { lazy } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PluginHomeCard } from '@/plugins/types'
import { PluginHomeCards, pluginHomeCards } from '@/ui/components/PluginHomeCards'
import {
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
  rulesFor,
} from './helpers/renderWithProviders'

const card = (label: string) => lazy(async () => ({ default: () => <p>{label}</p> }))

const plugin = (id: string, homeCards: PluginHomeCard[]) => ({
  shared: { id, label: id },
  homeCards,
})

const section = () => screen.queryByRole('region', { name: 'What needs doing' })

describe('pluginHomeCards', () => {
  it('orders by order, then plugin id, then card id', () => {
    const C = card('x')
    const cards = pluginHomeCards([
      plugin('zeta', [{ id: 'a', Component: C }]),
      plugin('alpha', [
        { id: 'b', Component: C },
        { id: 'a', Component: C },
        { id: 'first', Component: C, order: -1 },
      ]),
    ])
    expect(cards.map(c => c.key)).toEqual(['alpha:first', 'alpha:a', 'alpha:b', 'zeta:a'])
  })
})

describe('PluginHomeCards', () => {
  it('renders cards in order, and hides one whose guard fails', async () => {
    const member = makeSession({ tenant: makeTenant({ role: 'member' }) })
    renderWithProviders(
      <PluginHomeCards
        plugins={[
          plugin('beta', [{ id: 'one', Component: card('Beta card') }]),
          plugin('alpha', [
            { id: 'open', Component: card('Alpha card') },
            { id: 'admin', guard: 'admin', Component: card('Admin card') },
          ]),
        ]}
      />,
      { session: member }
    )
    expect(await screen.findByText('Beta card')).toBeInTheDocument()
    const texts = [...(section()?.querySelectorAll('p') ?? [])].map(p => p.textContent)
    expect(texts).toEqual(['Alpha card', 'Beta card'])
    expect(screen.queryByText('Admin card')).not.toBeInTheDocument()
  })

  it('hides a feature-guarded card from a global admin while the flag is off', async () => {
    const user = makeUser({ isGlobalAdmin: true })
    renderWithProviders(
      <PluginHomeCards
        plugins={[
          plugin('fixture', [
            { id: 'flag', guard: { feature: 'fixture' }, Component: card('Flagged card') },
            { id: 'open', Component: card('Open card') },
          ]),
        ]}
      />,
      { session: makeSession({ user, permissions: rulesFor('owner', true, []), features: [] }) }
    )
    expect(await screen.findByText('Open card')).toBeInTheDocument()
    expect(screen.queryByText('Flagged card')).not.toBeInTheDocument()
  })

  it('isolates a card that throws: its neighbours still render', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Broken = lazy(async () => ({
      default: () => {
        throw new Error('home card exploded')
      },
    }))
    renderWithProviders(
      <PluginHomeCards
        plugins={[
          plugin('broken', [{ id: 'boom', Component: Broken }]),
          plugin('fine', [{ id: 'ok', Component: card('Still here') }]),
        ]}
      />
    )
    expect(await screen.findByText('Still here')).toBeInTheDocument()
    expect(error.mock.calls.some(call => String(call[0]).includes('broken:boom'))).toBe(true)
    error.mockRestore()
  })

  it('renders no section when no card passes its guard', () => {
    const member = makeSession({ tenant: makeTenant({ role: 'member' }) })
    renderWithProviders(
      <PluginHomeCards
        plugins={[plugin('fixture', [{ id: 'a', guard: 'admin', Component: card('Hidden') }])]}
      />,
      { session: member }
    )
    expect(section()).not.toBeInTheDocument()
  })
})
