/**
 * The jest-dom matchers on THIS package's vitest (3.x).
 *
 * `@testing-library/jest-dom/vitest` augments `declare module 'vitest'` from inside its own install
 * directory, where `vitest` resolves through pnpm's hidden hoist (`node_modules/.pnpm/node_modules`)
 * — to vitest 3 (apps/web) or vitest 4 (apps/evals) depending on install order. When it lands on 4,
 * every `toBeInTheDocument` here is a type error: the "flaky jest-dom matcher types" in CI. Declared
 * from apps/web, `vitest` resolves to apps/web's own, so the matchers attach to the right one
 * whatever pnpm hoisted.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's own vitest.d.ts
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  // biome-ignore lint/suspicious/noExplicitAny: mirrors jest-dom's own vitest.d.ts
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
