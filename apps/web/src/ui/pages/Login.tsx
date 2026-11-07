/**
 * Sign in. Everything is driven by `GET /auth/methods`: OAuth buttons for the configured
 * providers (full-page redirect to `/auth/:provider`), a magic-link form (validated with the SAME
 * `magicLinkRequestSchema` the server uses), and — only when the server says `devLogin` — the
 * seeded quick-login accounts. Server-side failures arrive as `?error=<code>`.
 *
 * `oidcOnly` (`AUTH_OIDC_ONLY`): the page shows the one SSO button and nothing else. It never
 * redirects to the issuer on its own — signing in is always a click, so an issuer session that is
 * still live (or a sign-out) never turns into a silent login or a loop.
 * The other methods are hidden, not disabled: the magic-link endpoint stays live for invitations.
 *
 * `pluginMethods` (an installed plugin's SSO, `ServerPlugin.loginMethods`) render as buttons that
 * navigate (full page) to the method's `startPath` with `?returnUrl=`, behind an email field sent
 * as `&email=` when the method `askEmail`s. Shown under `oidcOnly` too — they are single sign-on.
 *
 * `?error=sso_required&method=<plugin id>:<method id>` (the address's domain requires single
 * sign-on — `ServerPlugin.ssoPolicy`): the method named, when `pluginMethods` has it, is offered
 * directly under the message, its email field prefilled from `?email=` (only the "use single
 * sign-on" email carries that, and it goes to the address itself). The label shown is the one
 * `/auth/methods` gives, never text from the URL. Dev login answering 403 `sso_required` lands on
 * the same screen.
 *
 * `?error=<plugin id>.<name>` (a plugin's own failure — its sign-in route redirecting here): the copy
 * is the method's `errors[code]` from `/auth/methods`, and `?email=` prefills THAT method's field,
 * so "fix it and try again" is one click. An unknown code shows the generic line.
 *
 * `?as=<email>` (what `pnpm bootstrap` opens) signs in through the same dev-login call once on
 * mount. Threat model: this is login-CSRF against a dev-only route that already 404s outside
 * `APP_ENV=development`; the page honours it ONLY when the server reports `devLogin` AND the email
 * is one of `DEV_ACCOUNTS` — an arbitrary address in the URL does nothing.
 */

import { EnvelopeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import {
  type MagicLinkRequest,
  magicLinkRequestSchema,
  type OAuthProviderName,
  type PluginLoginMethod,
} from '@rocketflare/shared/auth'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { AuthCard } from '@/ui/components/AuthCard'
import { PROVIDER_ICONS, providerLabel } from '@/ui/components/icons/ProviderIcons'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { MagicLinkSentCard } from '@/ui/components/MagicLinkSentCard'
import { FieldError, fieldErrorFor, SkeletonRows } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useAuthMethods } from '@/ui/hooks/useAuthMethods'
import { ApiError, api } from '@/ui/lib/api-client'
import { hardNavigate, safeReturnUrl } from '@/ui/lib/navigation'

/** Friendly copy per `?error=` code the auth routes redirect with. */
export const LOGIN_ERROR_COPY: Record<string, string> = {
  invalid_token: "That sign-in link isn't valid. Request a new one below.",
  expired: 'That sign-in link has expired. Request a new one below.',
  not_invited: "There's no invitation for that email address. Ask an administrator to invite you.",
  blocked: 'This account has been blocked. Contact an administrator.',
  oidc_only: 'This organisation signs in through single sign-on only.',
  no_access:
    "You don't have access to this app. Ask your organisation's administrator to grant it, then sign in again.",
  account_exists:
    'An account with this email already exists. Sign in the way you usually do, or ask an administrator to connect single sign-on to it.',
  sso_required:
    'Your organisation requires single sign-on for this email address. Sign in with it to continue.',
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
  const [searchParams, setSearchParams] = useSearchParams()
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
    } catch (error) {
      setBusy(null)
      if (error instanceof ApiError && error.code === ERROR_CODES.ssoRequired) {
        const method = (error.details as { method?: unknown } | undefined)?.method
        const next = new URLSearchParams({ error: ERROR_CODES.ssoRequired })
        if (typeof method === 'string') next.set('method', method)
        if (redirectTo) next.set('returnUrl', redirectTo)
        setSearchParams(next, { replace: true })
      }
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

  // OIDC-only: the one SSO button, never an automatic redirect (see the header comment).
  const oidcOnly = methods?.oidcOnly === true && (methods.providers ?? []).includes('oidc')

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

  const providers: OAuthProviderName[] = oidcOnly ? ['oidc'] : (methods?.providers ?? [])
  const showMagicLink = Boolean(methods?.magicLink) && !oidcOnly
  const pluginMethods = methods?.pluginMethods ?? []
  const ssoMethod =
    errorCode === ERROR_CODES.ssoRequired
      ? pluginMethods.find(method => method.id === searchParams.get('method'))
      : undefined
  // A plugin's own error code: its method supplies the copy and gets the email back.
  const errorOwner = errorCode
    ? pluginMethods.find(method => method.errors?.[errorCode] !== undefined)
    : undefined
  // A code only a plugin knows waits for /auth/methods, so its copy never flashes the generic line.
  const errorCopy = errorCode
    ? (LOGIN_ERROR_COPY[errorCode] ??
      errorOwner?.errors?.[errorCode] ??
      (methodsLoading ? null : GENERIC_LOGIN_ERROR))
    : null
  // The method offered under the message is not repeated in the list (one email field per method).
  const otherPluginMethods = pluginMethods.filter(method => method !== ssoMethod)
  const nothingConfigured =
    methods &&
    !methods.magicLink &&
    providers.length === 0 &&
    pluginMethods.length === 0 &&
    !methods.devLogin

  return (
    <AuthCard>
      <h1 className="text-lg font-semibold mb-1">Sign in</h1>
      <p className="text-sm text-secondary mb-5">
        {forInvitation
          ? 'Sign in to accept your invitation.'
          : 'Use your work account to continue.'}
      </p>

      {errorCopy && (
        <div className="alert alert-error mb-4 text-sm" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
          <span>{errorCopy}</span>
        </div>
      )}

      {ssoMethod && (
        <div className="mb-5 space-y-3" data-testid="sso-required-method">
          <PluginMethodButton
            method={ssoMethod}
            returnUrl={returnUrl}
            initialEmail={searchParams.get('email') ?? ''}
            disabled={busy !== null}
            busy={busy === `sso:${ssoMethod.id}`}
            onStart={() => setBusy(`sso:${ssoMethod.id}`)}
          />
          <div className="divider text-xs text-muted">or another account</div>
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
                Continue with {providerLabel(provider, methods)}
              </button>
            )
          })}
        </div>
      )}

      {otherPluginMethods.length > 0 && (
        <div className={`space-y-3${providers.length > 0 ? ' mt-3' : ''}`}>
          {otherPluginMethods.map(method => (
            <PluginMethodButton
              key={method.id}
              method={method}
              returnUrl={returnUrl}
              initialEmail={method === errorOwner ? (searchParams.get('email') ?? '') : undefined}
              disabled={busy !== null}
              busy={busy === `plugin:${method.id}`}
              onStart={() => setBusy(`plugin:${method.id}`)}
            />
          ))}
        </div>
      )}

      {showMagicLink && (
        <>
          {providers.length + otherPluginMethods.length > 0 && (
            <div className="divider text-xs text-muted">or</div>
          )}
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

/** One plugin-contributed method: a button, behind an email field when it `askEmail`s. */
function PluginMethodButton({
  method,
  returnUrl,
  initialEmail = '',
  disabled,
  busy,
  onStart,
}: {
  method: PluginLoginMethod
  returnUrl: string
  initialEmail?: string
  disabled: boolean
  busy: boolean
  onStart: () => void
}) {
  const [email, setEmail] = useState(initialEmail)
  const [error, setError] = useState<string | undefined>()
  const inputId = `login-plugin-${method.id.replace(/[^a-z0-9-]/g, '-')}`

  const start = (e?: React.FormEvent) => {
    e?.preventDefault()
    const params = new URLSearchParams({ returnUrl })
    if (method.askEmail) {
      const parsed = magicLinkRequestSchema.shape.email.safeParse(email)
      if (!parsed.success) {
        setError('Enter a valid email address')
        return
      }
      params.set('email', parsed.data)
    }
    setError(undefined)
    onStart()
    hardNavigate(`${method.startPath}?${params.toString()}`)
  }

  const button = (
    <button
      type={method.askEmail ? 'submit' : 'button'}
      className="btn btn-outline w-full justify-start gap-3 font-normal"
      disabled={disabled}
      onClick={method.askEmail ? undefined : () => start()}
    >
      {busy && <LoadingIndicator size="sm" />}
      {method.label}
    </button>
  )
  if (!method.askEmail) return button
  return (
    <form onSubmit={start} className="space-y-2" noValidate>
      <label htmlFor={inputId} className="label text-sm">
        Work email for {method.label}
      </label>
      <input
        id={inputId}
        type="email"
        className="input w-full"
        placeholder="you@company.com"
        autoComplete="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
      />
      <FieldError id={`${inputId}-error`} message={error} />
      {button}
    </form>
  )
}
