/** Redoing the last turn in place: nothing of the old one survives, state included. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { protectedSystemHeadMessage } from '../src/import/protected-system-head.ts'
import { appendRoleplayState, readRoleplayStates } from '../src/roleplay-state.ts'
import { roleplayModelHistory } from '../src/roleplay-surface-overlay.ts'
import { roleplayLastTurnRedo, retireRoleplayLastTurn } from '../src/roleplay-turn-redo.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

const STATE = 'state:counter'
const MODULE = 'module:test'

function openingTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1, step: 1, message: protectedSystemHeadMessage(),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '开场白。' }], source: { provider: 'f', model: 'f' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

function playerTurn(session: Session, turn: number, user: string, reply: string, settle?: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: reply }], source: { provider: 'f', model: 'f' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  if (settle !== undefined) {
    const current = readRoleplayStates(session.snapshotEvents()).find(state => state.id === STATE)
    appendRoleplayState(session, {
      id: STATE, expectedRevision: current?.revision ?? 0, writerModuleId: MODULE, value: settle,
    })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const texts = (session: Session) => roleplayModelHistory(session)
  .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))

test('describes the last turn, its player text and the rows it occupies', () => {
  const session = Session.create(SessionId('redo-describe'))
  openingTurn(session)
  playerTurn(session, 2, '123', '旧回复。')

  const redo = roleplayLastTurnRedo(session)
  assert.ok(redo)
  assert.equal(redo.turn, 2)
  assert.equal(redo.userText, '123')
  // The range runs from the player's own message to the tail of the surface.
  assert.equal(redo.startSeq < redo.endSeq, true)
  assert.equal([...session.surface.nodes].at(-1), redo.endSeq)
})

test('retiring the turn hides it from the transcript and the model alike', () => {
  const session = Session.create(SessionId('redo-retire'))
  openingTurn(session)
  playerTurn(session, 2, '123', '旧回复。')
  assert.deepEqual(texts(session), ['开场白。', '123', '旧回复。'])

  retireRoleplayLastTurn(session, roleplayLastTurnRedo(session)!)

  // The empty system node takes the slot without contributing a message, so
  // the old turn is gone from the one list both the UI and the request read.
  assert.deepEqual(texts(session), ['开场白。'])
  assert.equal([...session.surface.nodes].length, 3)
})

test('puts state back to the value the turn started from', () => {
  const session = Session.create(SessionId('redo-state'))
  openingTurn(session)
  appendRoleplayState(session, { id: STATE, expectedRevision: 0, writerModuleId: MODULE, value: 1 })
  playerTurn(session, 2, '123', '旧回复。', 2)
  assert.equal(readRoleplayStates(session.snapshotEvents()).find(s => s.id === STATE)?.value, 2)

  const restored = retireRoleplayLastTurn(session, roleplayLastTurnRedo(session)!)

  assert.equal(restored, 1)
  const state = readRoleplayStates(session.snapshotEvents()).find(s => s.id === STATE)
  // Re-running the turn settles from 1 again; without this it would count the
  // old turn's change twice and land on 3.
  assert.equal(state?.value, 1)
  // The chain is append-only: the value went back, the revision did not.
  assert.equal(state?.revision, 3)
})

test('leaves a namespace the turn created alone, having nowhere to return it to', () => {
  const session = Session.create(SessionId('redo-state-new'))
  openingTurn(session)
  playerTurn(session, 2, '123', '旧回复。', 7)

  assert.equal(retireRoleplayLastTurn(session, roleplayLastTurnRedo(session)!), 0)
  assert.equal(readRoleplayStates(session.snapshotEvents()).find(s => s.id === STATE)?.value, 7)
})

test('offers nothing when the last turn carries no player message', () => {
  const session = Session.create(SessionId('redo-no-user'))
  openingTurn(session)
  assert.equal(roleplayLastTurnRedo(session), undefined)
})

test('ignores a notice the runtime wrote, only the player text qualifies', () => {
  const session = Session.create(SessionId('redo-notice'))
  openingTurn(session)
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '已隐藏前 3 层对话' }],
    source: {
      kind: 'agent-rp', plugin: 'dsh-agent-rp-hidden-floors',
      form: 'notice', summary: '已隐藏前 3 层对话',
    },
  }), { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  assert.equal(roleplayLastTurnRedo(session), undefined)
})

test('retires every row a multi-step turn produced, not just the first', () => {
  const session = Session.create(SessionId('redo-multistep'))
  openingTurn(session)
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '123' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (const [step, text] of [[1, '第一段。'], [2, '第二段。'], [3, '第三段。']] as const) {
    session.append('assistant/message', {
      turn: 2, step,
      message: createAssistantMessage({
        content: [{ type: 'text', text }], source: { provider: 'f', model: 'f' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(texts(session).length, 5)

  retireRoleplayLastTurn(session, roleplayLastTurnRedo(session)!)
  assert.deepEqual(texts(session), ['开场白。'])
})

test('a redone turn can be redone again', () => {
  const session = Session.create(SessionId('redo-twice'))
  openingTurn(session)
  playerTurn(session, 2, '123', '旧回复。')
  retireRoleplayLastTurn(session, roleplayLastTurnRedo(session)!)
  // The retired turn is off the surface, so the turn before it is the tail
  // again; an opening with no player message offers nothing further.
  assert.equal(roleplayLastTurnRedo(session), undefined)

  playerTurn(session, 3, '123456', '新回复。')
  const again = roleplayLastTurnRedo(session)
  assert.ok(again)
  assert.equal(again.userText, '123456')
  retireRoleplayLastTurn(session, again)
  assert.deepEqual(texts(session), ['开场白。'])
})
