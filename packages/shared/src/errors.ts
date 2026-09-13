import { z } from 'zod'

/**
 * The ONE error envelope every API response uses — from `app.onError`, `notFound`, the
 * zValidator hook, and `ApiError` thrown in routes. The UI's `api-client.ts` parses this
 * into `ApiError` so callers can branch on `code`.
 */
export const apiErrorSchema = z.object({
  /** Short human-readable summary, e.g. "Forbidden" */
  error: z.string(),
  statusCode: z.number().int(),
  /** Machine-readable discriminator, e.g. "pending_approval", "validation_failed" */
  code: z.string().optional(),
  /** Field-level or structured detail (zod issues, etc.) */
  details: z.unknown().optional(),
})

export type ApiErrorBody = z.infer<typeof apiErrorSchema>

/** Well-known `code` values shared by API and UI. Extend per app. */
export const ERROR_CODES = {
  validationFailed: 'validation_failed',
  unauthorized: 'unauthorized',
  sessionExpired: 'session_expired',
  forbidden: 'forbidden',
  notFound: 'not_found',
  conflict: 'conflict',
  rateLimited: 'rate_limited',
  pendingApproval: 'pending_approval',
  noTenant: 'no_tenant',
  tenantSuspended: 'tenant_suspended',
  blocked: 'blocked',
  tenancyModeSingle: 'tenancy_mode_single',
  csrf: 'csrf_failed',
  /** 503: no chat/embeddings provider resolves for the tenant (D17). */
  aiNotConfigured: 'ai_not_configured',
  /** 503: the `AGENT_RUN_WORKFLOW` binding is missing, so a run cannot be started (D7). */
  agentRunsNotConfigured: 'agent_runs_not_configured',
  /** 409: `?strict=1` and an active run already exists for an exclusive agent (D7). */
  agentRunActive: 'agent_run_active',
  /** 404: `POST /api/agui/run` was given a `threadId` that exists but is not this user's. */
  aguiThreadNotFound: 'agui_thread_not_found',
  /** 400: the last message of a `RunAgentInput` was not a user turn. */
  aguiLastMessageNotUser: 'agui_last_message_not_user',
  /** 400: `RunAgentInput.tools` was non-empty — frontend tools are not supported. */
  aguiClientToolsUnsupported: 'agui_client_tools_unsupported',
  /** 400: the user turn's content was not a usable string. */
  aguiUnsupportedContent: 'agui_unsupported_content',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
