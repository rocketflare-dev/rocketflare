import { z } from 'zod'

export const LOGIN_PANEL_ARTS = ['rocket', 'type'] as const
export type LoginPanelArt = (typeof LOGIN_PANEL_ARTS)[number]
export const loginPanelArtSchema = z.enum(LOGIN_PANEL_ARTS)

export const TAGLINE_MAX_LENGTH = 200

export const taglineSchema = z
  .string()
  .trim()
  .min(1)
  .max(TAGLINE_MAX_LENGTH)
  .refine(value => !/[\r\n]/.test(value), 'must be a single line')

/** `https:` or a root-relative path only: the value becomes an `<img src>` and an icon `href`. */
export function isBrandAssetUrl(value: string): boolean {
  if (/[\s\\]/.test(value)) return false
  if (value.startsWith('/')) return !value.startsWith('//')
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export const brandAssetUrlSchema = z
  .string()
  .trim()
  .refine(
    isBrandAssetUrl,
    'must be an https:// URL or a root-relative path such as /brand/logo.svg'
  )

/** The branding `GET /api/health` carries; an absent field means the bundled fallback. */
export const brandingSchema = z.object({
  name: z.string().min(1),
  tagline: taglineSchema.optional(),
  loginPanelArt: loginPanelArtSchema.optional(),
  logoUrl: brandAssetUrlSchema.optional(),
  faviconUrl: brandAssetUrlSchema.optional(),
})
export type Branding = z.infer<typeof brandingSchema>
