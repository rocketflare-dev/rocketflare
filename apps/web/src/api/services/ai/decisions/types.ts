/**
 * The decisions seam: one interface both engines answer — TypeSafe's Jev (`typesafe.ts`) and
 * the chat-model fallback (`llm.ts`). `ctx.decide` (services/agents) codes against this and never
 * against a vendor, exactly as the tool loop codes against `ChatClient`.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import type {
  DecisionAnswers,
  DecisionMethod,
  DecisionRequest,
} from '@rocketflare/shared/ai/decisions'

export interface DecisionResult {
  /** One answer per question id in the request — engines throw rather than return a partial set. */
  answers: DecisionAnswers
  usage: TokenUsage
  /** The model that answered, as the engine reports it (`jev-1.13.0` for `jev-latest`). */
  model: string
}

export interface DecisionClient {
  readonly provider: AiProvider
  readonly method: DecisionMethod
  ask(
    request: DecisionRequest,
    opts: { model: string; signal?: AbortSignal }
  ): Promise<DecisionResult>
}
