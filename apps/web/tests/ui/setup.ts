import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterEach, expect } from 'vitest'

// Not `import '@testing-library/jest-dom/vitest'`: that entry extends whichever `vitest` pnpm's
// hidden hoist resolves from jest-dom's directory — vitest 4 (apps/evals) as often as vitest 3
// (here), leaving every matcher undefined. Extending THIS package's `expect` cannot miss. The
// types follow the same rule in `jest-dom-vitest.d.ts`.
expect.extend(jestDomMatchers)

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
