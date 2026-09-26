/**
 * Putting text into the knowledge base from a plugin (D18, D31, D34) — how a connector makes a
 * synced message, event or file something chat and agents can retrieve.
 *
 * These are the kit's own ingest paths (`services/ai/ingest.ts`) behind a plugin-shaped signature:
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
 *   `groupIds: []` is owner-and-admins-only (D29). Note the "and admins" — an org admin can read
 *   what was synced from anybody's mailbox, and a connector should tell its installer that.
 *
 * This module belongs to the `feature-knowledge` surface: an app that deleted the knowledge base
 * deletes this file and its line in `./index.ts`, and a plugin that ingests declares
 * `requires.surfaces: ["feature-knowledge"]`.
 */

import { resolveDocumentUploadType } from '@rocketflare/shared/ai/embeddings'
import type { ResourceVisibility } from '@rocketflare/shared/groups'
import { and, eq, inArray } from 'drizzle-orm'
import {
  ConversionNotConfiguredError,
  deleteExternalDocument,
  type IngestResult,
  ingestFile,
  ingestText,
} from '../../api/services/ai/ingest'
import { createR2Storage, type StorageService } from '../../api/services/storage'
import { ApiError, BadRequestError, ServiceUnavailableError } from '../../api/utils/core/errors'
import { groups } from '../../db/schema/groups'
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
  /** The kit user this belongs to (matched from the upstream owner), or null for the organisation. */
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
