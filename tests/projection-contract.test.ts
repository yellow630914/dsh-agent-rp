import { blankProjectionSeed } from './session-event-fixture.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentRpProjectionDefinition, createAgentRpProjectionDefinition } from '../src/projection.ts'

test('serves the same Agent RP view through current and newer DSH projection contracts', () => {
  const state = agentRpProjectionDefinition.init(...blankProjectionSeed)
  const currentHostView = agentRpProjectionDefinition.schema.parse(
    agentRpProjectionDefinition.view(state),
  )
  const newerHostView = agentRpProjectionDefinition.wire.viewSchema.parse(
    agentRpProjectionDefinition.wire.view(agentRpProjectionDefinition.stateSchema.parse(state)),
  )

  assert.deepEqual(currentHostView, newerHostView)
  assert.equal(agentRpProjectionDefinition.preload, false)
})

test('projects the selected turn mode from the live Host capability instead of a package-local Session class', () => {
  const supported = createAgentRpProjectionDefinition(undefined, () => true)
  const unsupported = createAgentRpProjectionDefinition(undefined, () => false)
  const selected = supported.apply(supported.init(...blankProjectionSeed), {
    type: 'agent-rp/turn-mode',
    seq: SessionSeq(0),
    time: 1,
    ignorable: true,
    data: { format: 0, mode: 'agent', source: 'default' },
  })
  const supportedView = supported.wire.view(selected)
  const unsupportedView = unsupported.wire.view(selected)

  assert.deepEqual(supportedView.hostCapabilities, { sessionEvents: true })
  assert.equal(supportedView.turnMode, 'agent')
  assert.deepEqual(unsupportedView.hostCapabilities, { sessionEvents: false })
  assert.equal(unsupportedView.turnMode, 'conversation')
})

test('reuses the floor list until the surface changes, and bounds how much text a preview reads', () => {
  const body = '她把伞收进玄关。\n'.repeat(400)
  const session = Session.create(SessionId('projection-floors'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: body }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)

  const first = agentRpProjectionDefinition.wire.view(state)
  assert.equal(first.floors.length, 1)
  assert.equal(first.floors[0]?.hidden, false)
  assert.equal(first.floors[0]?.role, 'user')
  // 40 code points plus the ellipsis, whatever the body length is.
  assert.equal(Array.from(first.floors[0]!.preview).length, 41)
  assert.equal(first.floors[0]!.preview.endsWith('…'), true)

  // A state change that leaves the surface alone must not rebuild the list.
  const modeChanged = agentRpProjectionDefinition.apply(state, {
    type: 'agent-rp/turn-mode', seq: 900, time: 1_700_000_000_000, data: { format: 0, mode: 'agent', source: 'default' },
  } as never)
  assert.notEqual(modeChanged, state)
  assert.equal(modeChanged.surface, state.surface)
  assert.equal(agentRpProjectionDefinition.wire.view(modeChanged).floors, first.floors)

  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '短句' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const appended = agentRpProjectionDefinition.apply(modeChanged, session.snapshotEvents().at(-1)!)
  const second = agentRpProjectionDefinition.wire.view(appended)
  assert.notEqual(second.floors, first.floors)
  assert.deepEqual(second.floors.map(floor => floor.preview), [first.floors[0]!.preview, '短句'])
})

test('returns the same state for events it ignores, and stamps the replay clock only on real changes', () => {
  const session = Session.create(SessionId('projection-inert-events'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '开场' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)
  const settled = state

  // The contract gates every downstream cost — view, schema validation, wire
  // payload — on this reference. Streaming turns are almost entirely events
  // this unit does not care about, so returning a fresh object for them ships
  // the whole transcript again for nothing.
  for (let index = 0; index < 50; index += 1) {
    state = agentRpProjectionDefinition.apply(state, {
      type: 'step/start', seq: 100 + index, time: 1_700_000_000_000 + index, data: { turn: 1, step: 1 },
    } as never)
  }
  assert.equal(state, settled)
  assert.equal(state.replayTime, settled.replayTime)

  // A real change still advances the clock, so the view that reads it — the
  // World Info EJS sandbox — sees the time of the event that triggered it.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const changed = agentRpProjectionDefinition.apply(state, session.snapshotEvents().at(-1)!)
  assert.notEqual(changed, state)
  assert.equal(changed.replayTime, session.snapshotEvents().at(-1)!.time)
  assert.equal(changed.surface.length, 2)
})
