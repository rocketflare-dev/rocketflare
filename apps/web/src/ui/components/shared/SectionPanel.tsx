import type { ReactNode } from 'react'

interface SectionPanelProps {
  /** Omit for pure-content panels */
  title?: ReactNode
  description?: ReactNode
  /** Right-aligned controls: counts, filters, buttons */
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Remove the inner padding (tables that bleed to the edge) */
  flush?: boolean
}

/** The default content container: `.surface-panel` with an optional header row. */
export function SectionPanel({
  title,
  description,
  actions,
  children,
  className = '',
  flush = false,
}: SectionPanelProps) {
  const hasHeader = Boolean(title || actions)
  return (
    <section className={`surface-panel ${flush ? 'p-0 overflow-hidden' : ''} ${className}`}>
      {hasHeader && (
        <div
          className={`flex flex-wrap items-start justify-between gap-3 ${flush ? 'px-5 pt-5 pb-3' : 'mb-4'}`}
        >
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold leading-6">{title}</h2>}
            {description && <p className="text-sm text-secondary mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/* Uneven widths so the skeleton reads as text, not a block */
const SKELETON_ROW_WIDTHS = ['w-full', 'w-11/12', 'w-3/4', 'w-2/3', 'w-1/2', 'w-5/12']

/** Placeholder lines on their own, for panels that stay mounted while loading. */
export function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  const widths = SKELETON_ROW_WIDTHS.slice(0, Math.min(rows, SKELETON_ROW_WIDTHS.length))
  return (
    <div className={`animate-pulse space-y-3 ${className}`} aria-busy="true" aria-live="polite">
      {widths.map(width => (
        <div key={width} className={`h-4 rounded surface-inset border-0 ${width}`} />
      ))}
    </div>
  )
}

/** Loading placeholder shaped like `SectionPanel`, so content does not jump on resolve. */
export function SectionPanelSkeleton({
  rows = 4,
  className = '',
}: {
  rows?: number
  className?: string
}) {
  return (
    <div className={`surface-panel ${className}`}>
      <div className="animate-pulse space-y-4">
        <div className="h-5 rounded surface-inset border-0 w-48" />
        <SkeletonRows rows={rows} />
      </div>
    </div>
  )
}
