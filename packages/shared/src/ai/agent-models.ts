/**
 * Per-agent model assignment contracts (D17): point one registry prompt key at a specific tenant
 * `ai_configs` row and/or model. Absence of a row = the tenant default (and its model); a row with
 * `aiConfigId: null` keeps the default config and overrides only the model. Reverting is a
 * `DELETE`, never a sentinel. `resolveChat(..., { promptKey })` is the ONLY runtime reader.
 */
import { z } from 'zod'
import { aiProviderSchema } from './config'
import { promptKeySchema } from './prompts'

export const agentModelAssignmentSchema = z.object({
  promptKey: promptKeySchema,
  /** A tenant chat config id, or null = the tenant's default chat config. */
  aiConfigId: z.string().uuid().nullable(),
  /** A model id served by that config's provider, or null = the config's own model. */
  model: z.string().nullable(),
  updatedAt: z.coerce.date(),
})
export type AgentModelAssignment = z.infer<typeof agentModelAssignmentSchema>

/** `PUT /api/ai/agent-models/:promptKey` — at least one of the two must be set. */
export const upsertAgentModelRequestSchema = z
  .object({
    aiConfigId: z.string().uuid().nullable().optional(),
    model: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .refine(v => (v.aiConfigId ?? null) !== null || (v.model ?? null) !== null, {
    message: 'Set aiConfigId, model, or both (DELETE reverts to the default)',
  })
export type UpsertAgentModelRequest = z.infer<typeof upsertAgentModelRequestSchema>

export const agentModelSourceSchema = z.enum(['assignment', 'tenant', 'platform', 'none'])
export type AgentModelSource = z.infer<typeof agentModelSourceSchema>

/** One registered prompt key with what `resolveChat` would pick for it right now. */
export const agentModelEntrySchema = z.object({
  promptKey: promptKeySchema,
  title: z.string(),
  assignment: agentModelAssignmentSchema.nullable(),
  effective: z.object({
    source: agentModelSourceSchema,
    provider: aiProviderSchema.optional(),
    model: z.string().optional(),
    configId: z.string().uuid().optional(),
  }),
})
export type AgentModelEntry = z.infer<typeof agentModelEntrySchema>

export const agentModelsListResponseSchema = z.object({ items: z.array(agentModelEntrySchema) })
export type AgentModelsListResponse = z.infer<typeof agentModelsListResponseSchema>
