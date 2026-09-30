/** Whether an Agent still owes work to a pending prompt. */

import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Whether the Agent has input waiting for a turn or a step boundary.
 *
 * DSH 0.2.0 dropped `Inbox.hasPending` and exposes the two pending lists
 * instead. Every Agent RP gate that used the old flag means the same thing:
 * refuse to mutate a transcript that the Agent is about to answer into.
 * @param agent - agent whose inbox is read.
 * @returns true while any prompt is still pending.
 */
export function agentHasPendingInput(agent: Agent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}
