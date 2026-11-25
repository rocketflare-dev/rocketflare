import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, expect, vi } from 'vitest'

// Not `import '@testing-library/jest-dom/vitest'`: that entry extends whichever `vitest` pnpm's
// hidden hoist resolves from jest-dom's directory — vitest 4 (apps/evals) as often as vitest 5
// (here), leaving every matcher undefined. Extending THIS package's `expect` cannot miss. The
// types follow the same rule in `jest-dom-vitest.d.ts`.
expect.extend(jestDomMatchers)

// jsdom has no layout, so it does not implement scrolling; `ScrollToTop` scrolls on navigation.
window.scrollTo = () => {}

// The `ui` project shares one module registry per worker (vitest.config.ts), so the app's
// module-level state outlives a file: reset each singleton, or the next file sees this one's
// toasts, socket state and cached queries. Imported inside the hook, as `tests/api-setup.ts`
// explains: a static import here would load them before a test file's `vi.mock` exists.
afterEach(async () => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  const [{ queryClient }, { useToastStore }, { useWebSocketStore }] = await Promise.all([
    import('@/ui/lib/queryClient'),
    import('@/ui/components/shared/Toast'),
    import('@/ui/stores/websocketStore'),
  ])
  queryClient.clear()
  useToastStore.setState(useToastStore.getInitialState(), true)
  useWebSocketStore.setState(useWebSocketStore.getInitialState(), true)
})

// Vitest restores spies after every file even in a shared registry, but not `vi.stubGlobal` or `vi.stubEnv`. Undo
// a file's stubs when it ends, not after each test: a file may stub once in `beforeAll`.
afterAll(async () => {
  ;(await import('@/ui/lib/navigation')).overrideHardNavigateForTests(null)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
