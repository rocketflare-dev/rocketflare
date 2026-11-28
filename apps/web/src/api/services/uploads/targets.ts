/**
 * Upload targets: what each kind of upload checks before a byte is stored (`prepare`) and what it
 * writes once the bytes have arrived (`confirm`). The kit's three — `avatars`, `uploads`,
 * `documents` — and every installed plugin's `uploadTargets`, adapted to the same shape.
 *
 * `uploadTargets()` is a FUNCTION over the server barrel, read per call: a const would be
 * evaluated at import, and a plugin module importing this file back would find it half-built.
 */
import {
  type DocumentUploadType,
  type IngestDocumentResponse,
  resolveDocumentUploadType,
  uploadDocumentFieldsSchema,
} from '@rocketflare/shared/ai/embeddings'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import {
  AVATAR_MIME_TYPES,
  type FileScope,
  filePath,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
} from '@rocketflare/shared/files'
import type { CORE_UPLOAD_TARGETS } from '@rocketflare/shared/uploads'
import { eq } from 'drizzle-orm'
import type { ZodType } from 'zod'
import { users } from '../../../db/schema'
import type { PluginUploadTarget } from '../../../plugins/api/uploads'
import { serverUnits } from '../../../units/server'
import { guardPermission } from '../../middleware/permissions'
import type { AppContext } from '../../types'
import { ApiError, ServiceUnavailableError, ValidationError } from '../../utils/core/errors'
import { withAuthAndDb } from '../../utils/routes/route-helpers'
import { accessScopeOf, grantsForResources, resolveRequestedVisibility } from '../access'
import { recordActivity } from '../activity'
import { canConvert } from '../ai/convert'
import { ConversionNotConfiguredError, ingestFile, toDocument } from '../ai/ingest'
import { resolveEmbeddings } from '../ai/resolve'
import {
  buildStorageKey,
  deleteStoredFile,
  recordStoredFile,
  type StorageService,
  tenantStoragePrefix,
  toStoredFile,
} from '../storage'

export interface UploadPrepareInput {
  uploadId: string
  tenantId: string
  userId: string
  /** Sanitised. */
  filename: string
  /** Lowercased, parameters dropped; `''` when the client did not know. */
  contentType: string
  size: number
  fields: Record<string, unknown>
}

export interface PreparedUpload {
  key: string
  /** The type the client must send — the signature holds it to that. */
  contentType: string
  state?: Record<string, unknown>
}

export interface ConfirmedUpload {
  uploadId: string
  key: string
  filename: string
  contentType: string
  size: number
  state: Record<string, unknown>
  bucket: R2Bucket
  storage: StorageService
}

export interface UploadTarget {
  id: string
  /** The R2 binding the bytes go to. */
  binding: string
  /** The bucket's S3 name, for the presigned URL; undefined = not configured. */
  bucketName(c: AppContext): string | undefined
  maxBytes: number
  prepare(c: AppContext, input: UploadPrepareInput): Promise<PreparedUpload>
  confirm(c: AppContext, upload: ConfirmedUpload): Promise<{ status: 200 | 201; body: unknown }>
}

const FILES_BINDING = 'FILES'
const filesBucketName = (c: AppContext) => c.get('config').FILES_BUCKET_NAME

/** `''` / unknown → octet-stream, as the multipart route did with `file.type || …`. */
const orOctetStream = (type: string) => type || 'application/octet-stream'

// ---- avatars, uploads: a `files` row -----------------------------------------------------------

function fileTarget(scope: Extract<FileScope, 'avatars' | 'uploads'>): UploadTarget {
  return {
    id: scope,
    binding: FILES_BINDING,
    bucketName: filesBucketName,
    maxBytes: MAX_UPLOAD_BYTES,
    async prepare(c, input) {
      guardPermission(c, 'create', 'File')
      const contentType = orOctetStream(input.contentType)
      if (scope === 'avatars' && !isAvatarMimeType(contentType)) {
        throw new ApiError(
          415,
          'Avatars must be a PNG, JPEG, GIF or WebP image',
          'unsupported_media_type',
          { allowed: AVATAR_MIME_TYPES }
        )
      }
      const key = buildStorageKey({
        tenantId: input.tenantId,
        scope,
        name: input.filename,
        id: input.uploadId,
      })
      return { key, contentType }
    },
    async confirm(c, upload) {
      const { db, tenantId, user, defer } = withAuthAndDb(c)
      const row = await recordStoredFile(db, upload.storage, {
        tenantId,
        ownerUserId: user.id,
        scope,
        key: upload.key,
        filename: upload.filename,
        contentType: upload.contentType,
        sizeBytes: upload.size,
      })
      if (scope === 'avatars') {
        try {
          await db
            .update(users)
            .set({ avatarUrl: filePath(row.id) })
            .where(eq(users.id, user.id))
        } catch (err) {
          // Still no orphans: an avatar whose pointer could not be written is rolled back whole.
          await deleteStoredFile(db, upload.storage, row).catch(() => {})
          throw err
        }
      }
      defer(() =>
        recordActivity(db, {
          tenantId,
          userId: user.id,
          type: 'file.uploaded',
          subjectType: 'File',
          subjectId: row.id,
          metadata: {
            scope,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
            filename: row.filename,
          },
        })
      )
      return { status: 201, body: toStoredFile(row) }
    },
  }
}

// ---- documents: a knowledge document -----------------------------------------------------------

interface DocumentUploadState extends Record<string, unknown> {
  type: DocumentUploadType
  title?: string
  source?: string
  visibility: 'tenant' | 'groups'
  groupIds: string[]
}

const documentsTarget: UploadTarget = {
  id: 'documents',
  binding: FILES_BINDING,
  bucketName: filesBucketName,
  maxBytes: MAX_UPLOAD_BYTES,
  async prepare(c, input) {
    const { db, cfg, auth } = withAuthAndDb(c)
    guardPermission(c, 'create', 'Document')
    const type = resolveDocumentUploadType(input.filename, input.contentType)
    if (!type) {
      throw new ApiError(
        415,
        'Unsupported document type: upload a PDF, Word, Excel, OpenDocument, HTML, XML, CSV, JSON, Markdown or text file',
        'unsupported_media_type',
        { contentType: input.contentType || null, filename: input.filename }
      )
    }
    const fields = uploadDocumentFieldsSchema.safeParse(input.fields)
    if (!fields.success) throw new ValidationError(fields.error.issues, 'Invalid fields')
    const access = await resolveRequestedVisibility(db, accessScopeOf(auth), fields.data)
    // Everything that can 503 is checked HERE, before the client is handed a URL.
    await resolveEmbeddings(db, cfg, c.env, input.tenantId)
    if (type.kind === 'convert' && !canConvert(c.env)) throw conversionNotConfigured()
    const key = buildStorageKey({
      tenantId: input.tenantId,
      scope: 'documents',
      name: input.filename,
      id: input.uploadId,
    })
    const state: DocumentUploadState = {
      type,
      title: fields.data.title,
      source: fields.data.source,
      visibility: access.visibility,
      groupIds: [...access.groupIds],
    }
    return { key, contentType: type.contentType, state }
  },
  async confirm(c, upload) {
    const { db, tenantId, user, cfg, defer, tracer } = withAuthAndDb(c)
    const state = upload.state as DocumentUploadState
    let result: Awaited<ReturnType<typeof ingestFile>>
    try {
      result = await ingestFile(
        db,
        cfg,
        c.env,
        {
          tenantId,
          userId: user.id,
          file: {
            key: upload.key,
            size: upload.size,
            read: async () => {
              const object = await upload.storage.get(upload.key)
              if (!object) throw new Error(`uploads: ${upload.key} vanished before it was read`)
              return new Response(object.body).blob()
            },
          },
          filename: upload.filename,
          type: state.type,
          title: state.title,
          source: state.source,
          visibility: state.visibility,
          groupIds: state.groupIds,
        },
        { jobs: c.env.JOBS_QUEUE, storage: upload.storage, tracer }
      )
    } catch (err) {
      if (err instanceof ConversionNotConfiguredError) throw conversionNotConfigured()
      throw err
    }
    const { document, mode, deduplicated } = result
    if (!deduplicated) {
      defer(() =>
        recordActivity(db, {
          tenantId,
          userId: user.id,
          type: 'document.ingested',
          subjectType: 'Document',
          subjectId: document.id,
          metadata: {
            mode,
            status: document.status,
            chunkCount: document.chunkCount,
            contentType: document.contentType,
            sizeBytes: document.sizeBytes,
            fileId: document.fileId,
            visibility: document.visibility,
          },
        })
      )
    }
    const groups =
      (await grantsForResources(db, tenantId, 'document', [document.id])).get(document.id) ?? []
    const body: IngestDocumentResponse = { ...toDocument(document, groups), deduplicated }
    return { status: deduplicated ? 200 : 201, body }
  },
}

function conversionNotConfigured() {
  return new ServiceUnavailableError(
    'Document conversion is not configured on this server; upload text, Markdown, CSV or JSON instead',
    'conversion_not_configured'
  )
}

/** Keyed by the shared list: a core target missing here, or one too many, is a type error. */
const CORE_TARGETS: Record<(typeof CORE_UPLOAD_TARGETS)[number], UploadTarget> = {
  avatars: fileTarget('avatars'),
  uploads: fileTarget('uploads'),
  documents: documentsTarget,
}

// ---- plugin targets ------------------------------------------------------------------------------

/**
 * A plugin key must sit under the plugin's own prefix and name the upload, in plain segments: the
 * failed confirm, the expiry and the prune all delete the key the row records, so a key that could
 * name another plugin's object, or an object that predates this upload, is never accepted.
 */
export function pluginUploadKeyIssue(
  key: string,
  input: { tenantId: string; pluginId: string; uploadId: string }
): string | null {
  const prefix = `${tenantStoragePrefix(input.tenantId)}${input.pluginId}/`
  if (!key.startsWith(prefix)) return `is not under ${prefix}`
  if (!key.includes(input.uploadId)) return 'does not contain the upload id'
  if (key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    return 'has an empty, `.` or `..` segment'
  }
  return null
}

/** A plugin's declaration, adapted: its permission, its `RequestCtx`, its schema, its key rule. */
export function adaptPluginUploadTarget(
  pluginId: string,
  declared: PluginUploadTarget
): UploadTarget {
  const binding = declared.bucket?.binding ?? FILES_BINDING
  const fieldsSchema: ZodType | undefined = declared.fields
  return {
    id: declared.id,
    binding,
    bucketName: c =>
      declared.bucket ? declared.bucket.name(c.env) : c.get('config').FILES_BUCKET_NAME,
    maxBytes: declared.maxBytes,
    async prepare(c, input) {
      guardPermission(c, declared.permission.action, declared.permission.subject)
      const contentType = orOctetStream(input.contentType)
      if (declared.contentTypes && !declared.contentTypes.includes(contentType)) {
        throw new ApiError(
          415,
          'This type of file is not accepted here',
          'unsupported_media_type',
          {
            allowed: declared.contentTypes,
          }
        )
      }
      let fields: unknown = input.fields
      if (fieldsSchema) {
        const parsed = fieldsSchema.safeParse(input.fields)
        if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid fields')
        fields = parsed.data
      } else if (Object.keys(input.fields).length > 0) {
        throw new ValidationError([], 'This upload target takes no fields')
      }
      const { requestCtx } = await import('../../../plugins/api/http')
      const prepared = declared.prepare
        ? await declared.prepare(requestCtx(c), {
            uploadId: input.uploadId,
            filename: input.filename,
            contentType,
            size: input.size,
            fields,
          })
        : {}
      const key =
        prepared.key ??
        `${tenantStoragePrefix(input.tenantId)}${pluginId}/${input.uploadId}-${input.filename}`
      const issue = pluginUploadKeyIssue(key, {
        tenantId: input.tenantId,
        pluginId,
        uploadId: input.uploadId,
      })
      if (issue) {
        throw new ApiError(
          500,
          `Upload target ${declared.id} answered a storage key that ${issue}`,
          ERROR_CODES.uploadKeyInvalid
        )
      }
      return {
        key,
        contentType: prepared.contentType ?? contentType,
        state: prepared.state,
      }
    },
    async confirm(c, upload) {
      const { requestCtx } = await import('../../../plugins/api/http')
      const answer = await declared.confirm(requestCtx(c), {
        uploadId: upload.uploadId,
        key: upload.key,
        filename: upload.filename,
        contentType: upload.contentType,
        size: upload.size,
        state: upload.state,
        bucket: upload.bucket,
      })
      return { status: answer.status ?? 201, body: answer.body }
    },
  }
}

/** Every target id, core first — for the 400 `unknown_upload_target` details and the config test. */
export function uploadTargets(): Map<string, UploadTarget> {
  const out = new Map<string, UploadTarget>(Object.entries(CORE_TARGETS))
  for (const plugin of serverUnits) {
    for (const declared of plugin.uploadTargets ?? []) {
      out.set(declared.id, adaptPluginUploadTarget(plugin.shared.id, declared))
    }
  }
  return out
}
