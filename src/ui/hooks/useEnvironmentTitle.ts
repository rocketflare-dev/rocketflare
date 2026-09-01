import { useEffect } from 'react'
import { getEnvironmentMarker } from '@/ui/lib/environment'
import { useAppInfo } from './useAppInfo'

/**
 * Keeps `document.title` prefixed with `[staging] ` / `[dev] ` on non-production deployments,
 * whatever a page later sets the title to. Observes `<title>` mutations and re-applies the
 * prefix idempotently. Mounted once, in `Layout`.
 */
export function useEnvironmentTitle() {
  const { env } = useAppInfo()
  const prefix = getEnvironmentMarker(env)?.titlePrefix

  useEffect(() => {
    if (!prefix) return

    const apply = () => {
      if (!document.title.startsWith(prefix)) document.title = `${prefix}${document.title}`
    }

    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length)
    }
  }, [prefix])
}
