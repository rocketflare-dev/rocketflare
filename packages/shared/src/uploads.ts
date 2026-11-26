/**
 * Direct-to-storage uploads: the bytes never pass through the Worker. Three steps, the same for
 * every kind of upload (an avatar, a generic file, a knowledge document, a plugin's own):
 *
 *   1. `POST /api/uploads` — `{ target, name, contentType, size, fields? }`. Every check the
 *      target makes (permission, type 415, size 413, configuration 503) runs HERE, before a byte is
 *      stored. The answer is a one-shot `PUT` URL and the headers to send with it.
 *   2. `PUT <url>` with the file as the body and exactly `headers`. The store refuses another type,
 *      another length, or a second write to the same key.
 *   3. `POST /api/uploads/:uploadId/confirm` — the server checks what arrived against what was
 *      declared and writes the target's rows. The answer is the TARGET's: a `files` row for
 *      `avatars` / `uploads`, the document for `documents`, a plugin's own body for its target.
 *
 * An upload that is never confirmed is deleted by the nightly prune.
 */
import { z } from 'zod'

/**
 * The kit's own targets. A plugin adds `<pluginId>.<name>` (its `uploadTargets`); the id is
 * namespaced exactly like its job types, so two plugins cannot collide and none can claim a core one.
 */
export const CORE_UPLOAD_TARGETS = ['avatars', 'uploads', 'documents'] as const
export type CoreUploadTarget = (typeof CORE_UPLOAD_TARGETS)[number]

/** A core target, or `<pluginId>.<name>` — lowercase, hyphenated segments. */
export const UPLOAD_TARGET_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/
export const uploadTargetSchema = z.string().regex(UPLOAD_TARGET_PATTERN, 'Unknown upload target')

/** How long the `PUT` URL stays valid. The store checks it when the request STARTS. */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60

/** `POST /api/uploads`. `fields` is the target's own (a document's title, visibility, groups…). */
export const createUploadRequestSchema = z.object({
  target: uploadTargetSchema,
  /** The client's filename; the server sanitises it before it goes anywhere. */
  name: z.string().min(1).max(255),
  /** What the client will send as `Content-Type`; a target may answer a canonical one to use instead. */
  contentType: z.string().max(255).default(''),
  size: z.number().int().nonnegative(),
  fields: z.record(z.string(), z.unknown()).optional(),
})
export type CreateUploadRequest = z.input<typeof createUploadRequestSchema>

export const createUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  method: z.literal('PUT'),
  /** The storage URL (or, locally, the Worker's own). Absolute. */
  url: z.string().url(),
  /**
   * Send exactly these with the `PUT`. They are part of the signature: another value is refused.
   * `Content-Length` is signed too but is never listed — a browser sets it from the body and may
   * not set it itself.
   */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.coerce.date(),
})
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>

/** `uploadId` → the confirm path. */
export const confirmUploadPath = (uploadId: string): string =>
  `/api/uploads/${encodeURIComponent(uploadId)}/confirm`
