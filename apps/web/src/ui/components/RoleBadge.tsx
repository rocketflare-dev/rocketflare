/** Membership role chip (D10). Classes come from a finite prop → safelisted in index.css. */
import type { MembershipRole } from '@rocketflare/shared/tenants'

const ROLE_CLASS: Record<MembershipRole, string> = {
  owner: 'badge-primary',
  admin: 'badge-secondary',
  member: 'badge-ghost',
  support: 'badge-warning',
}

export function RoleBadge({ role, className = '' }: { role: MembershipRole; className?: string }) {
  return (
    <span className={`badge badge-sm capitalize ${ROLE_CLASS[role]} ${className}`}>{role}</span>
  )
}
