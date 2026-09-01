/**
 * The card every page OUTSIDE the shell renders in (login, invite, select-tenant, pending):
 * brand header + theme toggle over `main-gradient`. Keeps the public pages visually one family.
 */
import type { ReactNode } from 'react'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { LogoMark } from './shared/LogoMark'
import ThemeToggle from './ThemeToggle'

interface AuthCardProps {
  children: ReactNode
  /** `max-w-md` (default) or wider for lists */
  width?: 'md' | 'lg'
  /** Rendered under the card (e.g. "Signed in as … · Sign out") */
  footer?: ReactNode
}

export function AuthCard({ children, width = 'md', footer }: AuthCardProps) {
  const { name } = useAppInfo()
  return (
    <div className="min-h-screen main-gradient flex flex-col items-center justify-center px-4 py-10">
      <div className={`w-full ${width === 'lg' ? 'max-w-lg' : 'max-w-md'}`}>
        <div className="surface-panel !p-0 overflow-hidden">
          <div className="flex h-14 items-center justify-between px-6 border-b border-[color:var(--border-subtle)]">
            <span className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-sm font-semibold tracking-tight">{name}</span>
            </span>
            <ThemeToggle />
          </div>
          <div className="p-6 md:p-8">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-secondary">{footer}</div>}
      </div>
    </div>
  )
}

/** "Signed in as X · Sign out" — the footer most no-tenant pages share. */
export function SignedInAs({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <span>
      Signed in as <span className="font-medium text-base-content">{email}</span>
      {' · '}
      <button type="button" className="link link-hover" onClick={onSignOut}>
        Sign out
      </button>
    </span>
  )
}
