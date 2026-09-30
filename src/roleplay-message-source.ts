/**
 * Agent RP's own message source kind.
 *
 * DSH 0.2.0 retired the shared `plugin` source kind — the durable format now
 * refuses it outright ("format v4 message requires a producer-owned source
 * kind") and each producer declares its own in its own module. Agent RP has
 * several subsystems that attribute messages (the preset assembler, the Tavern
 * Helper bridge, the story engine, the narrative-review Worker, the recall
 * path), so the kind keeps a `plugin` field naming which one: everything that
 * used to read `source.plugin` still reads it, and only the discriminant moved.
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** Attribution for one message Agent RP produced, naming the subsystem. */
export type AgentRpMessageSource = {
  readonly kind: 'agent-rp'
  /** The Agent RP subsystem that assembled this message. */
  readonly plugin: string
} & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-rp': AgentRpMessageSource
  }
}

/** The one discriminant every Agent RP-produced message carries. */
export const AGENT_RP_MESSAGE_SOURCE_KIND = 'agent-rp'
