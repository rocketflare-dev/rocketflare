/**
 * "Check your email". Rendered inline by Login after a successful request and at
 * `/magic-link/sent?email=` for deep links. The emailed link lands on `/magic-link/confirm`.
 */
import { useSearchParams } from 'react-router'
import { AuthCard } from '@/ui/components/AuthCard'
import { MagicLinkSentCard } from '@/ui/components/MagicLinkSentCard'

export default function MagicLinkSent() {
  const [searchParams] = useSearchParams()
  return (
    <AuthCard>
      <MagicLinkSentCard email={searchParams.get('email')} />
    </AuthCard>
  )
}
