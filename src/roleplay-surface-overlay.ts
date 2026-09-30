/**
 * Agent RP's own model-visible surface overlay.
 *
 * DSH 0.1.3 forbids `sourceEventSeqs` on `assistant/message` (a V2 Assistant
 * message embeds its provider stream instead of citing source events), and a
 * surface `replace` must cite every node it shadows. An Assistant reply can
 * therefore no longer supersede surface nodes through the Host.
 *
 * Agent RP still needs that: reply versions, prompt-regex rewrites, and Tavern
 * script floor rewrites all restate an Assistant turn. They now APPEND ordinary
 * surface nodes and record the supersession here, in one ignorable plugin
 * event. A positional `replace` did two things — hide the old nodes AND put the
 * new one in their place — so this overlay reproduces both: `hidden` drops the
 * superseded seqs, and each replacement is emitted at the position of the
 * earliest node it superseded rather than at the append tail.
 *
 * Every Agent RP path that reads "the current surface" must go through
 * {@link roleplaySurfaceNodes} or {@link roleplayModelHistory}; a bare
 * `session.surface.nodes` still lists the superseded originals and shows every
 * rewritten floor twice, in the wrong order.
 *
 * A Host without Agent RP skips these events (they are `ignorable`) and simply
 * shows every appended node, which is the honest degraded view.
 */

import { isSurfaceEvent, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'

/** One recorded supersession: appended replacements plus the nodes they hide. */
export interface RoleplaySurfaceOverrideRecord {
  readonly format: 0
  /** Surface seqs this record removes from the visible surface. */
  readonly supersedes: readonly number[]
  /** Appended seqs standing in for them, in model-visible order. */
  readonly replacements: readonly number[]
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

function seqList(value: unknown, limit: number): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seqs = value.filter((seq): seq is number =>
    typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && seq < limit)
  return seqs.length === value.length ? seqs : undefined
}

/**
 * Validate one override record without trusting a replayed log.
 * @param data - candidate record read from the event log.
 * @param eventSeq - seq of the event carrying it; every reference must precede it.
 * @returns the validated record, or undefined when the shape is unusable.
 */
function parseOverride(data: unknown, eventSeq: number): RoleplaySurfaceOverrideRecord | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (record.format !== 0) return undefined
  const supersedes = seqList(record.supersedes, eventSeq)
  const replacements = seqList(record.replacements, eventSeq)
  if (supersedes === undefined || replacements === undefined) return undefined
  if (supersedes.length === 0 || replacements.length === 0) return undefined
  return { format: 0, supersedes, replacements }
}

/** Folded overlay: which seqs are gone, and where the replacements belong. */
export interface RoleplaySurfaceOverlay {
  /** Surface seqs superseded by a later Agent RP replacement. */
  readonly hidden: ReadonlySet<number>
  /** Anchor seq → replacement seqs emitted in its place, in order. */
  readonly promoted: ReadonlyMap<number, readonly number[]>
  /** Replacement seq → the anchor position it is emitted at. */
  readonly anchorOf: ReadonlyMap<number, number>
}

/**
 * Fold every recorded supersession into hidden seqs and their anchor positions.
 *
 * Later records win, and anchors resolve transitively: regenerating twice
 * leaves one visible node, still sitting where the first reply was.
 * @param events - complete session events in seq order.
 * @returns the folded overlay.
 */
export function readRoleplaySurfaceOverlay(events: readonly SessionEvent[]): RoleplaySurfaceOverlay {
  const hidden = new Set<number>()
  const promoted = new Map<number, number[]>()
  const anchorOf = new Map<number, number>()
  for (const event of events) {
    if (!isOverrideEvent(event)) continue
    const record = parseOverride(event.data, event.seq)
    if (record === undefined) continue
    const earliest = Math.min(...record.supersedes)
    // A superseded replacement hands its position to the new one.
    const anchor = anchorOf.get(earliest) ?? earliest
    const gone = new Set(record.supersedes)
    for (const seq of gone) hidden.add(seq)
    for (const [at, list] of promoted) {
      const kept = list.filter(seq => !gone.has(seq))
      if (kept.length === 0) promoted.delete(at)
      else promoted.set(at, kept)
    }
    promoted.set(anchor, [...promoted.get(anchor) ?? [], ...record.replacements])
    for (const seq of record.replacements) {
      anchorOf.set(seq, anchor)
      hidden.delete(seq)
    }
  }
  return { hidden, promoted, anchorOf }
}

/** Reorder raw surface nodes so each replacement sits where it superseded. */
function overlaidNodes(
  nodes: readonly SessionSeq[],
  overlay: RoleplaySurfaceOverlay,
): readonly SessionSeq[] {
  const emitted = new Set<number>()
  const visible: SessionSeq[] = []
  for (const seq of nodes) {
    const group = overlay.promoted.get(seq)
    if (group !== undefined) {
      for (const replacement of group) {
        if (overlay.hidden.has(replacement) || emitted.has(replacement)) continue
        emitted.add(replacement)
        visible.push(replacement as SessionSeq)
      }
      continue
    }
    if (overlay.hidden.has(seq)) continue
    // A replacement already took its place at the anchor above.
    if (overlay.anchorOf.has(seq)) continue
    visible.push(seq)
  }
  return visible
}

/**
 * Current model-visible surface node seqs with the Agent RP overlay applied.
 * @param session - live session whose surface is read.
 * @returns the visible node seqs in model-visible order.
 */
export function roleplaySurfaceNodes(session: Session): readonly SessionSeq[] {
  const overlay = readRoleplaySurfaceOverlay(session.snapshotEvents())
  if (overlay.hidden.size === 0 && overlay.promoted.size === 0) return session.surface.nodes
  return overlaidNodes(session.surface.nodes, overlay)
}

/**
 * Derive model-visible history with the Agent RP overlay applied.
 *
 * Mirrors `Session.deriveMessages()` — same shared frozen `Message` objects —
 * over {@link roleplaySurfaceNodes} instead of the raw surface. Use this
 * everywhere Agent RP builds a prompt, a transcript, or a macro view; a bare
 * `deriveMessages()` shows the model every discarded reply version.
 * @param session - live session whose surface and log are read.
 * @returns a fresh array of derived messages in model-visible order.
 */
export function roleplayModelHistory(session: Session): Message[] {
  const overlay = readRoleplaySurfaceOverlay(session.snapshotEvents())
  if (overlay.hidden.size === 0 && overlay.promoted.size === 0) return session.deriveMessages()
  const events = session.snapshotEvents()
  const messages: Message[] = []
  for (const seq of overlaidNodes(session.surface.nodes, overlay)) {
    const event = events[seq]
    if (event === undefined || !isSurfaceEvent(event)) continue
    const message = session.deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  return messages
}

/**
 * The conversation itself: player lines and character replies, in order.
 *
 * {@link roleplayModelHistory} is the model's whole view, and since DSH 0.2.0
 * that includes the rendered system prompt as surface node 0 and any tool-update
 * `developer` message. Callers that mean "the transcript" — a recap fed to a
 * Worker, the pre-regex dialogue, an exported chat — want neither: a system
 * prompt pasted into a story recap is a leak, not context.
 * @param session - live session whose surface and log are read.
 * @returns the dialogue messages, in model-visible order.
 */
export function roleplayDialogueHistory(session: Session): Message[] {
  return roleplayModelHistory(session)
    .filter(message => message.role === 'user' || message.role === 'assistant')
}

/**
 * Build the override record for one appended rewrite.
 * @param replacements - appended seqs, in the order they should be visible.
 * @param supersedes - surface seqs they remove from the visible surface.
 * @returns the record to append through the ignorable plugin-event seam.
 */
export function roleplaySurfaceOverride(
  replacements: readonly number[],
  supersedes: readonly number[],
): RoleplaySurfaceOverrideRecord {
  const replaced = new Set(replacements)
  return {
    format: 0,
    supersedes: [...new Set(supersedes)].filter(seq => !replaced.has(seq)).sort((left, right) => left - right),
    replacements: [...replacements],
  }
}
