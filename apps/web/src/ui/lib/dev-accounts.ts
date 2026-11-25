/**
 * The seeded development accounts — ONE list, read by `scripts/seed.ts` (which creates them) and
 * by the login page (its "Dev quick login" buttons and the `?as=` allow-list). Add, remove or
 * rename an account here and both follow; there is no second copy to keep in step.
 *
 * A tenant account is seeded into the main tenant (`acme`, or the single tenant) with its `role`;
 * the global admin gets the platform flag instead (and a `member` row in single-tenant mode). The
 * buttons' labels come from `ROLE_LABELS`, so an app that renames the roles renames these too.
 *
 * The server never reads this list: `/auth/dev-login` 404s outside `APP_ENV=development`, and the
 * list only narrows what the page will do on its own from a URL.
 */
import { roleLabel, type TenantRole } from '@rocketflare/shared/tenants'

export interface DevAccount {
  email: string
  /** The name the seed gives the user. */
  name: string
  /** Their role in the seeded tenant; `null` for the global admin (no tenant role of its own). */
  role: TenantRole | null
  isGlobalAdmin?: true
}

export const DEV_ACCOUNTS: readonly DevAccount[] = [
  { email: 'owner@example.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@example.test', name: 'Adam Admin', role: 'admin' },
  { email: 'member@example.test', name: 'Mia Member', role: 'member' },
  { email: 'admin@rocketflare.local', name: 'Platform Admin', role: null, isGlobalAdmin: true },
]

/** The quick-login button text: the role's label, or "Global admin". */
export function devAccountLabel(account: DevAccount): string {
  if (account.isGlobalAdmin) return 'Global admin'
  return account.role ? roleLabel(account.role) : account.email
}

/** `true` when `email` is one of the seeded accounts (case-insensitive). */
export function isDevAccount(email: string | null | undefined): boolean {
  if (!email) return false
  const wanted = email.toLowerCase()
  return DEV_ACCOUNTS.some(account => account.email.toLowerCase() === wanted)
}
