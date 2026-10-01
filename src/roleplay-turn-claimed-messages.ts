/** Locate the inbox messages one recorded turn plan claimed. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Resolve the player messages a plan receipt names, from the log that holds it.
 *
 * The claimed messages are inbox items. They are still in the inbox when the
 * receipt is written, and the Agent Loop appends them to the log immediately
 * afterwards — since DSH 0.2.0 that append lands *after* the `agent/request`
 * hook that writes the receipt, behind the step's `system/message`. A search
 * bounded above by the receipt's own seq therefore never finds them, which is
 * why both the plan replay and the staged settlement used to fail with
 * "unavailable or ambiguous" on every turn.
 *
 * The window is instead the plan's own preparation boundary through the end of
 * the turn it belongs to. That stays bounded and replay-stable, and an id that
 * does not resolve to exactly one message is still refused — the ambiguity this
 * guards against is a repeated id, not a late append.
 * @param events - complete chronological Session events.
 * @param record - the plan receipt naming the claimed ids.
 * @param subject - what to call the receipt in failure text.
 * @returns the claimed `user/message` events, in the order the receipt names them.
 */
export function roleplayClaimedPlanMessages(
  events: readonly SessionEvent[],
  record: SessionEvent<'agent-rp/turn-plan'>,
  subject: string,
): readonly SessionEvent<'user/message'>[] {
  const { input } = record.data.reference
  if (new Set(input.pendingMessageIds).size !== input.pendingMessageIds.length) {
    throw new Error(`${subject} contains duplicate pending message ids`)
  }
  const turnEnd = events.findIndex(event => event.seq > record.seq
    && (event.type === 'turn/end' || event.type === 'turn/start'))
  const candidates = events.slice(input.sessionSeq, turnEnd < 0 ? events.length : turnEnd)
    .flatMap(event => event.type === 'user/message' ? [event] : [])
  return input.pendingMessageIds.map(id => {
    const matches = candidates.filter(event => String(event.data.id) === id)
    if (matches.length !== 1) {
      throw new Error(`${subject} ${JSON.stringify(id)} is unavailable or ambiguous`)
    }
    return matches[0]!
  })
}
