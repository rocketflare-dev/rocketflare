/**
 * "Check your email" (D11). Rendered inline by Login after a successful request and at
 * `/magic-link/sent?email=` for deep links. Verification itself is a server redirect.
 */
import { CheckCircleIcon } from '@heroicons/react/24/outline'
import { Link, useSearchParams } from 'react-router-dom'
import { AuthCard } from '@/ui/components/AuthCard'

export function MagicLinkSentCard({
  email,
  onReset,
}: {
  email: string | null
  onReset?: () => void
}) {
  return (
    <div className="text-center">
      <CheckCircleIcon className="w-10 h-10 mx-auto mb-3 text-success" />
      <h1 className="text-lg font-semibold mb-1">Check your email</h1>
      <p className="text-sm text-secondary">
        We sent a sign-in link
        {email ? (
          <>
            {' '}
            to <span className="font-medium text-base-content">{email}</span>
          </>
        ) : null}
        . It expires shortly — open it on this device.
      </p>
      <p className="text-xs text-muted mt-4">
        Nothing arrived? Check spam, or{' '}
        {onReset ? (
          <button type="button" className="link link-hover" onClick={onReset}>
            try another address
          </button>
        ) : (
          <Link to="/login" className="link link-hover">
            request a new link
          </Link>
        )}
        .
      </p>
    </div>
  )
}

export default function MagicLinkSent() {
  const [searchParams] = useSearchParams()
  return (
    <AuthCard>
      <MagicLinkSentCard email={searchParams.get('email')} />
    </AuthCard>
  )
}
