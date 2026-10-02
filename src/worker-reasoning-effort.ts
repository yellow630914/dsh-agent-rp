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

/** The ladder a provider profile may declare, least thinking first. */
const EFFORT_ESCALATION = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Order declared efforts by how little the model will think, declared order breaking ties. */
function leastThinking(declared: readonly string[]): string | undefined {
  const rank = (effort: string): number => {
    const known = EFFORT_ESCALATION.indexOf(effort)
    return known < 0 ? EFFORT_ESCALATION.length + declared.indexOf(effort) : known
  }
  return [...declared].sort((left, right) => rank(left) - rank(right))[0]
}

/**
 * Decide what one Worker may send, from the exact model's declared capability.
 *
 * The LLM layer rejects an effort the model does not declare, so a Worker that
 * wants reasoning off cannot simply ask for it. Nor can it just leave the field
 * out: a provider may reject a request that names no effort exactly as firmly —
 * Z.ai answers `this model always engages in thinking and cannot be disabled;
 * please use low, high, or max`. So the fallback is the least thinking the
 * model does accept, and omitting is reserved for a model that declares no
 * reasoning controls at all, where there is no level to name.
 *
 * The fallback only ever goes down the ladder. A Worker's budget is sized for
 * little or no thinking, so silently raising the effort would spend the whole
 * completion on reasoning and return no answer at all; losing some depth is
 * both visible and recoverable, and a stalled turn is neither.
 *
 * `undefined` means the caller has no preference — the player left the control
 * on "model default" — which is normally expressed by omitting the field. That
 * is only safe where the model declares `off`: an adapter may render an absent
 * effort as an explicit disable on the wire, and a model that always thinks
 * refuses that exactly as it refuses `off`. So on such a model even "no
 * preference" has to name a level, and it names the least.
 * @param reasoning - the model's declared reasoning controls, if it has any.
 * @param requested - the effort this Worker would prefer, or `undefined` for none.
 * @returns the request fragment, and whether reasoning is actually off.
 */
export function acceptWorkerReasoningEffort(
  reasoning: LlmModelReasoningInfo | undefined,
  requested: string | undefined,
): WorkerReasoningEffort {
  const declared = reasoning?.efforts.map(effort => String(effort.id)) ?? []
  const omittable = declared.length === 0 || declared.includes('off')
  const effort = requested === undefined
    ? (omittable ? undefined : leastThinking(declared))
    : (declared.includes(requested) ? requested : leastThinking(declared))
  return effort === undefined
    ? { config: {}, reasoningOff: false }
    : { config: { reasoningEffort: ReasoningEffortId(effort) }, reasoningOff: effort === 'off' }
}

/**
 * Resolve one Worker's reasoning controls against its exact provider route.
 *
 * A capability lookup that fails resolves to "nothing declared", which omits
 * the field and reserves budget for reasoning. A Worker must not fail its
 * whole turn because the model catalogue was briefly unreadable.
 * @param ctx - Host context owning the LLM service.
 * @param route - the exact provider and model this Worker dispatches to.
 * @param requested - the effort this Worker would prefer, or `undefined` for none.
 * @param signal - optional cancellation for the capability lookup.
 * @returns the request fragment, and whether reasoning is actually off.
 */
export async function negotiateWorkerReasoningEffort(
  ctx: Context,
  route: Pick<GenerateOptions, 'provider' | 'model'>,
  requested: string | undefined,
  signal?: AbortSignal,
): Promise<WorkerReasoningEffort> {
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    .then(resolved => resolved.reasoning)
    .catch(() => undefined)
  return acceptWorkerReasoningEffort(info, requested)
}
