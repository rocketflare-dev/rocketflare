/**
 * `validate(target, schema)` (D13): `@hono/zod-validator` with a hook that throws
 * `ValidationError`, so a bad body/query/param becomes the shared 400 envelope
 * `{ error, statusCode: 400, code: 'validation_failed', details: issues }` through `onError`
 * instead of zod's raw `{ success: false, error }`.
 */
import { type Hook, zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { ZodSchema } from 'zod'
import type { AppEnv } from '../../types'
import { ValidationError } from '../core/errors'

const hook: Hook<unknown, AppEnv, string> = result => {
  if (!result.success) {
    throw new ValidationError(result.error.issues, `Invalid ${result.target}`)
  }
}

export function validate<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T
) {
  return zValidator<T, Target, AppEnv, string, typeof hook>(target, schema, hook)
}
