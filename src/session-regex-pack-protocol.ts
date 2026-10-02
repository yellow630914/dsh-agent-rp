/** Browser-safe values for attaching one library regex pack to a live Session. */

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const SESSION_REGEX_PACK_PATH = '/api/agent-rp/session-regex-pack'

/** Attach one reusable pack to the Session the regex manager is open on. */
export interface SessionRegexPackAttachRequest {
  readonly format: 0
  readonly sessionId: string
  readonly packId: string
}

/** What the Session actually took, so the panel can name it without re-reading. */
export interface SessionRegexPackAttachResponse {
  readonly format: 0
  readonly id: string
  readonly name: string
  readonly scriptCount: number
}
