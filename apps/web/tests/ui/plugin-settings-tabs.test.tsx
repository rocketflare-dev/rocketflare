/**
 * A plugin settings tab's `guard`: the host checks it with the REAL `useNavGuard`, so a tab behind
 * `{ feature }` is hidden in an organisation without the feature, even from an owner whose `can`
 * would pass — a plugin's grants hold in every organisation, which is why `can` alone is not enough.
 */

import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnyUiPlugin } from '@/plugins/types'
import SettingsLayout from '@/ui/pages/settings/SettingsLayout'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const plugins = [
  {
    shared: { id: 'hotel', label: 'Hotel' },
    routes: [],
    settingsTabs: () => [
      { id: 'taxes', label: 'Taxes', content: null, guard: { feature: 'hotel' } },
      { id: 'front-desk', label: 'Front desk', content: null },
    ],
  },
] as unknown as readonly AnyUiPlugin[]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plugin settings tab guard', () => {
  it('hides a feature-guarded tab where the organisation lacks the feature', async () => {
    stubFetch()
    renderWithProviders(<SettingsLayout plugins={plugins} />, {
      session: makeSession({ features: [] }),
    })
    expect(await screen.findByRole('tab', { name: /Front desk/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Taxes/ })).not.toBeInTheDocument()
  })

  it('shows it where the feature is on', async () => {
    stubFetch()
    renderWithProviders(<SettingsLayout plugins={plugins} />, {
      session: makeSession({ features: ['hotel'] }),
    })
    expect(await screen.findByRole('tab', { name: /Taxes/ })).toBeInTheDocument()
  })
})
