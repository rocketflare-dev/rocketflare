/**
 * `createRouter()` (D13): the only sanctioned way to instantiate Hono, so every router shares
 * `AppEnv` typing and `c.get('config' | 'db' | 'logger')` is typed without module augmentation.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../../types'

export function createRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>()
}

export type AppRouter = Hono<AppEnv>
