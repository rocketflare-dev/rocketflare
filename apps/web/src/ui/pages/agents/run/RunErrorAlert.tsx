/**
 * Why a run failed, **above the tab bar and always visible**. A failure is not a tab: putting it
 * behind one means the page's headline answer to "what happened?" is a thing you have to go and
 * look for.
 */
export function RunErrorAlert({ error }: { error: string }) {
  return (
    <section className="alert alert-error text-sm" role="alert">
      <span className="whitespace-pre-wrap break-words">{error}</span>
    </section>
  )
}
