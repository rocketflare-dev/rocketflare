/** Types for `svg-sanitize.mjs` (no `allowJs`); `apps/web/tests/kit-only/design-docs.test.ts` typechecks against this. */
export function sanitizeSvg(
  source: string,
  options?: { idPrefix?: string; label?: string }
): string | null
