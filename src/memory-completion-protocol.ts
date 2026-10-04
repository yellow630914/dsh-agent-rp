/** Browser-safe protocol for completing memory before a branch leaves floors behind. */

import type { AgentRpMemoryKind, AgentRpMemorySeedEntry } from './memory.ts'

/** Same-origin endpoint that proposes memory for the floors a branch will drop. */
export const AGENT_RP_MEMORY_COMPLETION_PATH = '/api/agent-rp/memory-completion'

/**
 * Most timeline entries one completion may propose, and one branch may carry in.
 *
 * Every active memory is rendered into the system prompt of every later turn,
 * so a completion that itemizes the transcript would spend the context the
 * branch was meant to free.
 */
export const AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES = 40

/** Longest player guidance accepted for one completion run. */
export const AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH = 2_000

/**
 * Ask for the timeline entries a Session's transcript has not been given yet.
 *
 * The whole visible transcript is read, wherever a branch will cut it: memory
 * runs ahead of the cut, so what a branch drops is always already recorded.
 */
export interface AgentRpMemoryCompletionRequest {
  readonly format: 0
  readonly sessionId: string
  /** What the player wants this run to do differently. */
  readonly instruction?: string
  /** The proposal the player rejected, so the instruction can refer to it. */
  readonly previous?: readonly AgentRpMemorySeedEntry[]
}

/**
 * One proposed timeline entry.
 *
 * `subject` is the span of story time the entry covers, in 【】; `text` is its
 * scene events, one per line, each opening with its own time in [].
 */
export interface AgentRpMemoryCompletionEntry extends AgentRpMemorySeedEntry {
  /**
   * The active memory this entry would take the place of. Its title differs
   * from `subject` when the entry extends a day the timeline had not finished.
   */
  readonly replaces?: { readonly subject: string; readonly kind: AgentRpMemoryKind; readonly text: string }
}

/** A proposal for the player to review; nothing has been written anywhere. */
export interface AgentRpMemoryCompletionResponse {
  readonly format: 0
  readonly entries: readonly AgentRpMemoryCompletionEntry[]
  /** How many floors the proposal was read from. */
  readonly floorCount: number
  /** How many memories are active in the source Session and carry over unchanged. */
  readonly activeCount: number
  /** Entries the model returned that could not be used. */
  readonly rejectedCount: number
  /** Provider route that produced the proposal. */
  readonly provider: string
  readonly model: string
}
