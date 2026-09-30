/** The player-visible floor list, shared by chat export and branch seeding. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { roleplaySurfaceNodes } from './roleplay-surface-overlay.ts'

/** One floor as the player sees it: a player line or a character reply. */
export interface RoleplayChatFloor {
  /** Position in the visible floor list, matching the Tavern `message_id` space. */
  readonly index: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** The durable event this floor displays. */
  readonly event: SessionEvent
}

/**
 * Read the text a floor shows, or `undefined` when the node is not a floor.
 *
 * Only player lines and model replies are floors. Plugin-sourced notices (the
 * hidden-floor marker), tool results, and — on a Host that keeps the rendered
 * system prompt on the surface — the `system/message` node all project to no
 * floor, so the floor list never depends on surface positions.
 */
function floorText(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user' && event.data.source.kind !== 'model') return undefined
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  if (event.type !== 'assistant/message' || event.data.message.source.kind !== 'model') return undefined
  return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * List the visible floors in model-visible order.
 *
 * Reads through the Agent RP overlay, so a rewritten floor appears once, in its
 * display position, and superseded originals are absent.
 * @param session - live session whose surface and log are read.
 * @returns the floors, renumbered from zero.
 */
export function roleplayChatFloors(session: Session): readonly RoleplayChatFloor[] {
  const events = session.snapshotEvents()
  const floors: RoleplayChatFloor[] = []
  for (const seq of roleplaySurfaceNodes(session)) {
    const event = events[seq]
    if (event === undefined) continue
    const text = floorText(event)
    if (text === undefined || text.trim() === '') continue
    floors.push({
      index: floors.length,
      role: event.type === 'assistant/message' ? 'assistant' : 'user',
      text,
      event,
    })
  }
  return floors
}
