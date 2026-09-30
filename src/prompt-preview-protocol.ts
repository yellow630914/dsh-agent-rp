/** Wire shape for the prompt preview: exactly what the provider was sent, by source. */

import type { RoleplayPromptOriginKind } from './prompt-origin.ts'

export const PROMPT_PREVIEW_PATH = '/api/agent-rp/prompt-preview'

/** How much of a body the collapsed row shows before it is opened. */
export const PROMPT_PREVIEW_SNIPPET_CHARS = 140

/** One attributable piece of one provider message. */
export interface PromptPreviewPart {
  readonly kind: RoleplayPromptOriginKind
  readonly label: string
  readonly detail?: string
  readonly id?: string
  readonly chars: number
  readonly approximateTokens: number
  /** Leading characters, so a collapsed row says what this is without its body. */
  readonly snippet: string
}

/**
 * One message exactly as the provider received it, in provider order.
 *
 * `parts` is present only when several independently-authored contributions
 * were merged into this one message — several World Info entries inside one
 * `worldInfoBefore` module, several in-chat modules at one depth. A chat row has
 * no parts: it is its own source.
 */
export interface PromptPreviewMessage {
  readonly index: number
  /** The provider-neutral role; a tool result rides as `user`, and the label says so. */
  readonly role: 'system' | 'user' | 'assistant'
  readonly label: string
  readonly detail?: string
  readonly kind: RoleplayPromptOriginKind
  readonly chars: number
  readonly approximateTokens: number
  readonly snippet: string
  readonly parts?: readonly PromptPreviewPart[]
}

/** Aggregate size of one captured request. */
export interface PromptPreviewTotals {
  readonly messages: number
  readonly chars: number
  readonly approximateTokens: number
}

/** Why a roleplay request kept its tool schemas. */
export type PromptPreviewToolReason =
  | 'always'
  | 'turn-in-progress'
  | 'memory'
  | 'image'
  | 'attachment'
  | 'search'
  | 'actor'
  | 'unrecognized-tool'

/** One captured request, without any message body. */
export interface PromptPreviewSummary {
  readonly format: 0
  readonly capturedAt: number
  readonly sessionId: string
  readonly provider?: string
  readonly model?: string
  /** The provider's own system field, which is separate from the message array. */
  readonly system: { readonly chars: number; readonly approximateTokens: number; readonly snippet: string }
  /** Tool schemas actually sent. */
  readonly toolNames: readonly string[]
  /** Tools DSH offered but this request left off because the turn did not need them. */
  readonly omittedToolNames?: readonly string[]
  /** Why the request kept its tool schemas, when it did. */
  readonly toolReasons?: readonly PromptPreviewToolReason[]
  /**
   * Earlier turns' reasoning that rode along on assistant messages. It is not
   * in `totals`: whether it enters the context is the provider's rule, not the
   * array's — DeepSeek concatenates it only when the request carries tools.
   */
  readonly reasoning: { readonly messages: number; readonly chars: number; readonly approximateTokens: number }
  readonly messages: readonly PromptPreviewMessage[]
  readonly totals: PromptPreviewTotals
}

/** Response for a summary request. */
export interface PromptPreviewResponse {
  readonly format: 0
  /** Absent until this Session has actually dispatched one request. */
  readonly summary?: PromptPreviewSummary
  /** Whether Agent RP is positioned to capture this Session's requests at all. */
  readonly available: boolean
}

/**
 * Full text for one opened row.
 *
 * Bodies are fetched one at a time on purpose: a whole prompt is routinely a
 * hundred thousand tokens, which is fine to hold in the Host and wasteful to
 * ship to a panel that shows one expanded row.
 */
export interface PromptPreviewBodyResponse {
  readonly format: 0
  readonly capturedAt: number
  readonly index: number
  readonly text: string
  /** Bodies of the merged contributions, positionally paired with `parts`. */
  readonly parts?: readonly string[]
}

/** The system field's own body, addressed as index -1. */
export const PROMPT_PREVIEW_SYSTEM_INDEX = -1
