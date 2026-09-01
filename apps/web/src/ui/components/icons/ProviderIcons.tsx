/**
 * OAuth provider marks (D11), drawn in `currentColor` so they follow the theme like every other
 * icon — no brand hex in the UI (ui.md "tokens, not raw colours").
 */
import type { OAuthProviderName } from '@rocketflare/shared/auth'
import type { ComponentType } from 'react'

interface IconProps {
  className?: string
}

export function GoogleIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.23c1.9-1.74 2.97-4.32 2.97-7.34Z" />
      <path
        d="M12 21.6c2.7 0 4.97-.9 6.63-2.42l-3.23-2.5c-.9.6-2.04.95-3.4.95-2.61 0-4.82-1.76-5.62-4.13H3.05v2.58A9.99 9.99 0 0 0 12 21.6Z"
        opacity=".8"
      />
      <path d="M6.38 13.5a6 6 0 0 1 0-3.8V7.12H3.05a10 10 0 0 0 0 8.96l3.33-2.58Z" opacity=".6" />
      <path
        d="M12 6.37c1.47 0 2.79.5 3.83 1.5l2.86-2.86A9.98 9.98 0 0 0 3.05 7.12l3.33 2.58c.8-2.37 3.01-4.13 5.62-4.13Z"
        opacity=".9"
      />
    </svg>
  )
}

export function MicrosoftIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="9.5" height="9.5" />
      <rect x="12.5" y="2" width="9.5" height="9.5" opacity=".8" />
      <rect x="2" y="12.5" width="9.5" height="9.5" opacity=".6" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" opacity=".9" />
    </svg>
  )
}

export const PROVIDER_ICONS: Record<OAuthProviderName, ComponentType<IconProps>> = {
  google: GoogleIcon,
  microsoft: MicrosoftIcon,
}

export const PROVIDER_LABELS: Record<OAuthProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
}
