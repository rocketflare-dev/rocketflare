/**
 * `request(path, init?)` drives the real Hono app with test bindings and a collecting
 * ExecutionContext, then drains `waitUntil` so the per-request DB close (middleware/database.ts)
 * has completed before assertions run — the production path, no test hooks in src/.
 */

import type { Hono } from 'hono'
import { app } from '@/api/index'
import type { AppEnv } from '@/api/types'
import {
  createExecutionContext,
  createTestEnv,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

export interface RequestOptions {
  /** Defaults to a fresh `createTestEnv()`. */
  env?: TestEnv
  /** Another `Hono<AppEnv>` (e.g. a router under test) instead of the full app. */
  app?: Hono<AppEnv>
  /** JSON body convenience — sets Content-Type and stringifies. */
  json?: unknown
}

export async function request(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {}
): Promise<Response> {
  const env = options.env ?? createTestEnv()
  const ctx = createExecutionContext()
  const headers = new Headers(init.headers)
  let body = init.body
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.json)
  }
  const target = options.app ?? app
  const res = await target.request(path, { ...init, headers, body }, env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}
