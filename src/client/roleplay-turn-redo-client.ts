/** Browser side of redoing the last turn with edited player input. */

import {
  ROLEPLAY_TURN_REDO_PATH,
  type RoleplayTurnRedoResponse,
} from '../roleplay-turn-redo-protocol.ts'

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const value = await response.json() as { readonly error?: string } & T
  if (!response.ok) throw new Error(value.error ?? `${fallback}（${response.status}）`)
  return value
}

/**
 * Retire the last turn and re-send it with edited text, in the same Session.
 *
 * The old turn leaves the transcript and the model history together, and the
 * state it settled goes back to the value it started from, so the re-sent turn
 * computes from the same baseline the original one did.
 * @param sessionId - Session whose last turn is being redone.
 * @param text - the edited player input.
 * @returns what was retired and restored.
 */
export async function redoRoleplayTurn(
  sessionId: string,
  text: string,
): Promise<RoleplayTurnRedoResponse> {
  const response = await fetch(ROLEPLAY_TURN_REDO_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ format: 0, sessionId, text }),
  })
  return responseJson<RoleplayTurnRedoResponse>(response, '重做失败')
}
