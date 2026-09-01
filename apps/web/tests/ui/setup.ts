import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Router v6 warns about each v7 future flag once PER ROUTER INSTANCE. The app's router
// opts in (App.tsx `future={{…}}`) and so does renderWithProviders; the filter covers bare
// `<MemoryRouter>`s in tests that don't need the helper. Nothing else is swallowed.
const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('React Router Future Flag Warning')) return
  realWarn(...args)
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})
