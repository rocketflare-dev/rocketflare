import { useEffect } from 'react'
import { useAppInfo } from '@/ui/hooks/useAppInfo'

function pointIconAt(url: string) {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  const link = existing ?? document.head.appendChild(document.createElement('link'))
  link.rel = 'icon'
  link.removeAttribute('type')
  link.href = url
}

/** Points the page's icon at the deployment's `APP_FAVICON_URL` once it has loaded as an image. */
export function BrandFavicon() {
  const { faviconUrl } = useAppInfo()

  useEffect(() => {
    if (!faviconUrl) return
    const probe = new Image()
    probe.onload = () => pointIconAt(faviconUrl)
    probe.src = faviconUrl
    return () => {
      probe.onload = null
    }
  }, [faviconUrl])

  return null
}
