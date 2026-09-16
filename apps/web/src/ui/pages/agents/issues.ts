/**
 * The server's zod issues, pulled out of a 400 so they can land back on the fields that caused
 * them. One copy: the run form and the interrupt panel both post bodies the route validates with a
 * shared schema, and both map the answer through `fieldErrorFor` / `FieldError`.
 */
import { ApiError } from '@/ui/lib/api-client'

export type Issue = { path: readonly PropertyKey[]; message: string }

/** zod issues the server put in `details` (`validation_failed`), if that is what they are. */
export function issuesFrom(error: unknown): Issue[] | undefined {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return undefined
  const issues = error.details.filter(
    (d): d is Issue =>
      typeof d === 'object' && d !== null && Array.isArray((d as Issue).path) && 'message' in d
  )
  return issues.length > 0 ? issues : undefined
}
