/**
 * The label/value rows the AI inspectors are built from — the chat inspector (D17) and the run
 * workspace's Usage tab (issue #17) show the same kind of thing in the same shape, and one of them
 * having its own copy is how two panels start disagreeing about what a cost looks like.
 *
 * **It lives in `components/ai/`, not `components/shared/`.** Both consumers are lazy chunks, so
 * Vite emits this once and shares it; putting it in the eager barrel would be free today and a trap
 * the first time somebody adds a Markdown import to it.
 */
import type { ReactNode } from 'react'

const MICROCENTS_PER_USD = 100_000_000

/**
 * `null` is "we do not know", and it renders as `—` rather than `$0.00`. Guessing zero is how a
 * page claims a run was free when the truth is that nothing attributed its tokens.
 */
export function formatCost(microcents: number | null): string {
  if (microcents === null) return '—'
  const usd = microcents / MICROCENTS_PER_USD
  if (usd === 0) return '$0.00'
  // Turns are cheap enough that two decimals rounds most threads to nothing.
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-xs text-muted shrink-0">{label}</span>
      <span className="text-xs font-mono text-right break-all" title={hint}>
        {value}
      </span>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-3 py-2 border-b border-[color:var(--border-subtle)]">
      <h3 className="text-xs font-semibold mb-1">{title}</h3>
      {children}
    </section>
  )
}
