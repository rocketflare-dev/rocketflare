/**
 * Prompt registry contracts (D17): a prompt is a code-level definition (`PROMPT_REGISTRY` in
 * `apps/web/src/api/services/prompts.ts`) that a tenant may override; absence of an override row
 * means "use the default". Variables are `{{name}}` placeholders the server interpolates from
 * context (`appName`, `tenantName`, `userName`, ...) — no templating engine.
 */
import { z } from 'zod'

/** Kebab-case registry key, e.g. `chat`, `summarize-text`. */
export const promptKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Prompt keys are kebab-case')
export type PromptKey = z.infer<typeof promptKeySchema>

/** Max characters an override may hold. */
export const PROMPT_MAX_LENGTH = 20_000

/** UI-safe metadata for one registry entry. */
export const promptDefinitionSchema = z.object({
  key: promptKeySchema,
  title: z.string(),
  description: z.string(),
  /** `{{variable}}` names the default text (and any override) may reference. */
  variables: z.array(z.string()),
  defaultText: z.string(),
})
export type PromptDefinition = z.infer<typeof promptDefinitionSchema>

/** The registry TYPE — the registry itself lives server-side. */
export type PromptRegistry = Record<string, PromptDefinition>

export const promptOverrideSchema = z.object({
  tenantId: z.string().uuid(),
  key: promptKeySchema,
  text: z.string(),
  updatedByUserId: z.string().uuid().nullable(),
  updatedAt: z.coerce.date(),
})
export type PromptOverride = z.infer<typeof promptOverrideSchema>

/** `PUT /api/ai/prompts/:key` — set the override; `DELETE` reverts to the default. */
export const updatePromptRequestSchema = z.object({
  text: z.string().trim().min(1).max(PROMPT_MAX_LENGTH),
})
export type UpdatePromptRequest = z.infer<typeof updatePromptRequestSchema>

/** One prompt as the settings page sees it: definition + override (if any) + what runs. */
export const promptWithResolvedSchema = z.object({
  definition: promptDefinitionSchema,
  override: promptOverrideSchema.nullable(),
  isOverridden: z.boolean(),
  /** `override.text ?? definition.defaultText` — variables NOT interpolated (this is the editor view). */
  effectiveText: z.string(),
})
export type PromptWithResolved = z.infer<typeof promptWithResolvedSchema>

export const promptListResponseSchema = z.object({ items: z.array(promptWithResolvedSchema) })
export type PromptListResponse = z.infer<typeof promptListResponseSchema>

/** `{{name}}` → `vars[name]`; unknown placeholders are left in place so a typo is visible. */
export function interpolatePrompt(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : match
  )
}
