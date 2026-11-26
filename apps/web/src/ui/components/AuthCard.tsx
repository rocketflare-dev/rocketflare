/**
 * The card every page OUTSIDE the shell renders in (login, invite, select-tenant, pending):
 * brand header + theme toggle on the canvas. Keeps the public pages visually one family.
 *
 * `split` (the sign-in page): the form on the left on a panel-white ground, and on the right a
 * tinted panel in the rail's tones — the drawing from `LoginArt` alone, or the app's name and tagline
 * when `LOGIN_PANEL.art` is `'type'` (lib/login-panel.ts). Below `lg` the panel folds away and
 * the form takes the screen.
 */
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { LOGIN_PANEL } from '@/ui/lib/login-panel'
import { LoginArt } from './LoginArt'
import { LogoMark } from './shared/LogoMark'
import ThemeToggle from './ThemeToggle'

interface AuthCardProps {
  children: ReactNode
  /** `max-w-md` (default) or wider for lists */
  width?: 'md' | 'lg'
  /** Rendered under the card (e.g. "Signed in as … · Sign out") */
  footer?: ReactNode
  /** The sign-in layout: form left, tinted brand panel right */
  split?: boolean
}

export function AuthCard({ children, width = 'md', footer, split = false }: AuthCardProps) {
  const { name } = useAppInfo()
  if (split) {
    return (
      <div className="min-h-dvh grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] bg-[color:var(--surface-panel)]">
        <div className="flex min-w-0 flex-col px-6 py-5 sm:px-10">
          <div className="flex h-12 items-center justify-between">
            <span className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-[15px] font-semibold tracking-tight">{name}</span>
            </span>
            <ThemeToggle />
          </div>
          <div className="flex flex-1 items-center justify-center py-10">
            <div className="w-full max-w-sm">{children}</div>
          </div>
          {footer && <div className="pb-2 text-center text-sm text-secondary">{footer}</div>}
        </div>
        <LoginPanel name={name} />
      </div>
    )
  }
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

/** The sign-in page's right-hand panel: the drawing, or the name and tagline set large. */
function LoginPanel({ name }: { name: string }) {
  const { art, tagline } = LOGIN_PANEL
  return (
    <aside
      data-testid="login-panel"
      data-art={art}
      className="rail-surface relative m-3 hidden overflow-hidden rounded-[var(--radius-panel)] lg:flex lg:flex-col lg:justify-end"
    >
      {art === 'rocket' && <LoginArt className="absolute inset-0 h-full w-full" />}
      {art === 'type' && (
        <div className="relative max-w-md p-10">
          <p className="font-heading mb-3 text-4xl font-semibold tracking-tight text-balance">
            {name}
          </p>
          <p className="text-lg rail-muted text-pretty">{tagline}</p>
        </div>
      )}
    </aside>
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

/**
 * A global admin parked on a no-tenant page can still run the platform: `/admin/*` needs no
 * membership (`ProtectedRoute`'s one exemption), and it is where they approve the next person.
 */
export function AdminAreaLink({ className = '' }: { className?: string }) {
  return (
    <div className={`surface-inset rounded-lg p-3 text-sm flex items-center gap-3 ${className}`}>
      <ShieldCheckIcon className="w-5 h-5 shrink-0 text-muted" />
      <span className="flex-1 text-secondary">
        You're a global administrator — the admin area works without an organisation.
      </span>
      <Link to="/admin" className="btn btn-primary btn-sm whitespace-nowrap">
        Open the admin area
      </Link>
    </div>
  )
}
