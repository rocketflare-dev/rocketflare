/**
 * `/consent?request=<id>`: where `/oauth/continue` lands a signed-in person whose AI client asked
 * to connect. Nothing is granted until Approve: the decision POST answers the client's redirect
 * (with a code, or `access_denied`), and the page navigates there.
 *
 * What the page is careful to say: the client's name and logo are what its metadata document
 * CLAIMS; the one verified fact is the host that document was fetched from, shown beside the
 * redirect host. A client that registers only loopback redirects runs on this computer — the page
 * says so, because a website pretending to be a desktop app is the phishing case.
 */
import { ExclamationTriangleIcon, LinkIcon } from '@heroicons/react/24/outline'
import {
  type ConsentDetails,
  consentDecisionResponseSchema,
  consentDetailsSchema,
} from '@rocketflare/shared/oauth'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { hardNavigate } from '@/ui/lib/navigation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center">
      <h1 className="text-lg font-semibold mb-1">{title}</h1>
      <p className="text-sm text-secondary">{body}</p>
    </div>
  )
}

export default function OAuthConsent() {
  const [searchParams] = useSearchParams()
  const { user, logout } = useAuth()
  const requestId = searchParams.get('request') ?? ''
  const valid = UUID.test(requestId)
  const details = useQuery({
    queryKey: ['oauth-consent', requestId],
    queryFn: () => api.get(`/oauth/consent/${requestId}`, { schema: consentDetailsSchema }),
    enabled: valid,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const footer = user ? <SignedInAs email={user.email} onSignOut={() => logout()} /> : null

  return (
    <AuthCard width="lg" footer={footer}>
      {!valid || details.isError ? (
        <Message
          title="This link is not valid"
          body="The connection request has expired or was already used. Start connecting again from your AI app."
        />
      ) : details.isPending ? (
        <LoadingIndicator size="lg" centered />
      ) : (
        <ConsentForm details={details.data} />
      )}
    </AuthCard>
  )
}

function ConsentForm({ details }: { details: ConsentDetails }) {
  const { organisations } = details
  const [tenantId, setTenantId] = useState(organisations[0]?.id ?? '')
  const [phase, setPhase] = useState<'idle' | 'working' | 'failed'>('idle')
  useEffect(() => {
    if (!organisations.some(o => o.id === tenantId)) setTenantId(organisations[0]?.id ?? '')
  }, [organisations, tenantId])
  const chosen = organisations.find(o => o.id === tenantId)
  const writes = details.scopes.includes('mcp:write')

  const decide = async (approve: boolean) => {
    setPhase('working')
    try {
      const { redirectTo } = await api.post(
        '/oauth/consent',
        approve
          ? { requestId: details.requestId, approve: true, tenantId }
          : { requestId: details.requestId, approve: false },
        { schema: consentDecisionResponseSchema }
      )
      hardNavigate(redirectTo)
    } catch {
      setPhase('failed')
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        {details.client.claimedLogoUri ? (
          <img
            src={details.client.claimedLogoUri}
            alt=""
            className="w-10 h-10 rounded"
            referrerPolicy="no-referrer"
          />
        ) : (
          <LinkIcon className="w-10 h-10 text-primary" />
        )}
        <h1 className="text-lg font-semibold">
          {details.client.claimedName} wants to use {details.appName} as you
        </h1>
      </div>

      <dl className="text-sm mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-secondary">Claims to be</dt>
        <dd>{details.client.claimedName}</dd>
        <dt className="text-secondary">Verified host</dt>
        <dd className="font-mono">{details.client.verifiedHost}</dd>
        <dt className="text-secondary">Returns to</dt>
        <dd className="font-mono">{details.redirectHost}</dd>
      </dl>

      {details.loopbackOnly ? (
        <div className="alert alert-warning text-sm mb-4">
          <ExclamationTriangleIcon className="w-5 h-5" />
          <span>
            This app runs on your computer, not as a website. Only continue if you just started
            connecting it yourself.
          </span>
        </div>
      ) : null}

      {organisations.length === 0 ? (
        <p className="text-sm text-secondary mb-4">
          {details.organisationFixed
            ? 'This connection is for an organisation where you cannot connect AI apps.'
            : 'None of your organisations lets you connect AI apps. Ask an admin to turn it on.'}
        </p>
      ) : (
        <>
          {details.singleTenant || details.organisationFixed || organisations.length === 1 ? (
            <p className="text-sm mb-3">
              Organisation: <strong>{chosen?.name}</strong>
            </p>
          ) : (
            <label className="form-control mb-3">
              <span className="label-text text-sm mb-1">Organisation</span>
              <select
                className="select select-bordered select-sm"
                value={tenantId}
                onChange={e => setTenantId(e.target.value)}
              >
                {organisations.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="text-sm mb-1">It will be able to:</p>
          <ul className="text-sm list-disc pl-5 mb-3">
            <li>read what you can read in {chosen?.name ?? 'the organisation'}</li>
            {writes ? <li>make changes as you</li> : null}
          </ul>

          {chosen && chosen.tools.length > 0 ? (
            <details className="text-sm mb-4">
              <summary className="cursor-pointer text-secondary">
                {chosen.tools.length} tool{chosen.tools.length === 1 ? '' : 's'} available
              </summary>
              <ul className="list-disc pl-5 mt-1">
                {chosen.tools.map(t => (
                  <li key={t.name}>
                    {t.title ?? t.name} <span className="text-secondary font-mono">{t.name}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {phase === 'failed' ? (
        <p className="text-sm text-error mb-3">Could not complete that. Try again.</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-ghost flex-1"
          disabled={phase === 'working'}
          onClick={() => decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={phase === 'working' || !chosen}
          onClick={() => decide(true)}
        >
          {phase === 'working' ? 'Connecting…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}
