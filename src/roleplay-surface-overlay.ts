/**
 * Agent RP's own model-visible surface overlay.
 *
 * DSH 0.1.3 forbids `sourceEventSeqs` on `assistant/message` (a V2 Assistant
 * message embeds its provider stream instead of citing source events), and a
 * surface `replace` must cite every node it shadows. An Assistant reply can
 * therefore no longer supersede surface nodes through the Host.
 *
 * Agent RP still needs that: reply versions, prompt-regex rewrites, and Tavern
 * script floor rewrites all restate an Assistant turn. They now APPEND an
 * ordinary surface node and record the supersession here, in one ignorable
 * plugin event. Every Agent RP path that derives model-visible history reads
 * the overlay through {@link roleplayModelHistory}, so the model sees exactly
 * one message per superseded position — the same history the Host surface used
 * to produce, folded one layer higher.
 *
 * A Host without Agent RP skips these events (they are `ignorable`) and simply
 * shows every appended node, which is the honest degraded view.
 */

import { isSurfaceEvent, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'

/** One recorded supersession: appended replacement plus the nodes it hides. */
export interface RoleplaySurfaceOverrideRecord {
  readonly format: 0
  /** Surface seqs this replacement removes from model-visible history. */
  readonly supersedes: readonly number[]
  /** Appended Assistant message seq that stands in for them. */
  readonly replacement: number
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Ignorable record of one Agent RP model-visible surface supersession. */
    'agent-rp/surface-override': RoleplaySurfaceOverrideRecord
  }
}

const SURFACE_OVERRIDE_TYPE = 'agent-rp/surface-override'

function isOverrideEvent(
  event: SessionEvent,
): event is SessionEvent & { readonly data: RoleplaySurfaceOverrideRecord } {
  return event.type === (SURFACE_OVERRIDE_TYPE as SessionEvent['type'])
}

/**
 * Validate one override record without trusting a replayed log.
 * @param data - candidate record read from the event log.
 * @param eventSeq - seq of the event carrying it.
 * @returns the validated record, or undefined when the shape is unusable.
 */
function parseOverride(data: unknown, eventSeq: number): RoleplaySurfaceOverrideRecord | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (record.format !== 0 || !Array.isArray(record.supersedes)) return undefined
  if (typeof record.replacement !== 'number' || !Number.isSafeInteger(record.replacement)
    || record.replacement < 0 || record.replacement >= eventSeq) return undefined
  const supersedes = record.supersedes.filter((seq): seq is number =>
    typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && seq < eventSeq)
  if (supersedes.length !== record.supersedes.length) return undefined
  return { format: 0, supersedes, replacement: record.replacement }
}

/** Seqs the overlay removes from model-visible history, in log order. */
export interface RoleplaySurfaceOverlay {
  /** Surface seqs superseded by a later Agent RP replacement. */
  readonly hidden: ReadonlySet<number>
}

/**
 * Fold every recorded supersession into the set of hidden surface seqs.
 *
 * Later records win: a replacement that is itself superseded is added to
 * `hidden` by the record that supersedes it, so a chain of regenerations
 * leaves exactly one visible node.
 * @param events - complete session events in seq order.
 * @returns the folded overlay.
 */
export function readRoleplaySurfaceOverlay(events: readonly SessionEvent[]): RoleplaySurfaceOverlay {
  const hidden = new Set<number>()
  for (const event of events) {
    if (!isOverrideEvent(event)) continue
    const record = parseOverride(event.data, event.seq)
    if (record === undefined) continue
    for (const seq of record.supersedes) hidden.add(seq)
    // The replacement itself stays visible until a later record supersedes it.
    hidden.delete(record.replacement)
  }
  return { hidden }
}

/**
 * Derive model-visible history with the Agent RP overlay applied.
 *
 * Mirrors `Session.deriveMessages()` — same order, same shared frozen `Message`
 * objects — minus the surface nodes Agent RP superseded. Use this everywhere
 * Agent RP builds a prompt, a transcript, or a macro view; a bare
 * `deriveMessages()` would show the model every discarded reply version.
 * @param session - live session whose surface and log are read.
 * @returns a fresh array of derived messages in model-visible order.
 */
export function roleplayModelHistory(session: Session): Message[] {
  const events = session.snapshotEvents()
  const { hidden } = readRoleplaySurfaceOverlay(events)
  if (hidden.size === 0) return session.deriveMessages()
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    if (hidden.has(seq)) continue
    const event = events[seq]
    if (event === undefined || !isSurfaceEvent(event)) continue
    const message = session.deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  return messages
}

/**
 * Build the override record for one appended replacement.
 * @param replacement - seq of the appended Assistant message.
 * @param supersedes - surface seqs it removes from model-visible history.
 * @returns the record to append through the ignorable plugin-event seam.
 */
export function roleplaySurfaceOverride(
  replacement: number,
  supersedes: readonly number[],
): RoleplaySurfaceOverrideRecord {
  return {
    format: 0,
    supersedes: [...new Set(supersedes)].filter(seq => seq !== replacement).sort((left, right) => left - right),
    replacement,
  }
}
