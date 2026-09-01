/** Browser-safe protocol for inspecting active Roleplay memory. */

import type {
  AgentRpMemoryCommandRequest,
  AgentRpMemoryId,
  AgentRpMemoryKind,
} from './memory.ts'

/** Same-origin endpoint exposing only the currently active memory snapshot. */
export const AGENT_RP_MEMORY_PATH = '/api/agent-rp/memory'

/** One active memory shown in the local memory manager. */
export interface AgentRpMemoryView {
  readonly id: AgentRpMemoryId
  readonly kind: AgentRpMemoryKind
  readonly subject: string
  readonly text: string
  readonly source: 'character' | 'user' | 'inherited' | 'imported'
}

/** Current active-memory response for one Roleplay Session. */
export interface AgentRpMemoryResponse {
  readonly format: 0
  readonly memories: readonly AgentRpMemoryView[]
}

export type { AgentRpMemoryCommandRequest }
