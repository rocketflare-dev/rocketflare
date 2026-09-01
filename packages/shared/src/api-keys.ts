/**
 * API key contracts (D12, D13). The plaintext appears exactly once, in `createApiKeyResponseSchema`;
 * every list/read uses `apiKeySchema`, which carries only the prefix.
 */
import { z } from 'zod'

export const apiKeyScopeSchema = z.enum(['read', 'write'])
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  createdByUserId: z.string().uuid(),
  lastUsedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(apiKeyScopeSchema).min(1).default(['read', 'write']),
  /** Omit for a non-expiring key. */
  expiresAt: z.coerce.date().nullable().optional(),
})
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>

export const createApiKeyResponseSchema = apiKeySchema.extend({
  /** The full plaintext key — shown once, never retrievable again. */
  key: z.string(),
})
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>
