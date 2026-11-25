/**
 * `/cli/confirm`: where `GET /auth/cli` lands a signed-in person. Nothing is created until the
 * button is pressed: the confirming POST mints the key and answers the loopback URL, and the page
 * navigates there. Cancel stops here and tells the person to end the waiting command.
 */
import { CommandLineIcon } from '@heroicons/react/24/outline'
import { cliConfirmResponseSchema } from '@rocketflare/shared/auth'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { hardNavigate } from '@/ui/lib/navigation'

/** The port of a loopback callback, or null when the URL is not one. */
function loopbackPort(redirectUri: string | null): string | null {
  if (!redirectUri) return null
  try {
    const url = new URL(redirectUri)
    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      ? url.port || '80'
      : null
  } catch {
    return null
  }
}

export default function CliConfirm() {
  const [searchParams] = useSearchParams()
  const { user, tenant, logout } = useAuth()
  const redirectUri = searchParams.get('redirect_uri')
  const hostname = searchParams.get('hostname') ?? undefined
  const state = searchParams.get('state') ?? undefined
  const port = useMemo(() => loopbackPort(redirectUri), [redirectUri])
  const [phase, setPhase] = useState<'idle' | 'working' | 'cancelled' | 'failed'>('idle')

  const approve = async () => {
    setPhase('working')
    try {
      const { redirectTo } = await api.post(
        '/auth/cli/confirm',
        { redirectUri, hostname, state },
        { schema: cliConfirmResponseSchema }
      )
      hardNavigate(redirectTo)
    } catch {
      setPhase('failed')
    }
  }

  return (
    <AuthCard footer={user ? <SignedInAs email={user.email} onSignOut={() => logout()} /> : null}>
      <div className="text-center">
        <CommandLineIcon className="w-10 h-10 mx-auto mb-3 text-primary" />
        {phase === 'cancelled' ? (
          <>
            <h1 className="text-lg font-semibold mb-1">Sign-in cancelled</h1>
            <p className="text-sm text-secondary">
              No key was created. You can close this tab and stop the command in your terminal.
            </p>
          </>
        ) : port === null ? (
          <>
            <h1 className="text-lg font-semibold mb-1">This link is not valid</h1>
            <p className="text-sm text-secondary">
              Run the sign-in command in your terminal again.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold mb-1">Sign in to the command line?</h1>
            <p className="text-sm text-secondary mb-5">
              This creates an API key with your access to <strong>{tenant?.name}</strong>
              {hostname ? (
                <>
                  {' '}
                  named <strong>cli:{hostname}</strong>
                </>
              ) : null}{' '}
              and gives it to the program listening on port <strong>{port}</strong> of this
              computer. Only continue if you just ran the sign-in command.
            </p>
            {phase === 'failed' ? (
              <p className="text-sm text-error mb-3">Could not create the key. Try again.</p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost flex-1"
                disabled={phase === 'working'}
                onClick={() => setPhase('cancelled')}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={phase === 'working'}
                onClick={approve}
              >
                {phase === 'working' ? 'Creating key…' : 'Continue'}
              </button>
            </div>
          </>
        )}
      </div>
    </AuthCard>
  )
}
