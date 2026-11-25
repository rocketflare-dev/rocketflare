/**
 * What a model id implies about the request body. Providers change the rules per model, not
 * per provider: Claude 4.7+ refuses `temperature`, Opus 5.5 refuses `thinking: disabled` and a
 * forced `tool_choice`, Sonnet 5.5 turns thinking down with `between_tools` instead. The adapters
 * (`services/ai/client.ts`) build bodies from these traits and the settings form reads them to
 * decide which thinking controls to show, so the two cannot disagree.
 *
 * Pure parsing of the id, no network. A model the parser does not recognise as an older one is
 * treated as the NEWEST generation — the most restrictive shape, which every current model accepts
 * — because the next release is far likelier to follow the latest rules than to undo them. The
 * adapters still retry once without the offending field on a 400 that names it, so an id this file
 * misreads costs one refused call, not a broken config.
 *
 * Checked against the providers' docs on `MODEL_TRAITS_CHECKED`.
 */

/** When the rules below were last checked against the vendors' docs, ISO date. */
export const MODEL_TRAITS_CHECKED = '2026-10-13'

/**
 * How a model thinks:
 * - `none`: no thinking control at all (send nothing).
 * - `extended`: the manual `{ type: 'enabled', budget_tokens }` mode (Claude 4.5 and earlier).
 * - `adaptive`: `{ type: 'adaptive' }`, depth steered by effort (Claude 4.6+); `budget_tokens` is
 *   refused from 4.7 on, so a stored budget is ignored rather than sent.
 * - `effort`: OpenAI reasoning models — `reasoning.effort`, no switch.
 */
export type ThinkingMode = 'none' | 'extended' | 'adaptive' | 'effort'

/**
 * What "thinking off" becomes on the wire:
 * - `disabled`: `{ type: 'disabled' }`.
 * - `between_tools`: Sonnet 5.5's lowest setting — no up-front thinking, short notes between tools.
 * - `omit`: the model always thinks and refuses `disabled`; send no `thinking` field.
 * - `lowest_effort`: OpenAI — the lowest `reasoning.effort` the model takes.
 */
export type ThinkingOff = 'disabled' | 'between_tools' | 'omit' | 'lowest_effort'

export interface ModelTraits {
  thinking: ThinkingMode
  thinkingOff: ThinkingOff
  /** Thinking runs when the config leaves it off — the model cannot be told not to. */
  thinksAnyway: boolean
  /** Accepts a FORCED `tool_choice` (`any` / a named tool). False → ask in the prompt instead. */
  forcedToolChoice: boolean
  /** Accepts a non-default `temperature` / `top_p` / `top_k`. */
  sampling: boolean
}

const PERMISSIVE: ModelTraits = {
  thinking: 'none',
  thinkingOff: 'omit',
  thinksAnyway: false,
  forcedToolChoice: true,
  sampling: true,
}

// ---- Anthropic -----------------------------------------------------------------------------------

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'

export interface ClaudeModelId {
  family: ClaudeFamily | 'unknown'
  /** `major + minor / 10` — `claude-sonnet-4-5` → 4.5; `claude-opus-5` → 5. Null for a preview. */
  version: number | null
  /** Pre-4 naming (`claude-3-5-sonnet-…`) — every rule below predates it. */
  legacy: boolean
}

const FAMILIES = new Set<string>(['opus', 'sonnet', 'haiku', 'fable', 'mythos'])

/**
 * `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`, with a Bedrock `anthropic.` prefix tolerated.
 * Minor is one or two digits; eight digits is a snapshot date.
 */
export function parseClaudeModel(model: string): ClaudeModelId {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/^anthropic\./, '')
  const parts = id.split('-')
  if (parts[0] !== 'claude') return { family: 'unknown', version: null, legacy: false }
  if (/^\d+$/.test(parts[1] ?? '')) return { family: 'unknown', version: null, legacy: true }
  const family = FAMILIES.has(parts[1] ?? '') ? (parts[1] as ClaudeFamily) : 'unknown'
  const major = parts[2] && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null
  if (major === null) return { family, version: null, legacy: false }
  const minor = parts[3] && /^\d{1,2}$/.test(parts[3]) ? Number(parts[3]) : 0
  return { family, version: major + minor / 10, legacy: false }
}

/** A version at or above the newest one the rules below were written against. */
const NEWEST = 5.5

/**
 * The Claude rules, from the vendor's per-model thinking table (thinking-troubleshooting) and the
 * sampling / forced-tool notes in the thinking guide.
 */
export function anthropicModelTraits(model: string): ModelTraits {
  const { family, version, legacy } = parseClaudeModel(model)
  if (legacy) return { ...PERMISSIVE, thinking: 'extended', thinkingOff: 'disabled' }
  // Unrecognised or a preview: assume the newest generation's rules (see the module comment).
  const v = version ?? Number.POSITIVE_INFINITY
  const unknown = family === 'unknown' || version === null

  if (!unknown && v < 4.6) {
    // Opus/Sonnet/Haiku 4.5 and the retired 4.x: extended thinking only, everything else allowed.
    return { ...PERMISSIVE, thinking: 'extended', thinkingOff: 'disabled' }
  }

  const alwaysOn =
    unknown ||
    family === 'fable' ||
    family === 'mythos' ||
    (family === 'opus' && v >= 5.5) ||
    v > NEWEST
  const thinkingOff: ThinkingOff = alwaysOn
    ? 'omit'
    : family === 'sonnet' && v >= 5.5
      ? 'between_tools'
      : 'disabled'
  return {
    thinking: 'adaptive',
    thinkingOff,
    thinksAnyway: alwaysOn,
    forcedToolChoice: !(
      unknown ||
      v > NEWEST ||
      ((family === 'opus' || family === 'sonnet') && v >= 5.5) ||
      ((family === 'fable' || family === 'mythos') && v >= 5.1)
    ),
    sampling:
      !unknown &&
      v <= NEWEST &&
      !(family === 'fable' || family === 'mythos') &&
      !(family === 'opus' && v >= 4.7) &&
      !(family === 'sonnet' && v >= 5) &&
      !(family === 'haiku' && v >= 5.5),
  }
}

// ---- OpenAI --------------------------------------------------------------------------------------

/** `reasoning.effort` values, lowest first. Not every model takes every one. */
export const OPENAI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number]

/**
 * OpenAI reasoning models: the o-series and GPT-5 onwards. They take `reasoning.effort` and refuse
 * `temperature` while reasoning; `gpt-4.1` / `gpt-4o` take no reasoning field at all.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (/^o\d/.test(id)) return true
  const match = /^gpt-(\d+)/.exec(id)
  if (!match) return false
  return Number(match[1]) >= 5
}

/**
 * The lowest effort a reasoning model takes — what "thinking off" sends. `gpt-6-astra` and
 * `gpt-6.1-sol` refuse `none` (their model pages); the o-series and GPT-5.0–5.x predate it. The
 * adapter steps up to `low` on a 400 that names the effort, so a model missing here costs one call.
 */
export function openAiLowestEffort(model: string): OpenAiReasoningEffort {
  const id = model.trim().toLowerCase()
  if (/^gpt-6-astra/.test(id) || /^gpt-6\.1-sol/.test(id)) return 'low'
  if (/^o\d/.test(id) || /^gpt-5(\.[0-5])?(-|$)/.test(id)) return 'low'
  return 'none'
}

export function openAiModelTraits(model: string): ModelTraits {
  if (!isOpenAiReasoningModel(model)) return PERMISSIVE
  return {
    thinking: 'effort',
    thinkingOff: 'lowest_effort',
    // `low` still reasons; `none` does not.
    thinksAnyway: openAiLowestEffort(model) !== 'none',
    forcedToolChoice: true,
    sampling: false,
  }
}

// ---- Per provider --------------------------------------------------------------------------------

/**
 * The traits for a `(provider, model)` pair — what the adapter sends and what the settings form
 * offers. `anthropic_compatible` vendors serve their OWN models behind Anthropic's wire format, so
 * they keep the original contract (explicit `disabled`, `enabled` + budget) rather than Claude's.
 */
export function modelTraits(provider: string, model: string): ModelTraits {
  switch (provider) {
    case 'anthropic':
      return anthropicModelTraits(model)
    case 'anthropic_compatible':
      return { ...PERMISSIVE, thinking: 'extended', thinkingOff: 'disabled' }
    case 'openai':
      return openAiModelTraits(model)
    default:
      return PERMISSIVE
  }
}
