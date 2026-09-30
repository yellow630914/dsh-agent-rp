import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  encodeGenerationState,
  readGenerationGroups,
} from '../src/generation.ts'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { roleplayModelHistory, roleplaySurfaceOverride } from '../src/roleplay-surface-overlay.ts'
import { executeTavernTrigger } from '../src/tavern-trigger.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

function appendAssistant(session: Session, turn: number, text: string, supersedes?: readonly SessionSeq[]) {
  const appended = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' } }),
    stream: [],
  }, { surfaceOp: 'append' })
  // DSH 0.1.3 forbids a surface replace on assistant/message; Agent RP records
  // the supersession in its own overlay event instead.
  if (supersedes !== undefined) {
    session.append('agent-rp/surface-override',
      roleplaySurfaceOverride([appended.seq], supersedes))
  }
  return appended
}

test('folds latest selectable reply group snapshots across replacement events', () => {
  const session = Session.create(SessionId('generation-fold'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const original = appendAssistant(session, 1, '第一版')
  const generated = appendAssistant(session, 2, '第二版')
  const replacement = appendAssistant(session, 2, '第二版', [...session.surface.nodes])
  const groupId = '00000000-0000-4000-8000-000000000001'
  const firstState = {
    format: 0,
    groupId,
    operation: 'regenerate',
    originSeq: original.seq,
    anchorSeq: original.seq,
    assistantSeqs: [original.seq, generated.seq],
    versions: [{ seq: original.seq, text: '第一版' }, { seq: generated.seq, text: '第二版' }],
    selectedVersionSeq: generated.seq,
    surfaceSeq: replacement.seq,
  } as const
  session.append('command/done', { commandId: CommandId('generation-1'), kind: 'success', text: encodeGenerationState(firstState) })
  const restored = appendAssistant(session, 1, '第一版', [replacement.seq])
  const selectedState = {
    format: 0,
    groupId,
    operation: 'select',
    originSeq: original.seq,
    anchorSeq: original.seq,
    assistantSeqs: [original.seq, generated.seq],
    versions: [{ seq: original.seq, text: '第一版' }, { seq: generated.seq, text: '第二版' }],
    selectedVersionSeq: original.seq,
    surfaceSeq: restored.seq,
  } as const
  session.append('command/done', { commandId: CommandId('generation-2'), kind: 'success', text: encodeGenerationState(selectedState) })

  const [group] = readGenerationGroups(session.snapshotEvents())
  assert.equal(group?.selectedVersionSeq, original.seq)
  assert.equal(group?.surfaceSeq, restored.seq)
  assert.deepEqual(roleplayModelHistory(session).map(message => message.content[0]?.type === 'text' ? message.content[0].text : ''), ['第一版'])
})

test('rejects reply versions that reference a non-state event', () => {
  const session = Session.create(SessionId('generation-invalid-state-reference'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '你好' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const reply = appendAssistant(session, 1, '回复')
  session.append('command/done', {
    commandId: CommandId('generation-invalid-state-reference'),
    kind: 'success',
    text: encodeGenerationState({
      format: 0,
      groupId: '00000000-0000-4000-8000-000000000099',
      operation: 'regenerate',
      originSeq: reply.seq,
      anchorSeq: reply.seq,
      assistantSeqs: [reply.seq],
      versions: [{ seq: reply.seq, text: '回复', tavernStateSeq: reply.seq }],
      selectedVersionSeq: reply.seq,
      surfaceSeq: reply.seq,
    }),
  })

  assert.throws(() => readGenerationGroups(session.snapshotEvents()), /脚本状态不存在/u)
})

test('triggers one reply after a Tavern script appends a user message', async () => {
  const session = Session.create(SessionId('tavern-trigger'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '延续当前剧情' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  let triggerText: string | undefined
  const agent = {
    session,
    status: 'idle',
    inbox: { hasPending: false },
    followup(message: ReturnType<typeof createUserMessage>) {
      triggerText = message.content[0]?.type === 'text' ? message.content[0].text : undefined
      appendAssistant(session, 2, '角色继续回应')
    },
    whenIdle: async () => {},
    cancel: () => {},
  }
  const result = await executeTavernTrigger({
    agent: agent as never, rawInput: '', signal: new AbortController().signal,
  })

  assert.equal(triggerText, 'Respond to the latest user-authored roleplay message. Output only the in-character response.')
  assert.deepEqual(JSON.parse(result.text), { format: 0, assistantSeq: 1 })
  assert.deepEqual(roleplayModelHistory(session).map(message => message.content[0]?.type === 'text' ? message.content[0].text : ''), [
    '延续当前剧情', '角色继续回应',
  ])
})

test('retries one reasoning-only Tavern trigger before surfacing an empty reply failure', async () => {
  const session = Session.create(SessionId('tavern-trigger-empty-recovery'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '完成开场' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const prompts: string[] = []
  const agent = {
    session,
    status: 'idle',
    inbox: { hasPending: false },
    followup(message: ReturnType<typeof createUserMessage>) {
      prompts.push(message.content[0]?.type === 'text' ? message.content[0].text : '')
      appendAssistant(session, prompts.length + 1, prompts.length === 1 ? '' : '补全后的角色开场')
    },
    whenIdle: async () => {},
    cancel: () => {},
  }

  const result = await executeTavernTrigger({
    agent: agent as never, rawInput: '', signal: new AbortController().signal,
  })

  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /previous attempt ended without a visible answer/u)
  assert.deepEqual(JSON.parse(result.text), { format: 0, assistantSeq: 2 })
})

test('bounds Tavern empty-reply recovery to one retry', async () => {
  const session = Session.create(SessionId('tavern-trigger-empty-bounded'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '完成开场' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  let attempts = 0
  const agent = {
    session,
    status: 'idle',
    inbox: { hasPending: false },
    followup() {
      attempts += 1
      appendAssistant(session, attempts + 1, '')
    },
    whenIdle: async () => {},
    cancel: () => {},
  }

  await assert.rejects(executeTavernTrigger({
    agent: agent as never, rawInput: '', signal: new AbortController().signal,
  }), /连续两次没有生成可见/u)
  assert.equal(attempts, 2)
})

test('refuses a bare Tavern trigger without a latest user message', async () => {
  const session = Session.create(SessionId('tavern-trigger-without-user'))
  appendAssistant(session, 1, '角色上一条回复')
  await assert.rejects(executeTavernTrigger({
    agent: {
      session, status: 'idle', inbox: { hasPending: false }, followup: () => {}, whenIdle: async () => {}, cancel: () => {},
    } as never,
    rawInput: '', signal: new AbortController().signal,
  }), /需要先添加一条用户消息/u)
})
