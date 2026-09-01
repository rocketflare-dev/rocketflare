import type { ComponentType, ReactNode } from 'react'

interface EmptyStateProps {
  /** Heroicon component */
  icon?: ComponentType<{ className?: string }>
  message: string
  description?: string
  /** Usually one primary action */
  action?: ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: { container: 'py-4', icon: 'w-8 h-8', message: 'text-sm', description: 'text-xs' },
  md: { container: 'py-8', icon: 'w-12 h-12', message: 'text-base', description: 'text-sm' },
  lg: { container: 'py-12', icon: 'w-16 h-16', message: 'text-lg', description: 'text-base' },
}

/** "Nothing here yet" for lists and panels. */
export function EmptyState({
  icon: Icon,
  message,
  description,
  action,
  className = '',
  size = 'md',
}: EmptyStateProps) {
  const sizes = sizeClasses[size]
  return (
    <div className={`text-center text-muted ${sizes.container} ${className}`}>
      {Icon && <Icon className={`${sizes.icon} mx-auto mb-2 opacity-40`} />}
      <p className={sizes.message}>{message}</p>
      {description && <p className={`${sizes.description} text-muted mt-1`}>{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Panel-wrapped empty state for grid layouts. */
export function EmptyStateCard(props: EmptyStateProps) {
  const { className = '', ...rest } = props
  return (
    <div className={`surface-panel ${className}`}>
      <EmptyState {...rest} />
    </div>
  )
}
