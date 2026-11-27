import { useEffect } from 'react'
import { useAppInfo } from '@/ui/hooks/useAppInfo'

/** Points the page's icon at the deployment's `APP_FAVICON_URL`. Mounted once, in `App`. */
export function BrandFavicon() {
  const { faviconUrl } = useAppInfo()

  useEffect(() => {
    if (!faviconUrl) return
    const existing = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    const link = existing ?? document.head.appendChild(document.createElement('link'))
    link.rel = 'icon'
    link.removeAttribute('type')
    link.href = faviconUrl
  }, [faviconUrl])

  return null
}
