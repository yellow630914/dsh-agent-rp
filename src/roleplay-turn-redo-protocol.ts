/** Browser-safe values for redoing the last turn with edited input. */

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const ROLEPLAY_TURN_REDO_PATH = '/api/agent-rp/turn-redo'

/** Retire the last turn and re-send it with this text. */
export interface RoleplayTurnRedoRequest {
  readonly format: 0
  readonly sessionId: string
  /** The edited player input; the original is discarded with the turn. */
  readonly text: string
}

/** What was retired, so the panel can report it without re-reading the log. */
export interface RoleplayTurnRedoResponse {
  readonly format: 0
  readonly turn: number
  /** Surface rows taken off the transcript. */
  readonly retiredRows: number
  /** State namespaces put back to the value the turn started from. */
  readonly restoredStates: number
}
