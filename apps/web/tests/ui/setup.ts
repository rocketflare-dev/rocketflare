import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, expect, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import { queryClient } from '@/ui/lib/queryClient'
import { useWebSocketStore } from '@/ui/stores/websocketStore'

// Not `import '@testing-library/jest-dom/vitest'`: that entry extends whichever `vitest` pnpm's
// hidden hoist resolves from jest-dom's directory — vitest 4 (apps/evals) as often as vitest 5
// (here), leaving every matcher undefined. Extending THIS package's `expect` cannot miss. The
// types follow the same rule in `jest-dom-vitest.d.ts`.
expect.extend(jestDomMatchers)

// jsdom has no layout, so it does not implement scrolling; `ScrollToTop` scrolls on navigation.
window.scrollTo = () => {}

// The `ui` project shares one module registry per worker (vitest.config.ts), so the app's
// module-level state outlives a file: reset each singleton, or the next file sees this one's
// toasts, socket state and cached queries.
afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  queryClient.clear()
  useToastStore.setState(useToastStore.getInitialState(), true)
  useWebSocketStore.setState(useWebSocketStore.getInitialState(), true)
})

// Vitest restores spies after every file even in a shared registry, but not `vi.stubGlobal`. Undo
// a file's stubs when it ends, not after each test: a file may stub once in `beforeAll`.
afterAll(() => {
  vi.unstubAllGlobals()
})
