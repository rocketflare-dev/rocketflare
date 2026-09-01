/**
 * Inline field error. Forms are plain React + the `@shared` zod schema the server uses
 * (`schema.safeParse(values)` before submit); this renders one issue's message.
 */
export function FieldError({ message, id }: { message?: string | null; id?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-error mt-1" role="alert">
      {message}
    </p>
  )
}

/** Pick the first zod issue for a field path out of a `safeParse` failure. */
export function fieldErrorFor(
  issues: readonly { path: readonly PropertyKey[]; message: string }[] | undefined,
  field: string
): string | undefined {
  return issues?.find(issue => issue.path[0] === field)?.message
}
