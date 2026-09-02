/**
 * Sign in (D9, D11). Everything is driven by `GET /auth/methods`: OAuth buttons for the configured
 * providers (full-page redirect to `/auth/:provider`), a magic-link form (validated with the SAME
 * `magicLinkRequestSchema` the server uses), and — only when the server says `devLogin` — the
 * seeded quick-login accounts. Server-side failures arrive as `?error=<code>`.
 *
 * `?as=<email>` (what `pnpm bootstrap` opens) signs in through the same dev-login call once on
 * mount. Threat model: this is login-CSRF against a dev-only route that already 404s outside
 * `APP_ENV=development`; the page honours it ONLY when the server reports `devLogin` AND the email
 * is one of `DEV_ACCOUNTS` — an arbitrary address in the URL does nothing.
 */

import { EnvelopeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { type MagicLinkRequest, magicLinkRequestSchema } from '@rocketflare/shared/auth'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '@/ui/components/AuthCard'
import { PROVIDER_ICONS, PROVIDER_LABELS } from '@/ui/components/icons/ProviderIcons'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { FieldError, fieldErrorFor, SkeletonRows } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useAuthMethods } from '@/ui/hooks/useAuthMethods'
import { ApiError, api } from '@/ui/lib/api-client'
import { hardNavigate, safeReturnUrl } from '@/ui/lib/navigation'
import { MagicLinkSentCard } from './MagicLinkSent'

/** Friendly copy per `?error=` code the auth routes redirect with. */
export const LOGIN_ERROR_COPY: Record<string, string> = {
  invalid_token: "That sign-in link isn't valid. Request a new one below.",
  expired: 'That sign-in link has expired. Request a new one below.',
  not_invited: "There's no invitation for that email address. Ask an administrator to invite you.",
  blocked: 'This account has been blocked. Contact an administrator.',
}
const GENERIC_LOGIN_ERROR = 'Sign in failed. Please try again.'

/** Seeded by `pnpm seed`; the server only honours these when `APP_ENV === 'development'`. */
export const DEV_ACCOUNTS = [
  { email: 'owner@example.test', label: 'Owner' },
  { email: 'admin@example.test', label: 'Admin' },
  { email: 'member@example.test', label: 'Member' },
  { email: 'admin@rocketflare.local', label: 'Global admin' },
] as const

export default function Login() {
  const [searchParams] = useSearchParams()
  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'))
  const errorCode = searchParams.get('error')
  const { status } = useAuth()
  const { data: methods, isLoading: methodsLoading, isError: methodsError } = useAuthMethods()

  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const redirectTo = returnUrl === '/' ? undefined : returnUrl

  const devLogin = async (devEmail: string) => {
    setBusy(`dev:${devEmail}`)
    try {
      await api.post('/auth/dev-login', { email: devEmail, redirectTo })
      hardNavigate(returnUrl)
    } catch {
      setBusy(null)
    }
  }

  // `?as=` fires once (the ref survives StrictMode's double effect) and only for an allow-listed
  // account on a server that offers dev login — see the header comment.
  const asEmail = searchParams.get('as')
  const autoLoginFired = useRef(false)
  const autoLoginEmail =
    methods?.devLogin && DEV_ACCOUNTS.some(account => account.email === asEmail) ? asEmail : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: devLogin is recreated every render; the effect keys on the email only
  useEffect(() => {
    if (!autoLoginEmail || status === 'authenticated' || autoLoginFired.current) return
    autoLoginFired.current = true
    void devLogin(autoLoginEmail)
  }, [autoLoginEmail, status])

  if (status === 'authenticated') return <Navigate to={returnUrl} replace />

  const forInvitation = returnUrl.startsWith('/invite/')

  const signInWith = (provider: string) => {
    setBusy(provider)
    hardNavigate(`/auth/${provider}?returnUrl=${encodeURIComponent(returnUrl)}`)
  }

  const requestMagicLink = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    const parsed = magicLinkRequestSchema.safeParse({ email, redirectTo })
    if (!parsed.success) {
      setFieldError(fieldErrorFor(parsed.error.issues, 'email') ?? 'Enter a valid email address')
      return
    }
    setFieldError(undefined)
    setBusy('magic-link')
    try {
      await api.post('/auth/magic-link/request', parsed.data satisfies MagicLinkRequest, {
        showErrorToast: false,
      })
      setSentTo(parsed.data.email)
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : 'Could not send the link')
    } finally {
      setBusy(null)
    }
  }

  if (sentTo) {
    return (
      <AuthCard>
        <MagicLinkSentCard email={sentTo} onReset={() => setSentTo(null)} />
      </AuthCard>
    )
  }

  const providers = methods?.providers ?? []
  const nothingConfigured =
    methods && !methods.magicLink && providers.length === 0 && !methods.devLogin

  return (
    <AuthCard>
      <h1 className="text-lg font-semibold mb-1">Sign in</h1>
      <p className="text-sm text-secondary mb-5">
        {forInvitation
          ? 'Sign in to accept your invitation.'
          : 'Use your work account to continue.'}
      </p>

      {errorCode && (
        <div className="alert alert-error mb-4 text-sm" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
          <span>{LOGIN_ERROR_COPY[errorCode] ?? GENERIC_LOGIN_ERROR}</span>
        </div>
      )}

      {methodsLoading && <SkeletonRows rows={3} />}
      {methodsError && (
        <div className="alert alert-warning text-sm" role="alert">
          <span>Couldn't load sign-in options. Refresh to try again.</span>
        </div>
      )}
      {nothingConfigured && (
        <p className="text-sm text-secondary">
          No sign-in method is configured on this server. Set up an OAuth provider or email.
        </p>
      )}

      {providers.length > 0 && (
        <div className="space-y-2">
          {providers.map(provider => {
            const Icon = PROVIDER_ICONS[provider]
            return (
              <button
                key={provider}
                type="button"
                className="btn btn-outline w-full justify-start gap-3 font-normal"
                disabled={busy !== null}
                onClick={() => signInWith(provider)}
              >
                {busy === provider ? <LoadingIndicator size="sm" /> : <Icon className="w-5 h-5" />}
                Continue with {PROVIDER_LABELS[provider]}
              </button>
            )
          })}
        </div>
      )}

      {methods?.magicLink && (
        <>
          {providers.length > 0 && <div className="divider text-xs text-muted">or</div>}
          <form onSubmit={requestMagicLink} className="space-y-3" noValidate>
            <div>
              <label htmlFor="login-email" className="label text-sm">
                Email address
              </label>
              <label className="input w-full flex items-center gap-2">
                <EnvelopeIcon className="w-4 h-4 text-muted" />
                <input
                  id="login-email"
                  type="email"
                  className="grow"
                  placeholder="you@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={busy !== null}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? 'login-email-error' : undefined}
                />
              </label>
              <FieldError id="login-email-error" message={fieldError} />
            </div>
            {submitError && (
              <div className="alert alert-error text-sm" role="alert">
                <span>{submitError}</span>
              </div>
            )}
            <button type="submit" className="btn btn-primary w-full" disabled={busy !== null}>
              {busy === 'magic-link' ? <LoadingIndicator size="sm" /> : 'Email me a sign-in link'}
            </button>
          </form>
        </>
      )}

      {methods?.devLogin && (
        <div className="mt-6 border-t border-dashed border-[color:var(--border-subtle)] pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Dev quick login
          </p>
          <div className="grid grid-cols-2 gap-2">
            {DEV_ACCOUNTS.map(account => (
              <button
                key={account.email}
                type="button"
                className="btn btn-sm btn-outline font-normal"
                title={account.email}
                disabled={busy !== null}
                onClick={() => devLogin(account.email)}
              >
                {busy === `dev:${account.email}` ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  account.label
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </AuthCard>
  )
}
