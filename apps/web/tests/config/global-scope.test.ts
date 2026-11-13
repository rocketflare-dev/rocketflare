/**
 * The Worker loads without an operation Cloudflare refuses in global scope.
 *
 * A deploy uploads the bundle and Cloudflare evaluates its top level once: a random value
 * (`crypto.randomUUID()`, `crypto.getRandomValues()`), a timer, or I/O (`fetch`) at module scope
 * fails the upload with error 10021. Nothing local catches it: `wrangler dev` and these tests both
 * allow all of them, so 0.36.0 shipped a `const … = crypto.randomUUID()` that no copy could deploy.
 *
 * This loads `src/worker.ts` — every kit module, every barrel and every installed plugin it
 * reaches — with those operations made to throw, the way the upload does. Make the value on first
 * use instead (a `let` filled inside the handler), or read it from `env`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const REFUSED = [
  'crypto.randomUUID',
  'crypto.getRandomValues',
  'setTimeout',
  'setInterval',
  'fetch',
]

function refuse(name: string): never {
  throw new Error(`${name}() in global scope: a deploy refuses it (Cloudflare error 10021)`)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the Worker in global scope', () => {
  it('generates no random value, sets no timer and does no I/O while it loads', async () => {
    const calls: string[] = []
    const guard =
      (name: string) =>
      (..._args: unknown[]): never => {
        calls.push(name)
        refuse(name)
      }
    vi.spyOn(crypto, 'randomUUID').mockImplementation(guard('crypto.randomUUID'))
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(guard('crypto.getRandomValues'))
    vi.stubGlobal('setTimeout', guard('setTimeout'))
    vi.stubGlobal('setInterval', guard('setInterval'))
    vi.stubGlobal('fetch', guard('fetch'))

    vi.resetModules()
    let loadError: unknown
    try {
      await import('@/worker')
    } catch (error) {
      loadError = error
    }
    expect(calls, `refused in global scope: ${REFUSED.join(', ')}`).toEqual([])
    expect(loadError).toBeUndefined()
  })
})
