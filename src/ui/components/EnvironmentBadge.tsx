import { BeakerIcon } from '@heroicons/react/24/solid'
import { useState } from 'react'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { getEnvironmentMarker } from '@/ui/lib/environment'

/**
 * "Dev" / "Staging" badge in the header on non-production deployments, driven by the `env`
 * field of `/api/health` (D4) — not the hostname, since the same bundle is served everywhere.
 * Click hides it for the tab's lifetime (clean screenshots); a reload restores it.
 */
export function EnvironmentBadge({ className = '' }: { className?: string }) {
  const { env } = useAppInfo()
  const [hidden, setHidden] = useState(false)
  const marker = getEnvironmentMarker(env)
  if (!marker || hidden) return null

  return (
    <button
      type="button"
      onClick={() => setHidden(true)}
      title={`${marker.label} environment — click to hide`}
      className={`badge badge-sm ${marker.badgeClassName} gap-1 font-semibold uppercase tracking-wider cursor-pointer ${className}`}
      data-env={marker.env}
    >
      <BeakerIcon className="w-3 h-3" />
      {marker.label}
    </button>
  )
}
