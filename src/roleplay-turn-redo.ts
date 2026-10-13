/** Redo the last closed turn in place, leaving nothing of the old one behind. */

import { createSystemMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { appendRoleplayState, readRoleplayStates } from './roleplay-state.ts'

/** One redoable turn: what it occupies on the surface, and what the player wrote. */
export interface RoleplayLastTurnRedo {
  readonly turn: number
  /** Last step the turn opened, so the retiring node is recorded inside it. */
  readonly step: number
  /** Seq of the `turn/start` this turn opened with, the state rollback boundary. */
  readonly turnStartSeq: number
  /** First surface row to retire: the player's own message. */
  readonly startSeq: number
  /** Last surface row to retire: the tail of everything the turn produced. */
  readonly endSeq: number
  /**
   * Every surface row inside that range.
   *
   * A replace has to cite each node it shadows, not just the two endpoints —
   * the Session refuses one that omits a row in between.
   */
  readonly retiredSeqs: readonly number[]
  /** The player's original text, for pre-filling the editor. */
  readonly userText: string
}

function textOf(message: UserMessage): string | undefined {
  const blocks = message.content
  if (blocks.length === 0 || blocks.some(block => block.type !== 'text')) return undefined
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Describe the last closed turn when it can be redone in place.
 *
 * Only the last turn qualifies. Every later turn answered this one, so retiring
 * a turn from the middle would leave the rest replying to text the model can no
 * longer see — which is why editing an older floor stays a branch instead.
 * @param session - the live Session.
 * @returns the redoable turn, or undefined when the tail does not qualify.
 */
export function roleplayLastTurnRedo(session: Session): RoleplayLastTurnRedo | undefined {
  const events = session.snapshotEvents()
  const end = events.findLast((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
  if (end === undefined) return undefined
  const turn = end.data.turn
  const start = events.findLast((event): event is SessionEvent<'turn/start'> =>
    event.type === 'turn/start' && event.data.turn === turn && event.seq < end.seq)
  if (start === undefined) return undefined
  const step = events.filter((event): event is SessionEvent<'step/start'> => event.type === 'step/start'
    && event.seq > start.seq && event.seq < end.seq).at(-1)?.data.step ?? 1

  // The player's own message, not a notice, a runtime-context injection or a
  // spliced tool row: redoing has to re-send exactly what the player typed.
  const user = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.seq > start.seq && event.seq < end.seq && event.data.source.kind === 'user')
  if (user === undefined) return undefined
  const userText = textOf(user.data)
  if (userText === undefined || userText.trim() === '') return undefined

  // Retire everything still on the surface from that message onward, which is
  // the whole turn however many steps or tool rows it produced.
  const nodes = [...session.surface.nodes].filter(seq => seq >= user.seq)
  const endSeq = nodes.at(-1)
  if (nodes[0] !== user.seq || endSeq === undefined) return undefined
  return { turn, step, turnStartSeq: start.seq, startSeq: user.seq, endSeq, retiredSeqs: nodes, userText }
}

/**
 * Take the old turn off the surface and put its state back where it started.
 *
 * The retiring node is an empty `system/message`: the durable format documents
 * an empty system node as deriving no message, so it occupies the surface slot
 * the replaced rows held without contributing anything of its own. Neither the
 * transcript nor the model history reads the old turn afterwards.
 *
 * State has to move back as well. Settlement computes the next value from the
 * current one, so re-running the turn over an already-settled state counts its
 * changes twice — a counter the old turn raised by one would end up at two.
 * Every namespace the turn changed is therefore rewritten to the value it held
 * at `turn/start`, as a new revision: the log stays append-only and the chain
 * stays readable, only the value goes back.
 * @param session - the live Session.
 * @param redo - the turn to retire, from {@link roleplayLastTurnRedo}.
 * @returns how many state namespaces were put back.
 */
export function retireRoleplayLastTurn(session: Session, redo: RoleplayLastTurnRedo): number {
  const events = session.snapshotEvents()
  const before = readRoleplayStates(events, redo.turnStartSeq)
  const current = readRoleplayStates(events)
  let restored = 0
  for (const state of current) {
    const prior = before.find(entry => entry.id === state.id)
    // A namespace the turn *created* has no earlier value to return to; its
    // revision chain cannot be shortened, so it keeps what it has.
    if (prior === undefined) continue
    if (JSON.stringify(prior.value) === JSON.stringify(state.value)) continue
    appendRoleplayState(session, {
      id: state.id,
      expectedRevision: state.revision,
      writerModuleId: state.ownerModuleId,
      value: prior.value,
    })
    restored += 1
  }
  session.append('system/message', {
    turn: redo.turn,
    step: redo.step,
    message: createSystemMessage(''),
  }, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(redo.startSeq), endSeq: SessionSeq(redo.endSeq) },
    sourceEventSeqs: redo.retiredSeqs.map(seq => SessionSeq(seq)),
  })
  return restored
}
