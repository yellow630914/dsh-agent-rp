import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { executeTavernChatMutation } from '../src/tavern-chat.ts'
import { roleplayModelHistory, roleplaySurfaceNodes } from '../src/roleplay-surface-overlay.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

function createTranscript(...messages: readonly { readonly role: 'assistant' | 'user'; readonly text: string }[]): {
  readonly agent: Agent
  readonly session: Session
} {
  const session = Session.create(SessionId(`tavern-chat-${crypto.randomUUID()}`))
  for (const message of messages) {
    if (message.role === 'user') {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      continue
    }
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: message.text }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
  }
  return { session, agent: { session } as unknown as Agent }
}

function transcript(session: Session): readonly string[] {
  return roleplayModelHistory(session).map(message => message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
}

test('mutates the real Session transcript with Tavern Helper chat operations', () => {
  const { agent, session } = createTranscript(
    { role: 'user', text: '一' },
    { role: 'assistant', text: '二' },
    { role: 'user', text: '三' },
  )

  executeTavernChatMutation(agent, {
    format: 0,
    operation: 'set-chat-messages',
    messages: [{ message_id: 1, message: '二改' }],
  })
  assert.deepEqual(transcript(session), ['一', '二改', '三'])

  executeTavernChatMutation(agent, {
    format: 0,
    operation: 'create-chat-messages',
    insertAt: 1,
    messages: [{ role: 'assistant', message: '插入' }],
  })
  assert.deepEqual(transcript(session), ['一', '插入', '二改', '三'])

  executeTavernChatMutation(agent, {
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [2],
  })
  assert.deepEqual(transcript(session), ['一', '插入', '三'])

  executeTavernChatMutation(agent, {
    format: 0,
    operation: 'rotate-chat-messages',
    begin: 0,
    middle: 1,
    end: 3,
  })
  assert.deepEqual(transcript(session), ['插入', '三', '一'])

  const result = executeTavernChatMutation(agent, {
    format: 0,
    operation: 'create-chat-messages',
    insertAt: 'end',
    messages: [{ role: 'assistant', message: '末尾', data: { mood: 'calm' } }],
  })
  assert.deepEqual(transcript(session), ['插入', '三', '一', '末尾'])
  assert.deepEqual(result.messageVariables, { mood: 'calm' })
})

test('rejects unrepresentable transcript changes before appending Session events', () => {
  const { agent, session } = createTranscript(
    { role: 'user', text: '一' },
    { role: 'assistant', text: '二' },
  )
  const originalSeq = session.seq

  assert.throws(() => executeTavernChatMutation(agent, {
    format: 0,
    operation: 'create-chat-messages',
    insertAt: 0,
    messages: [{ role: 'user', message: '插入', data: { shouldNotPersist: true } }],
  }), /仅支持为追加到末尾/)
  assert.equal(session.seq, originalSeq)
  assert.deepEqual(transcript(session), ['一', '二'])

  assert.throws(() => executeTavernChatMutation(agent, {
    format: 0,
    operation: 'create-chat-messages',
    insertAt: 'end',
    messages: [{ role: 'assistant', message: '不应追加', swipes_data: [{}, {}] }],
  }), /不能保存多个回复页的变量/)
  assert.equal(session.seq, originalSeq)
  assert.deepEqual(transcript(session), ['一', '二'])

  assert.throws(() => executeTavernChatMutation(agent, {
    format: 0,
    operation: 'set-chat-messages',
    messages: [
      { message_id: 0, message: '不应写入' },
      { message_id: 1, swipes: ['甲', '乙'] },
    ],
  }), /不能由脚本创建多个回复页/)
  assert.equal(session.seq, originalSeq)
  assert.deepEqual(transcript(session), ['一', '二'])

  assert.throws(() => executeTavernChatMutation(agent, {
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [0, 1],
  }), /不能删除.*全部聊天楼层/)
  assert.equal(session.seq, originalSeq)
  assert.deepEqual(transcript(session), ['一', '二'])
})

test('hiding floors drops them from the model surface through a real replace', () => {
  const { agent, session } = createTranscript(
    { role: 'user', text: '旧问题' },
    { role: 'assistant', text: '旧回复' },
    { role: 'user', text: '总结请求' },
    { role: 'assistant', text: '压缩后的总结' },
  )
  const before = session.surface.nodes.length

  const hidden = executeTavernChatMutation(agent, {
    format: 0, operation: 'set-chat-hidden', start: 0, end: 1, hidden: true,
  }, [], () => 7)

  // The retained prefix is what keeps Tavern message ids stable and what the
  // floor panel and chat export read; the text never leaves the Session.
  assert.deepEqual(hidden.hiddenPrefix.map(message => ({ role: message.role, text: message.text })), [
    { role: 'user', text: '旧问题' },
    { role: 'assistant', text: '旧回复' },
  ])

  // The raw DSH surface — not just this plugin's overlay — must shrink, because
  // the model request and the context meter are assembled from it.
  assert.deepEqual(
    [...session.surface.nodes].map(seq => session.snapshotEvents()[seq]!).map(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      : (event.data as { readonly message: { readonly content: readonly { readonly type: string; readonly text?: string }[] } })
        .message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')),
    ['（此前 2 层对话已被玩家隐藏，不在本次上下文中。）', '总结请求', '压缩后的总结'],
  )
  assert.equal(session.surface.nodes.length, before - 1, 'two floors out, one marker in')
  assert.deepEqual(transcript(session), [
    '（此前 2 层对话已被玩家隐藏，不在本次上下文中。）', '总结请求', '压缩后的总结',
  ])

  // The marker prices the range it shadows for the token meter, immediately
  // before the replacement — the meter only consumes an adjacent claim.
  const events = session.snapshotEvents()
  const prune = events.find(event => event.type === ('compaction/prune' as typeof event.type))!
  assert.ok(prune)
  const price = prune.data as {
    readonly shadowedRange: { readonly start: number; readonly end: number }
    readonly shadowedSeqs: readonly number[]
    readonly shadowedTokenCount: number
  }
  assert.deepEqual([...price.shadowedSeqs], [0, 1])
  assert.deepEqual(price.shadowedRange, { start: 0, end: 1 })
  assert.equal(price.shadowedTokenCount, 14, 'the injected estimator prices both shadowed nodes')
  assert.equal(events[prune.seq + 1]?.type, 'user/message', 'the replacement is contractually adjacent')

  // Tavern ids still address the hidden floors, so scripts do not shift.
  executeTavernChatMutation(agent, {
    format: 0,
    operation: 'set-chat-messages',
    messages: [{ message_id: 3, message: '压缩后的总结（修订）' }],
  }, hidden.hiddenPrefix)
  assert.equal(transcript(session).at(-1), '压缩后的总结（修订）')
})

test('hiding floors re-appends nothing and never mints a second live message id', () => {
  const { session, agent } = createTranscript(
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第一段回复' },
    { role: 'user', text: '第二句' },
    { role: 'assistant', text: '第二段回复' },
  )
  // Readers that index the log by message id — external context, pending turn
  // input, staged settlement — reject a Session where two events claim one id.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '外部上下文' }],
    source: { kind: 'plugin', plugin: 'fixture', form: 'notice', summary: '外部上下文' },
  }), { surfaceOp: 'append' })
  const pluginId = String((session.snapshotEvents().at(-1)!.data as { readonly id: unknown }).id)
  const assistantsBefore = session.snapshotEvents().filter(event => event.type === 'assistant/message').length

  executeTavernChatMutation(agent, { format: 0, operation: 'set-chat-hidden', start: 0, end: 1, hidden: true }, [], () => 1)

  const ids = session.snapshotEvents().flatMap(event => event.type === 'user/message'
    ? [String((event.data as { readonly id: unknown }).id)]
    : [])
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.filter(id => id === pluginId).length, 1)
  // The kept floors stay exactly where they are: nothing is copied forward.
  assert.equal(
    session.snapshotEvents().filter(event => event.type === 'assistant/message').length,
    assistantsBefore,
    'no assistant floor is re-appended',
  )
  assert.equal(
    roleplaySurfaceNodes(session).filter(seq => session.snapshotEvents()[seq]?.type === 'assistant/message').length,
    1,
    'only the kept assistant floor remains visible',
  )
})

test('hidden floors cannot be restored', () => {
  const { agent } = createTranscript(
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第一段回复' },
    { role: 'user', text: '第二句' },
    { role: 'assistant', text: '第二段回复' },
  )
  const hidden = executeTavernChatMutation(agent, {
    format: 0, operation: 'set-chat-hidden', start: 0, end: 1, hidden: true,
  }, [], () => 1)

  assert.throws(() => executeTavernChatMutation(agent, {
    format: 0, operation: 'set-chat-hidden', start: 0, end: 3, hidden: false,
  }, hidden.hiddenPrefix, () => 1), /无法还原/u)
})

test('hiding still works after a script rewrite left superseded copies in the raw surface', () => {
  const { agent, session } = createTranscript(
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第一段回复' },
    { role: 'user', text: '第二句' },
    { role: 'assistant', text: '第二段回复' },
  )
  // A script edit appends replacement copies and records the supersession in
  // this plugin's overlay, so the raw surface and the overlay stop agreeing.
  executeTavernChatMutation(agent, {
    format: 0, operation: 'set-chat-messages', messages: [{ message_id: 1, message: '第一段回复（改）' }],
  })
  assert.ok(session.surface.nodes.length > roleplaySurfaceNodes(session).length, 'raw surface carries dead copies')

  const hidden = executeTavernChatMutation(agent, {
    format: 0, operation: 'set-chat-hidden', start: 0, end: 1, hidden: true,
  }, [], () => 1)

  assert.deepEqual(hidden.hiddenPrefix.map(message => message.text), ['第一句', '第一段回复（改）'])
  assert.deepEqual(transcript(session), [
    '（此前 2 层对话已被玩家隐藏，不在本次上下文中。）', '第二句', '第二段回复',
  ])
  // The dead copies the overlay was hiding leave the raw surface too, so the
  // model request and the context meter stop carrying them.
  assert.equal(session.surface.nodes.length, 3)
})
