/**
 * `c.set('config', loadConfig(c.env))` (D3). Runs after the request logger so a config
 * failure is logged with a request id, and before everything that reads `c.get('config')`.
 */
import { createMiddleware } from 'hono/factory'
import { loadConfig } from '../../config'
import type { AppEnv } from '../types'

export const configMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('config', loadConfig(c.env))
  await next()
})
