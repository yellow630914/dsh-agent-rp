/** Reasoning-control negotiation for the background Workers' own requests. */

import type { Context } from '@deepseek-ai/cordis'
import {
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelReasoningInfo,
} from '@deepseek-ai/dsh-llm'

/** What one Worker may actually send, and what that costs its completion budget. */
export interface WorkerReasoningEffort {
  /** Spread into `GenerateOptions`: the accepted field, or nothing at all. */
  readonly config: Partial<Pick<GenerateOptions, 'reasoningEffort'>>
  /**
   * Whether the dispatch is guaranteed not to spend completion budget on
   * reasoning. Callers size `maxTokens` from this rather than from what they
   * asked for: a dropped effort leaves the model thinking at its own default,
   * and reasoning shares the budget with the answer.
   */
  readonly reasoningOff: boolean
}

/**
 * Decide what one Worker may send, from the exact model's declared capability.
 *
 * The LLM layer rejects an effort the model does not declare, and a model that
 * declares no reasoning at all rejects *every* effort — including `off`. So a
 * Worker that wants reasoning off cannot simply ask for it: against such a
 * model the only acceptable request is one that omits the field entirely.
 * @param reasoning - the model's declared reasoning controls, if it has any.
 * @param requested - the effort this Worker would prefer.
 * @returns the request fragment, and whether reasoning is actually off.
 */
export function acceptWorkerReasoningEffort(
  reasoning: LlmModelReasoningInfo | undefined,
  requested: string,
): WorkerReasoningEffort {
  if (reasoning?.efforts.some(effort => String(effort.id) === requested) !== true) {
    return { config: {}, reasoningOff: false }
  }
  return { config: { reasoningEffort: ReasoningEffortId(requested) }, reasoningOff: requested === 'off' }
}

/**
 * Resolve one Worker's reasoning controls against its exact provider route.
 *
 * A capability lookup that fails resolves to "nothing declared", which omits
 * the field and reserves budget for reasoning. A Worker must not fail its
 * whole turn because the model catalogue was briefly unreadable.
 * @param ctx - Host context owning the LLM service.
 * @param route - the exact provider and model this Worker dispatches to.
 * @param requested - the effort this Worker would prefer.
 * @param signal - optional cancellation for the capability lookup.
 * @returns the request fragment, and whether reasoning is actually off.
 */
export async function negotiateWorkerReasoningEffort(
  ctx: Context,
  route: Pick<GenerateOptions, 'provider' | 'model'>,
  requested: string,
  signal?: AbortSignal,
): Promise<WorkerReasoningEffort> {
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    .then(resolved => resolved.reasoning)
    .catch(() => undefined)
  return acceptWorkerReasoningEffort(info, requested)
}
