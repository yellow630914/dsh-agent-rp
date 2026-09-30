import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { CharacterImportMeta } from '../src/import/session-character.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  coalesceWorldbookSnapshot,
  createWorldbookCharacterContextRegistry,
  installWorldbookSnapshotCoalescing,
  worldbookCharacterContext,
} from '../src/worldbook-character-context.ts'

function meta(raw: CharacterImportMeta['raw']): CharacterImportMeta {
  return {
    format: 0,
    result: {
      version: 0,
      name: '角色显示名',
      cardVersion: 3,
      sourceEventSeq: 1,
      sourceAttachmentId: 'fixture',
      transport: 'png',
      metadataKeyword: 'ccv3',
      greetingIndex: 0,
      selectedGreeting: '',
      degradations: [],
    },
    raw,
  }
}

test('projects the SillyTavern filename and deduplicated tags for character filters', () => {
  assert.deepEqual(worldbookCharacterContext(meta({
    spec: 'chara_card_v3',
    data: { tags: ['magic', ' magic ', 'science', 42] },
  }), 'Railgun.profile.png'), {
    name: 'Railgun.profile',
    tags: ['magic', 'science'],
  })
  assert.deepEqual(worldbookCharacterContext(meta({}), undefined), {
    name: '角色显示名', tags: [],
  })
})

test('unregisters only the matching live session contribution', () => {
  const registry = createWorldbookCharacterContextRegistry()
  const first = registry.register('session', () => ({ name: 'first', tags: [] }))
  const second = registry.register('session', () => ({ name: 'second', tags: ['active'] }))
  first()
  assert.deepEqual(registry.getCurrentCharacter('session'), { name: 'second', tags: ['active'] })
  second()
  assert.equal(registry.getCurrentCharacter('session'), undefined)
})

const worldbookMessage = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'instructions' },
})

test('publishes each external Worldbook position as an independent snapshot channel', () => {
  const first = worldbookMessage('first')
  const second = worldbookMessage('second')
  const ordinary = createUserMessage({
    content: [{ type: 'text', text: 'ordinary' }],
    source: { kind: 'agent-rp', plugin: 'other', form: 'instructions' },
  })
  const result = coalesceWorldbookSnapshot([first, ordinary, second])

  assert.equal(result.length, 3)
  assert.deepEqual(result[0]?.content, [{ type: 'text', text: 'first' }])
  assert.deepEqual(result[0]?.source, {
    kind: 'agent-rp',
    plugin: 'dsh-worldbook',
    form: 'snapshot',
    channel: 'agent-rp:inbox-gap:0:0',
    sections: [{ name: 'agent-rp:inbox-gap:0:0', text: 'first' }],
  })
  assert.equal(result[1], ordinary)
  assert.deepEqual(result[2]?.content, [{ type: 'text', text: 'second' }])
  assert.deepEqual(result[2]?.source, {
    kind: 'agent-rp',
    plugin: 'dsh-worldbook',
    form: 'snapshot',
    channel: 'agent-rp:inbox-gap:1:0',
    sections: [{ name: 'agent-rp:inbox-gap:1:0', text: 'second' }],
  })
  const untouched = [ordinary]
  assert.equal(coalesceWorldbookSnapshot(untouched), untouched)
})

test('clears absent channels only on a direct user turn', () => {
  const ordinary = createUserMessage({
    content: [{ type: 'text', text: 'ordinary' }],
    source: { kind: 'user' },
  })
  const previousChannels = ['agent-rp:inbox-gap:0:0', 'agent-rp:inbox-gap:1:0', undefined]
  const toolContinuation = [ordinary]
  assert.equal(coalesceWorldbookSnapshot(toolContinuation, { previousChannels }), toolContinuation)

  const result = coalesceWorldbookSnapshot([ordinary], { directUserTurn: true, previousChannels })
  assert.equal(result.length, 4)
  assert.equal(result[0], ordinary)
  assert.deepEqual(result.slice(1).map(message => message.source), [
    {
      kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'snapshot',
      channel: 'agent-rp:inbox-gap:0:0', sections: [],
    },
    {
      kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'snapshot',
      channel: 'agent-rp:inbox-gap:1:0', sections: [],
    },
    { kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'snapshot', sections: [] },
  ])
  assert.deepEqual(result.slice(1).map(message => message.content), [[], [], []])
})

test('leaves Worldbook messages unchanged when the Host has no channel capability', async (context) => {
  const root = new Context()
  await root.plugin(AgentRegistry)
  installWorldbookSnapshotCoalescing(root, { snapshotChannels: false })
  root.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { kind: 'enter', messages: [worldbookMessage('before'), ...decision.messages] }
  }, { global: true, prepend: true })

  const id = SessionId('worldbook-unsupported-host')
  const agent = { id, session: Session.create(id) } as Agent
  const scope = createScope(root, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const unregister = root.agents.register(agent)
  const ordinary = createUserMessage({
    content: [{ type: 'text', text: 'ordinary' }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(root, agent).waterfall(
    'agent/pre-step',
    { messages: [ordinary], turn: 1, step: 1, signal: AbortSignal.timeout(5_000) },
    async () => ({ kind: 'enter', messages: [ordinary] }),
  )
  assert.equal(decision.kind, 'enter')
  if (decision.kind === 'enter') {
    assert.equal(decision.messages.length, 2)
    const source = decision.messages[0]?.source
    assert.equal(source?.kind, 'agent-rp')
    if (source?.kind === 'agent-rp') assert.equal(source.form, 'instructions')
    assert.equal(decision.messages[1], ordinary)
  }

  context.after(async () => {
    unregister()
    await scope.dispose()
    await root.fiber.dispose()
  })
})

test('adapts a later-loaded Worldbook injector without moving either side of the user message', async (context) => {
  const root = new Context()
  await root.plugin(AgentRegistry)
  installWorldbookSnapshotCoalescing(root, { snapshotChannels: true })
  let inject = true
  root.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !inject) return decision
    return {
      kind: 'enter',
      messages: [worldbookMessage('before'), ...decision.messages, worldbookMessage('after')],
    }
  }, { global: true, prepend: true })

  const id = SessionId('worldbook-snapshot-order')
  const agent = { id, session: Session.create(id) } as Agent
  const scope = createScope(root, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const unregister = root.agents.register(agent)
  // DSH 0.2.0 emits `agent/created` from the Agent factory, not from a bare
  // `agents.register()`; the coalescing adapter installs its per-agent pre-step
  // hook on that event, so this fixture announces it the way `agents.create()`
  // would. Production always goes through the factory.
  await agentEvents(root, agent).serial('agent/created', { source: 'startup' })
  const ordinary = createUserMessage({
    content: [{ type: 'text', text: 'ordinary' }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(root, agent).waterfall(
    'agent/pre-step',
    { messages: [ordinary], turn: 1, step: 1, signal: AbortSignal.timeout(5_000) },
    async () => ({ kind: 'enter', messages: [ordinary] }),
  )

  assert.equal(decision.kind, 'enter')
  if (decision.kind === 'enter') {
    assert.equal(decision.messages.length, 3)
    assert.deepEqual(decision.messages[0]?.content, [{ type: 'text', text: 'before' }])
    assert.equal(decision.messages[1], ordinary)
    assert.deepEqual(decision.messages[2]?.content, [{ type: 'text', text: 'after' }])
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }

  inject = false
  const nextUser = createUserMessage({
    content: [{ type: 'text', text: 'next' }],
    source: { kind: 'user' },
  })
  const cleared = await agentEvents(root, agent).waterfall(
    'agent/pre-step',
    { messages: [nextUser], turn: 2, step: 2, signal: AbortSignal.timeout(5_000) },
    async () => ({ kind: 'enter', messages: [nextUser] }),
  )
  assert.equal(cleared.kind, 'enter')
  if (cleared.kind === 'enter') {
    assert.equal(cleared.messages.length, 3)
    assert.equal(cleared.messages[0], nextUser)
    assert.deepEqual(cleared.messages.slice(1).map(message => message.source), [
      {
        kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'snapshot',
        channel: 'agent-rp:inbox-gap:0:0', sections: [],
      },
      {
        kind: 'agent-rp', plugin: 'dsh-worldbook', form: 'snapshot',
        channel: 'agent-rp:inbox-gap:1:0', sections: [],
      },
    ])
  }

  context.after(async () => {
    unregister()
    await scope.dispose()
    await root.fiber.dispose()
  })
})
