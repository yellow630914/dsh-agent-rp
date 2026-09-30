import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { prepareRoleplayTurn } from '../src/roleplay-turn-plan.ts'
import { bindRoleplayExternalContext } from '../src/roleplay-turn-context.ts'
import {
  AGENT_RP_SESSION_EVENT_TYPES,
  appendAgentRpSessionEvent,
  supportsAgentRpSessionEvents,
} from '../src/session-event-compat.ts'
import { LEGACY_AGENT_RP_EVENT_TYPES } from '../src/session-repair.ts'
import { resolveSessionRoleplayRuntime } from '../src/session-roleplay-runtime.ts'
import {
  appendSessionRoleplayTurnPlan,
  replaySessionRoleplayTurnPlan,
} from '../src/session-roleplay-turn-plan.ts'
import { readRoleplayStates } from '../src/roleplay-state.ts'
import { executeRoleplayStateCommand } from '../src/roleplay-state-command.ts'

const state = {
  format: 0 as const,
  id: 'state:fixture',
  revision: 1,
  ownerModuleId: 'roleplay:fixture',
  writerModuleId: 'roleplay:fixture',
  value: { safe: true },
}

test('refuses an unsafe fallback without changing a published-host Session', () => {
  const session = Session.create(SessionId('published-host-without-plugin-events'))

  assert.equal(supportsAgentRpSessionEvents(session), false)
  assert.throws(() => appendAgentRpSessionEvent(session, 'agent-rp/state', state), /已拒绝写入/u)
  assert.equal(session.seq, 0)
  assert.deepEqual(session.snapshotEvents(), [])
})

test('keeps the repair vocabulary identical to the writable private vocabulary', () => {
  assert.deepEqual([...LEGACY_AGENT_RP_EVENT_TYPES], [...AGENT_RP_SESSION_EVENT_TYPES])
})

test('persists a player state revision through command/done on the published Host', () => {
  const session = Session.create(SessionId('published-host-command-state'))
  const agent = { session } as Agent
  const commandId = CommandId('published-host-state-command')
  const rawInput = JSON.stringify({
    format: 0, operation: 'set', id: 'state:scene', expectedRevision: 0, value: { weather: '雨' },
  })
  session.append('command/run', {
    commandId, name: 'rp-state', args: rawInput, source: { kind: 'user' },
  })

  const result = executeRoleplayStateCommand({ commandId, agent, rawInput })
  assert.equal(result.sourceEventSeq, undefined)
  assert.match(result.text ?? '', /^agent-rp-state-v0:/u)
  session.append('command/done', { commandId, ...result })

  assert.equal(session.snapshotEvents().some(event => event.type === 'agent-rp/state'), false)
  assert.deepEqual(readRoleplayStates(session.snapshotEvents()), [{
    format: 0,
    id: 'state:scene',
    revision: 1,
    ownerModuleId: 'roleplay:user',
    writerModuleId: 'roleplay:user',
    sourceEventSeq: 0,
    value: { weather: '雨' },
    eventSeq: 1,
  }])
  const reopened = Session.create(SessionId('published-host-command-state-replay'), session.snapshotEvents())
  assert.deepEqual(readRoleplayStates(reopened.snapshotEvents()), readRoleplayStates(session.snapshotEvents()))
})

test('writes and exactly replays a prepared turn with a local newer DSH Host', async (t) => {
  const dshRoot = process.env['DSH_SOURCE_DIR'] ?? resolve(process.cwd(), '..', 'dsh')
  const entry = resolve(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js')
  if (!existsSync(entry)) {
    t.skip('local DSH session build is unavailable; set DSH_SOURCE_DIR to enable this matrix leg')
    return
  }

  const local = await import(pathToFileURL(entry).href)
  const session = local.Session.create(local.SessionId('agent-rp-new-host-write'))
  assert.equal(supportsAgentRpSessionEvents(session as Session), true)

  const written = appendAgentRpSessionEvent(session as Session, 'agent-rp/state', state)
  assert.equal(written.ignorable, true)
  assert.equal(written.type, 'agent-rp/state')
  assert.deepEqual(written.data, state)

  const reopened = local.Session.create(
    local.SessionId('agent-rp-new-host-replay'),
    structuredClone(session.events),
  )
  assert.deepEqual(reopened.events[0], written)

  const turnSession = local.Session.create(local.SessionId('agent-rp-new-host-turn')) as Session
  turnSession.append('turn/start', { turn: 1 })
  const message = createUserMessage({
    content: [{ type: 'text', text: '这段正文只用于准备计划，不应进入收据。' }],
    source: { kind: 'user' },
  })
  const deployment = resolveConfig({ characterName: '候选 Host 兼容角色' })
  const resolved = resolveSessionRoleplayRuntime({
    session: turnSession,
    deployment,
    memoryWriteAvailable: true,
  })
  const plan = prepareRoleplayTurn({
    session: turnSession,
    pendingMessages: [message],
    deployment,
    resolved,
  })
  const staleExternal = createUserMessage({
    content: [{ type: 'text', text: '候选 Host 应覆盖的旧世界上下文。' }],
    source: {
      kind: 'plugin', plugin: 'dsh-worldbook', form: 'snapshot', channel: 'candidate-host',
      sections: [{ name: 'candidate-host', text: '候选 Host 应覆盖的旧世界上下文。' }],
    },
  })
  turnSession.append('step/start', { turn: 1, step: 1 })
  turnSession.append('user/message', message, { surfaceOp: 'append' })
  const staleExternalEvent = turnSession.append('user/message', staleExternal, { surfaceOp: 'append' })
  const external = createUserMessage({
    content: [{ type: 'text', text: '候选 Host 外部世界上下文，不应进入收据。' }],
    source: {
      kind: 'plugin', plugin: 'dsh-worldbook', form: 'snapshot', channel: 'candidate-host',
      sections: [{ name: 'candidate-host', text: '候选 Host 外部世界上下文，不应进入收据。' }],
    },
  })
  const externalEvent = turnSession.append('user/message', external, { surfaceOp: 'append' })
  const dispatchedPlan = bindRoleplayExternalContext({
    plan, events: turnSession.snapshotEvents(), visibleMessages: turnSession.deriveMessages(), turn: 1, step: 1,
  })
  const receipt = appendSessionRoleplayTurnPlan(turnSession, 1, 1, dispatchedPlan)
  assert.equal(receipt.ignorable, true)
  assert.equal(receipt.type, 'agent-rp/turn-plan')
  const candidateContextReads = receipt.data.reference.receipt?.recall?.contextReads ?? []
  assert.equal(candidateContextReads.some(read => read.eventSeq === externalEvent.seq), true)
  const supportsSnapshotChannels = (turnSession.constructor as {
    readonly contextSnapshotChannels?: unknown
  }).contextSnapshotChannels === 1
  assert.equal(candidateContextReads.some(read => read.eventSeq === staleExternalEvent.seq), !supportsSnapshotChannels)
  assert.doesNotMatch(JSON.stringify(receipt), /这段正文|候选 Host 兼容角色|外部世界上下文/u)

  const turnReopened = local.Session.create(
    local.SessionId('agent-rp-new-host-turn'),
    structuredClone(turnSession.snapshotEvents()),
  ) as Session
  const reopenedReceipt = turnReopened.snapshotEvents()[receipt.seq]
  assert.equal(reopenedReceipt?.type, 'agent-rp/turn-plan')
  if (reopenedReceipt?.type !== 'agent-rp/turn-plan') throw new Error('turn receipt was not replayed')
  assert.deepEqual(replaySessionRoleplayTurnPlan({
    session: turnReopened,
    record: reopenedReceipt,
    deployment,
  }), dispatchedPlan)
  assert.throws(() => replaySessionRoleplayTurnPlan({
    session: turnReopened,
    record: reopenedReceipt,
    deployment: resolveConfig({ characterName: '漂移后的候选角色' }),
  }), /content digest/u)
})
