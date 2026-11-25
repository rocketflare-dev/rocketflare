/**
 * `storage()` — the one body behind every plugin context's method of that name.
 *
 * `RequestCtx`, the background contexts (`JobCtx`, `CronCtx`, `EmailCtx`, `PublicCtx`), `AgentCtx`
 * and `ToolCtx` all answer the same `StorageService` over the `FILES` bucket, so a plugin's own
 * service function that takes a `StorageService` is callable from any of them. Keys are the
 * plugin's to build, under `tenants/<tenantId>/<plugin id>/…`: the tenant prefix is what the
 * `tenant.purge` job deletes, so an object anywhere else outlives its organisation.
 *
 * A missing binding is a 503 `storage_not_configured` — loud, because a silently absent bucket
 * loses bytes.
 */

import { createR2Storage, type StorageService } from '../../api/services/storage'
import { ServiceUnavailableError } from '../../api/utils/core/errors'

export function filesStorage(env: { FILES?: R2Bucket }): StorageService {
  if (!env.FILES) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return createR2Storage(env.FILES)
}
