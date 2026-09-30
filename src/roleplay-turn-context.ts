/** Bind logged third-party plugin context to the exact Roleplay model step that consumed it. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { RoleplayExternalContextRead, RoleplayTurnPlan } from './roleplay-turn-plan.ts'

function exactStepStart(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
  beforeSeq: number,
): SessionEvent<'step/start'> {
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > events.length) {
    throw new Error('Roleplay external context boundary is invalid')
  }
  const starts = events.slice(0, beforeSeq).filter((event): event is SessionEvent<'step/start'> =>
    event.type === 'step/start' && event.data.turn === turn && event.data.step === step)
  if (starts.length !== 1) {
    throw new Error(`Roleplay external context requires one step boundary for ${String(turn)}:${String(step)}`)
  }
  return starts[0]!
}

/**
 * Reference every plugin-authored message in the final request boundary,
 * including retained snapshots from earlier turns. The Session event remains
 * the sole owner of its source metadata and private text.
 */
export function bindRoleplayExternalContext(input: {
  readonly plan: RoleplayTurnPlan
  readonly events: readonly SessionEvent[]
  readonly visibleMessages: readonly Message[]
  readonly turn: number
  readonly step: number
  readonly beforeSeq?: number
}): RoleplayTurnPlan {
  const beforeSeq = input.beforeSeq ?? input.events.length
  const start = exactStepStart(input.events, input.turn, input.step, beforeSeq)
  if (start.seq < input.plan.input.sessionSeq) {
    throw new Error('Roleplay external context step precedes its prepared plan boundary')
  }
  const visiblePluginIds = input.visibleMessages.flatMap(message =>
    message.source.kind === 'agent-rp' ? [String(message.id)] : [])
  if (new Set(visiblePluginIds).size !== visiblePluginIds.length) {
    throw new Error('Roleplay external context contains duplicate visible message ids')
  }
  const candidates = new Map<string, SessionEvent<'user/message'>>()
  const duplicateIds = new Set<string>()
  for (const event of input.events.slice(0, beforeSeq)) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'agent-rp') continue
    const id = String(event.data.id)
    if (candidates.has(id)) duplicateIds.add(id)
    else candidates.set(id, event)
  }
  const contextReads: RoleplayExternalContextRead[] = visiblePluginIds.map((messageId) => {
    const event = candidates.get(messageId)
    if (event === undefined || duplicateIds.has(messageId)) {
      throw new Error(`Roleplay external context ${JSON.stringify(messageId)} is unavailable or ambiguous`)
    }
    return { eventSeq: event.seq, messageId }
  })
  if (contextReads.length === 0) return input.plan
  return {
    ...input.plan,
    recall: { ...input.plan.recall, contextReads },
  }
}
