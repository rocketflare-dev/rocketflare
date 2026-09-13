/**
 * File storage contracts (D23): the `files` row the API returns, the upload response, and the
 * limits the UI checks BEFORE uploading so the server's 413/415 are a backstop, not the UX.
 * Objects live in R2 under `tenants/<tenantId>/<scope>/…`; the browser only ever sees `/api/files/:id`.
 */
import { z } from 'zod'

/**
 * Where an upload goes and what may be uploaded there. Extend per app. `documents` holds the
 * originals behind the knowledge base (D18): created and deleted through `/api/ai/documents`,
 * downloadable at `/api/files/:id`, never deleted directly (409 `owned_by_document`).
 */
export const FILE_SCOPES = ['avatars', 'uploads', 'documents'] as const
export const fileScopeSchema = z.enum(FILE_SCOPES)
export type FileScope = z.infer<typeof fileScopeSchema>

/** 5 MB — enough for an avatar or a document; raise per scope if an app needs more. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** The `avatars` scope accepts only these (checked against the declared `Content-Type`). */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number]

export function isAvatarMimeType(type: string): type is AvatarMimeType {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(type)
}

/**
 * Types `GET /api/files/:id` serves with `Content-Disposition: inline` — everything else
 * downloads, so a stored `text/html` or SVG can never execute script on this origin. A PDF is
 * safe here because the browser hands it to its own viewer, which does not run the file's script
 * in this document's context.
 */
export const INLINE_MIME_TYPES = [...AVATAR_MIME_TYPES, 'application/pdf'] as const
export type InlineMimeType = (typeof INLINE_MIME_TYPES)[number]

export function isInlineMimeType(type: string): type is InlineMimeType {
  return (INLINE_MIME_TYPES as readonly string[]).includes(type)
}

/**
 * Types a response may additionally be FRAMED as (`X-Frame-Options: SAMEORIGIN` + CSP
 * `frame-ancestors 'self'` — see `middleware/security-headers.ts`), which is what lets the
 * document viewer embed a PDF in the page. **Deliberately a SECOND list**: inline and framable are
 * not the same property, and an app adding an `INLINE_MIME_TYPES` entry must not silently make it
 * framable too. The app shell itself stays `frame-ancestors 'none'`.
 */
export const EMBEDDABLE_MIME_TYPES = ['application/pdf'] as const
export type EmbeddableMimeType = (typeof EMBEDDABLE_MIME_TYPES)[number]

export function isEmbeddableMimeType(type: string): type is EmbeddableMimeType {
  return (EMBEDDABLE_MIME_TYPES as readonly string[]).includes(type)
}

/** The download URL for a stored file — the same string the API writes into `users.avatarUrl`. */
export const filePath = (id: string): string => `/api/files/${id}`

export const fileSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  scope: fileScopeSchema,
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** `/api/files/:id` — tenant-scoped, cookie/Bearer authenticated. */
  url: z.string(),
  createdAt: z.coerce.date(),
})
export type StoredFile = z.infer<typeof fileSchema>

/** `POST /api/files?scope=` → 201 with the row. */
export const uploadResponseSchema = fileSchema
export type UploadResponse = z.infer<typeof uploadResponseSchema>

export const uploadQuerySchema = z.object({
  scope: fileScopeSchema.default('uploads'),
})
export type UploadQuery = z.infer<typeof uploadQuerySchema>
