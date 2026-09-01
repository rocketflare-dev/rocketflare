/** Shared test helpers (D26): temp config dirs, a fetch mock, and an in-memory command context. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '../src/api'
import { type ConfigStore, createConfigStore } from '../src/config'
import type { CommandContext } from '../src/context'
import { createMemoryLogger } from '../src/utils/logger'
import { createMemoryOutput } from '../src/utils/output'

export async function tempStore(env: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rocketflare-cli-test-'))
  const store = createConfigStore({ dir: join(dir, '.rocketflare'), env })
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch that dispatches on pathname and records every call. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ url, init })
    const route = routes[url.pathname]
    if (!route) return jsonResponse({ error: 'Not found', statusCode: 404, code: 'not_found' }, 404)
    return route(url, init)
  }
  return { fetch: fetchImpl, calls }
}

export interface TestContextOptions {
  store: ConfigStore
  fetch?: FetchLike
  json?: boolean
  server?: string
  open?: (url: string) => Promise<unknown>
}

export async function testContext(options: TestContextOptions) {
  const log = createMemoryLogger()
  const out = createMemoryOutput(options.json ?? false)
  const config = await options.store.resolve({ serverUrl: options.server })
  const ctx: CommandContext = {
    store: options.store,
    config,
    json: options.json ?? false,
    log,
    out,
    fetch: options.fetch ?? (() => Promise.reject(new Error('fetch not mocked'))),
    open: options.open ?? (async () => {}),
    binName: 'rocketflare',
  }
  return { ctx, log, out }
}

export const TEST_KEY = 'rocketflare_test_0123456789abcdefghijklmnopqrstuvwxyz'
export const TENANT_ID = '11111111-2222-4333-8444-555555555555'
export const USER_ID = '99999999-8888-4777-8666-555555555555'

/** Request headers of the i-th recorded call (empty object when absent). */
export function headersOf(calls: { init: RequestInit }[], i = 0): Record<string, string> {
  return (calls[i]?.init.headers ?? {}) as Record<string, string>
}

/** Await a promise expected to reject and return the error (typed loosely for assertions). */
export async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}
