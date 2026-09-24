/** Browser-safe values for switching or editing one Session's state contract. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const ROLEPLAY_STATE_SCHEME_SESSION_PATH = '/api/agent-rp/state-scheme-session'

/** One explicit change requested from the state dialog. */
export interface RoleplayStateSchemeSessionRequest {
  readonly format: 0
  readonly sessionId: string
  /** Switch onto another reusable scheme, keeping this Session's own identity. */
  readonly resourceId?: string
  /** Session-level edits that never travel back to the library entry. */
  readonly edit?: {
    readonly name?: string
    readonly initial?: JsonValue
    readonly rules?: string
  }
}
