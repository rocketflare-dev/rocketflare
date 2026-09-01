/**
 * Declarative ability gates (D10). Cosmetic — the server enforces; these only keep controls a
 * reader cannot use out of the way.
 */
import type { Actions, Subjects } from '@gmgo/shared/permissions'
import type { ReactNode } from 'react'
import { usePermissions } from '@/ui/hooks/usePermissions'

interface IfCanProps {
  action: Actions
  subject: Subjects
  children: ReactNode
  fallback?: ReactNode
}

/** Render children only when the ability allows `action` on `subject`. */
export function IfCan({ action, subject, children, fallback = null }: IfCanProps) {
  const { can } = usePermissions()
  return <>{can(action, subject) ? children : fallback}</>
}

/** Render children only when the ability does NOT allow it (upsell, "ask an admin" hints). */
export function IfCannot({ action, subject, children }: Omit<IfCanProps, 'fallback'>) {
  const { cannot } = usePermissions()
  return <>{cannot(action, subject) ? children : null}</>
}
