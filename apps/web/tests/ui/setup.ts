import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterEach, expect } from 'vitest'

// Not `import '@testing-library/jest-dom/vitest'`: that entry extends whichever `vitest` pnpm's
// hidden hoist resolves from jest-dom's directory — vitest 4 (apps/evals) as often as vitest 5
// (here), leaving every matcher undefined. Extending THIS package's `expect` cannot miss. The
// types follow the same rule in `jest-dom-vitest.d.ts`.
expect.extend(jestDomMatchers)

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})
