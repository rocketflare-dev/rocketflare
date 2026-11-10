/**
 * Putting text into the knowledge base from a plugin — how a connector makes a
 * synced message, event or file something chat and agents can retrieve.
 *
 * These are the core ingest paths (`services/ai/ingest.ts`) behind a plugin-shaped signature:
 * a `PluginContext` rather than `(db, cfg, env, …, deps)`, so they work the same from a route, a
 * job, a cron task or a public webhook. Three things they add over a plain insert:
 *
 * - **`externalId` makes ingest idempotent.** The same `(tenantId, source, externalId)` again
 *   UPDATES the row — text, title, owner, visibility and grants — and re-indexes it, so a sync can
 *   replay a page of results without duplicating anything. Namespace `source` with the plugin id
 *   (`m365:mail`), because uniqueness is per source.
 * - **Group ids are checked against the tenant** before anything is written: a sync that maps an
 *   upstream group to the wrong organisation's group fails here rather than sharing a document
 *   across tenants.
 * - **Visibility is the caller's decision, and the default is the whole organisation.** Something
 *   synced from ONE person's mailbox must say so: the owner's `userId` + `visibility: 'groups'` +
 *   `groupIds: []` is owner-and-admins-only. Note the "and admins" — an org admin can read
 *   what was synced from anybody's mailbox, and a connector should tell its installer that.
 *
 * **Platform documents** (`ingestPlatformDocument`, `prunePlatformDocuments`) are the other kind:
 * tenant-less content about the APP (a user guide), readable by every organisation, written only
 * from a job or a cron task on the owner connection and always embedded by the platform embedder.
 * They are found only by a search that names their source (`searchKnowledge`'s `platformSources`,
 * or `ServerPlugin.knowledgeSources` for the kit's `search_knowledge` tool) and never appear in a
 * tenant's document list, viewer or `get_document`.
 *
 * This module belongs to the `feature-knowledge` surface: an app that deleted the knowledge base
 * deletes this file and its line in `./index.ts`, and a plugin that ingests declares
 * `requires.surfaces: ["feature-knowledge"]`.
 */

import { resolveDocumentUploadType, SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import type { ResourceVisibility } from '@rocketflare/shared/groups'
import { and, eq, inArray } from 'drizzle-orm'
import {
  ConversionNotConfiguredError,
  deleteExternalDocument,
  type IngestResult,
  ingestFile,
  ingestText,
} from '../../api/services/ai/ingest'
import {
  ingestPlatformText,
  type PlatformDocumentResult,
  PlatformEmbeddingsError,
  prunePlatformText,
} from '../../api/services/ai/platform-documents'
import { createR2Storage, type StorageService } from '../../api/services/storage'
import { ApiError, BadRequestError, ServiceUnavailableError } from '../../api/utils/core/errors'
import { groups } from '../../db/schema/groups'
import type { AccessScope } from './access'
import type { CronCtx, JobCtx } from './jobs'
import type { PluginContext } from './types'

interface IngestCommon {
  tenantId: string
  /** `<plugin id>:<kind>` — `m365:mail`. Required: it is what an `externalId` is unique within. */
  source: string
  /** The item's id upstream. Omit only for a one-off document nothing will ever update. */
  externalId?: string
  title?: string
  /** Defaults to `tenant`. See the module comment before syncing anybody's private data. */
  visibility?: ResourceVisibility
  /** Only with `visibility: 'groups'`; each must be a group of `tenantId`. */
  groupIds?: readonly string[]
}

export interface PluginIngestTextInput extends IngestCommon {
  /** The app user this belongs to (matched from the upstream owner), or null for the organisation. */
  userId: string | null
  title: string
  text: string
  contentType?: string
}

export interface PluginIngestFileInput extends IngestCommon {
  /** Required for a file: a stored original always has an owner (it cascades from the user). */
  userId: string
  file: Blob
  /** Drives the media type (with `file.type`), the default title and the storage key. */
  filename: string
}

/** What an ingest answers. `queued` means a `document.index` / `document.convert` job finishes it. */
export interface PluginIngestResult {
  documentId: string
  mode: IngestResult['mode']
  status: IngestResult['document']['status']
}

function toResult({ document, mode }: IngestResult): PluginIngestResult {
  return { documentId: document.id, mode, status: document.status }
}

async function checkGroups(ctx: PluginContext, input: IngestCommon): Promise<void> {
  const ids = [...new Set(input.groupIds ?? [])]
  if (ids.length === 0) return
  if (input.visibility !== 'groups') {
    throw new BadRequestError(
      'groupIds is only meaningful with visibility "groups"',
      'invalid_visibility'
    )
  }
  const found = await ctx.db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, input.tenantId), inArray(groups.id, ids)))
  if (found.length !== ids.length) {
    throw new BadRequestError('A group id does not belong to this organisation', 'group_not_found')
  }
}

function optionalStorage(ctx: PluginContext): StorageService | null {
  return ctx.env.FILES ? createR2Storage(ctx.env.FILES) : null
}

/**
 * Index text. Small texts are indexed before this returns; larger ones return `queued`. No
 * embeddings provider → 503 `ai_not_configured`, checked before anything is written.
 */
export async function ingestDocument(
  ctx: PluginContext,
  input: PluginIngestTextInput
): Promise<PluginIngestResult> {
  await checkGroups(ctx, input)
  const result = await ingestText(
    ctx.db,
    ctx.config,
    ctx.env,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      title: input.title,
      text: input.text,
      source: input.source,
      externalId: input.externalId,
      contentType: input.contentType,
      visibility: input.visibility,
      groupIds: input.groupIds,
    },
    { jobs: ctx.env.JOBS_QUEUE, storage: optionalStorage(ctx) }
  )
  return toResult(result)
}

/**
 * Store a file in R2 and index it — text-like types now, binary ones (PDF, Office…) through the
 * `document.convert` job. Unsupported type → 415 `unsupported_media_type`; no `FILES` binding →
 * 503 `storage_not_configured`; a binary type with no converter → 503 `conversion_not_configured`.
 */
export async function ingestDocumentFile(
  ctx: PluginContext,
  input: PluginIngestFileInput
): Promise<PluginIngestResult> {
  const type = resolveDocumentUploadType(input.filename, input.file.type)
  if (!type) {
    throw new ApiError(
      415,
      `Unsupported document type: ${input.filename}`,
      'unsupported_media_type',
      {
        contentType: input.file.type || null,
        filename: input.filename,
      }
    )
  }
  const storage = optionalStorage(ctx)
  if (!storage) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  await checkGroups(ctx, input)
  try {
    const result = await ingestFile(
      ctx.db,
      ctx.config,
      ctx.env,
      {
        tenantId: input.tenantId,
        userId: input.userId,
        file: input.file,
        filename: input.filename,
        type,
        title: input.title,
        source: input.source,
        externalId: input.externalId,
        visibility: input.visibility,
        groupIds: input.groupIds,
      },
      { jobs: ctx.env.JOBS_QUEUE, storage }
    )
    return toResult(result)
  } catch (err) {
    if (err instanceof ConversionNotConfiguredError) {
      throw new ServiceUnavailableError(err.message, 'conversion_not_configured')
    }
    throw err
  }
}

/** The item is gone upstream: delete its document, chunks, grants and stored original. */
export async function deleteIngestedDocument(
  ctx: PluginContext,
  input: { tenantId: string; source: string; externalId: string }
): Promise<boolean> {
  return deleteExternalDocument(ctx.db, input, { storage: optionalStorage(ctx) })
}

// ---- Platform documents ----------------------------------------------------------------------

/**
 * A plugin source: `<plugin id>:<kind>` (`guide:page`). The id half follows the plugin id rule
 * (`^[a-z][a-z0-9-]*$`), and `kit` is the core namespace, never a plugin's.
 */
const PLUGIN_SOURCE = /^([a-z][a-z0-9-]*):\S.*$/

/** The plugin id a source is namespaced with, or a 400 `invalid_source`. */
function sourceNamespace(source: string): string {
  const id = PLUGIN_SOURCE.exec(source)?.[1]
  if (!id || id === 'kit') {
    throw new BadRequestError(
      `A plugin source is "<plugin id>:<kind>" (got "${source}")`,
      'invalid_source'
    )
  }
  return id
}

/**
 * A WRITE names the installed plugin it belongs to. Read at call time through a dynamic import —
 * the server barrel imports every plugin, and every plugin imports this module.
 */
async function requireInstalledNamespace(source: string): Promise<void> {
  const id = sourceNamespace(source)
  const { serverPlugins } = await import('../server')
  if (!serverPlugins.some(p => p.shared.id === id)) {
    throw new BadRequestError(
      `"${source}" is not namespaced with an installed plugin's id`,
      'invalid_source'
    )
  }
}

/** Only a job or a cron task writes platform documents: no request, webhook or mail handler. */
function requireBackground(ctx: JobCtx | CronCtx, what: string): void {
  if (ctx.kind !== 'job' && ctx.kind !== 'cron') {
    throw new Error(`${what} runs only from a JobCtx or a CronCtx`)
  }
}

export interface PlatformDocumentInput {
  /** `<plugin id>:<kind>` — the plugin's own id; refused otherwise. */
  source: string
  /** The document's stable id within `source` (a guide page's path). */
  externalId: string
  title: string
  /** Markdown or plain text. */
  text: string
}

export type { PlatformDocumentResult }
/** 503 `platform_embeddings_not_configured` — `ingestPlatformDocument` with no platform embedder. */
export { PlatformEmbeddingsError }

/**
 * Write (or re-write) a PLATFORM document — one every tenant can read, describing the app itself.
 * Only from a job or a cron task (`JobCtx | CronCtx`), on the owner connection, embedded
 * synchronously by the PLATFORM embedder (`EMBEDDINGS_API_KEY`, else the `[ai]` binding).
 *
 * - No platform embedder → throws `PlatformEmbeddingsError` (503
 *   `platform_embeddings_not_configured`) and writes nothing: a platform chunk always has a vector.
 *   An embeddings failure also throws with nothing written — the previous revision stays.
 * - Idempotent on `(source, externalId)`: the same title and text, already embedded by today's
 *   model, is `unchanged` (no embeddings call); anything else replaces the text and every chunk.
 * - `source` must be namespaced with an installed plugin's id (400 `invalid_source`).
 *
 * Everything written here is readable by EVERY organisation: never put tenant data in one.
 */
export async function ingestPlatformDocument(
  ctx: JobCtx | CronCtx,
  input: PlatformDocumentInput
): Promise<PlatformDocumentResult> {
  requireBackground(ctx, 'ingestPlatformDocument')
  await requireInstalledNamespace(input.source)
  return ingestPlatformText(ctx.db, ctx.config, ctx.env, input)
}

/**
 * Delete the platform documents of `source` whose `externalId` is not in `keepExternalIds` —
 * what a sync calls after ingesting the current set. Answers the number deleted; an empty keep
 * list deletes the whole source. Same context and namespace rules as `ingestPlatformDocument`.
 */
export async function prunePlatformDocuments(
  ctx: JobCtx | CronCtx,
  input: { source: string; keepExternalIds: readonly string[] }
): Promise<number> {
  requireBackground(ctx, 'prunePlatformDocuments')
  await requireInstalledNamespace(input.source)
  return prunePlatformText(ctx.db, input)
}

// ---- Search ----------------------------------------------------------------------------------

export interface SearchKnowledgeInput {
  query: string
  /** Passages to return, 1..`SEARCH_MAX_LIMIT` (default 10). */
  limit?: number
  /** Narrow the caller's TENANT documents to these sources; `[]` = no tenant documents. */
  sources?: readonly string[]
  /** Also search these PLATFORM sources (each `<plugin id>:<kind>`). */
  platformSources?: readonly string[]
  signal?: AbortSignal
}

export interface SearchKnowledgeHit {
  documentId: string
  source: string | null
  externalId: string | null
  title: string
  /** The whole passage. */
  text: string
  /** Passage n of its document, from 0. */
  seq: number
  charOffset: number | null
  /** RRF score — higher is better, not a similarity. */
  score: number
  denseRank: number | null
  lexicalRank: number | null
  /** A platform document (readable by every tenant), not one of this organisation's. */
  platform: boolean
}

export interface SearchKnowledgeResult {
  hits: SearchKnowledgeHit[]
  /** `unavailable` = some corpus was searched by keyword only (no embedder for it). */
  semantic: 'used' | 'unavailable'
}

/**
 * The kit's hybrid knowledge search, for a plugin: the caller's tenant documents as its
 * `AccessScope` may read them (narrowed by `sources`), plus — only when named — the platform
 * documents of `platformSources`. Works from any context carrying a scope (`RequestCtx`, `ToolCtx`,
 * `DetachedCtx`). A missing embedder degrades to keyword search (`semantic: 'unavailable'`)
 * rather than a 503.
 */
export async function searchKnowledge(
  ctx: Pick<PluginContext, 'db' | 'config' | 'env'> & { scope: AccessScope },
  input: SearchKnowledgeInput
): Promise<SearchKnowledgeResult> {
  for (const source of input.platformSources ?? []) sourceNamespace(source)
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), SEARCH_MAX_LIMIT)
  // Loaded at CALL time: `retrieval.ts` reaches the plugin barrel through `../access`, and a static
  // import here would put the barrel on `@/plugins/api`'s load path (see `ai/fusion.ts`).
  const { searchKnowledgeChunks } = await import('../../api/services/ai/retrieval')
  const { hits, semantic } = await searchKnowledgeChunks(
    ctx.db,
    ctx.config,
    ctx.env,
    ctx.scope,
    {
      query: input.query,
      limit,
      sources: input.sources,
      platformSources: input.platformSources,
      signal: input.signal,
    },
    { lexicalFallback: true }
  )
  return {
    semantic,
    hits: hits.map(h => ({
      documentId: h.documentId,
      source: h.source,
      externalId: h.externalId,
      title: h.title,
      text: h.text,
      seq: h.seq,
      charOffset: h.charOffset,
      score: h.score,
      denseRank: h.denseRank,
      lexicalRank: h.lexicalRank,
      platform: h.platform,
    })),
  }
}
