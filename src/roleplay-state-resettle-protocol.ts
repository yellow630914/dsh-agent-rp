/** Browser-safe values for the player-requested state recalculation. */

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const ROLEPLAY_STATE_RESETTLE_PATH = '/api/agent-rp/state-resettle'

/** One explicit request to recalculate the latest closed turn's state. */
export interface RoleplayStateResettleRequest {
  readonly format: 0
  readonly sessionId: string
}

/** Terminal result shown in the state panel. */
export interface RoleplayStateResettleResponse {
  readonly format: 0
  readonly outcome: 'applied' | 'unchanged' | 'skipped' | 'failed'
  readonly revision?: number
  readonly error?: string
}
