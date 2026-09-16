/** What the run was asked to do — the validated `input` body, verbatim. */
import { pretty, truncate } from '../timeline/toolResults'

export function RunInputTab({ input }: { input: unknown }) {
  return (
    <pre className="surface-inset rounded-lg p-3 text-xs whitespace-pre-wrap break-words max-h-[32rem] overflow-auto">
      {truncate(pretty(input), 20_000)}
    </pre>
  )
}
