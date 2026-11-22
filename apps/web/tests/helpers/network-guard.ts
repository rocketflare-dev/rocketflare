/**
 * The api suites never reach the internet. A request to anything but this machine fails AT ONCE
 * with an error naming the URL, rather than waiting on DNS, a firewall or a vendor SDK's retry
 * backoff — which is what made "a new endpoint needs the key again" and the PDF upload test time out
 * under load: their real calls to api.anthropic.com and api.openai.com took ~4.5 s to fail in a
 * sandbox with no network, a hair under vitest's 5 s, and over it whenever the machine was busy.
 *
 * A test that wants a provider answer runs a local server (`node:http` on 127.0.0.1, as
 * `security/ai-config-stored-credential.test.ts` does) or injects `fetch`. The guard wraps
 * `globalThis.fetch` once per process; a file that stubs or spies on fetch itself still replaces
 * it, and the stub is undone when the file ends.
 */
const GUARDED = Symbol.for('rocketflare.tests.networkGuard')

/** This machine: loopback, `localhost`, and `*.localtest.me` (the Neon local proxy's host). */
export function isLocalUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true // not an absolute URL: nothing leaves the process
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host === 'localtest.me' ||
    host.endsWith('.localtest.me')
  )
}

export class OutboundNetworkError extends TypeError {
  constructor(readonly url: string) {
    super(`fetch failed: outbound network is disabled in tests (${url})`)
    this.name = 'OutboundNetworkError'
  }
}

export function installNetworkGuard(): void {
  const g = globalThis as typeof globalThis & { [GUARDED]?: true }
  if (g[GUARDED]) return
  const real = globalThis.fetch
  const guarded: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (!isLocalUrl(url)) return Promise.reject(new OutboundNetworkError(url))
    return real(input, init)
  }
  globalThis.fetch = guarded
  g[GUARDED] = true
}
