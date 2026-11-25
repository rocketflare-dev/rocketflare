import type { ReactNode } from 'react'
import { Link } from 'react-router'

export interface Breadcrumb {
  label: string
  to?: string
}

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  breadcrumbs?: Breadcrumb[]
  /** Small tag beside the title (status badge, count) */
  badge?: ReactNode
  /** Right-aligned controls */
  actions?: ReactNode
  className?: string
}

/** The trail above a page title, on its own for a surface with no `PageHeader` (an editor toolbar). */
export function Breadcrumbs({
  items,
  className = '',
}: {
  items: Breadcrumb[]
  className?: string
}) {
  return (
    <nav aria-label="Breadcrumb" className={`text-xs text-muted ${className}`}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((crumb, i) => (
          <li key={crumb.to ?? crumb.label} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">/</span>}
            {crumb.to ? (
              <Link to={crumb.to} className="hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span>{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Page title row: breadcrumbs, a modest title (no enormous headings), description, actions. */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  badge,
  actions,
  className = '',
}: PageHeaderProps) {
  return (
    <div className={`mb-6 ${className}`}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumbs items={breadcrumbs} className="mb-1.5" />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight truncate">{title}</h1>
            {badge}
          </div>
          {description && <p className="text-sm text-secondary mt-1">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
