/**
 * The one rule for what counts as a same-origin return path, shared by the server guard
 * (`redirectToSchema` → `safeRedirectPath`), the SPA (`safeReturnUrl`) and any plugin that takes a
 * return path of its own (re-exported from `@rocketflare/shared/plugins/api`).
 *
 * Browsers strip tabs and newlines while parsing a URL and treat `\` like `/`, so a value that looks
 * like a path to a regular expression can navigate as `//other-host`. The rule therefore rejects
 * control characters and backslashes anywhere in the value before checking where it resolves.
 */

const PROBE_ORIGIN = 'https://path-check.invalid'

function hasControlCharOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

/** True only for a same-origin path: `/settings`, `/search?q=a#x`; never `//host` or `https://…`. */
export function isSameOriginPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (hasControlCharOrBackslash(value)) return false
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN
  } catch {
    return false
  }
}
