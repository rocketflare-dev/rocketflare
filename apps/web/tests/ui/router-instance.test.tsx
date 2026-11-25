import { screen } from '@testing-library/react'
import * as router from 'react-router'
import * as routerDom from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from './helpers/renderWithProviders'

// Installed plugins import `react-router-dom` until their 4.0.0; the kit imports `react-router`.
describe('react-router and react-router-dom', () => {
  it('resolve to one module instance', () => {
    expect(routerDom.Routes).toBe(router.Routes)
  })

  it('render routes from react-router-dom inside the kit router', () => {
    renderWithProviders(
      <routerDom.Routes>
        <routerDom.Route path="*" element={<p>routed</p>} />
      </routerDom.Routes>
    )
    expect(screen.getByText('routed')).toBeInTheDocument()
  })
})
