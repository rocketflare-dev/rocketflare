/**
 * "Finish signing in" (D11) at `/magic-link/confirm?token=`. `GET /auth/magic-link/verify` — the
 * link in the email — redirects here WITHOUT consuming the token, so a mail security scanner that
 * fetches the link on delivery cannot spend it. The token is consumed only when a person presses
 * the button: a NATIVE form post (not `fetch`) to `POST /auth/magic-link/verify`, so the server's
 * cookie + redirect answer (success or `/login?error=`) is followed exactly as the old GET was.
 * Never auto-submit: a scanner that runs scripts would sign in for the person again.
 */
import { EnvelopeOpenIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '@/ui/components/AuthCard'

export default function MagicLinkConfirm() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const redirectTo = searchParams.get('redirectTo')
  const [submitting, setSubmitting] = useState(false)

  if (!token) return <Navigate to="/login?error=invalid_token" replace />

  return (
    <AuthCard>
      <div className="text-center">
        <EnvelopeOpenIcon className="w-10 h-10 mx-auto mb-3 text-primary" />
        <h1 className="text-lg font-semibold mb-1">Finish signing in</h1>
        <p className="text-sm text-secondary mb-5">Continue to sign in with your email link.</p>
        <form method="post" action="/auth/magic-link/verify" onSubmit={() => setSubmitting(true)}>
          <input type="hidden" name="token" value={token} />
          {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}
          <button type="submit" className="btn btn-primary w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </AuthCard>
  )
}
