import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { MEMORY_VALUE_SCHEMA } from '../src/index.ts'
import {
  appendAgentRpMemorySeed,
  parseAgentRpMemoryCommandRequest,
  prepareAgentRpMemory,
  requestsPersistentMemory,
  type AgentRpMemoryRecord,
  readAgentRpMemoryHistory,
} from '../src/memory.ts'
import { executeAgentRpMemoryCommand } from '../src/memory-command.ts'
import { renderMemoryContext } from '../src/prompt.ts'

test('opens model memory only for explicit persistent user intent', () => {
  const message = (text: string) => createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  })
  assert.equal(requestsPersistentMemory(message('请记住我喝咖啡不加糖。')), true)
  assert.equal(requestsPersistentMemory(message('下次请叫我小满。')), true)
  assert.equal(requestsPersistentMemory(message('我点点头，陪她去保健室。')), false)
  assert.equal(requestsPersistentMemory(createUserMessage({
    source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: '内部通知' },
    content: [{ type: 'text', text: '请记住这条内部通知。' }],
  })), false)
})

function appendRememberCall(session: Session, callId: string, args: object): number {
  return session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'remember',
    arguments: JSON.stringify(args),
  }).seq
}

function appendRememberResult(
  session: Session,
  callId: string,
  record: AgentRpMemoryRecord,
  callSeq: number,
): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text: JSON.stringify(record) }],
      isError: false,
    }),
  }, {
    surfaceOp: 'append',
    sourceEventSeqs: [callSeq],
  })
}

function runMemoryCommand(agent: Agent, rawInput: string, sequence: number, recordInput = false): void {
  const commandId = CommandId(`memory-command-${sequence}`)
  agent.session.append('command/run', {
    commandId,
    name: 'rp-memory',
    ...(recordInput ? { args: rawInput } : {}),
    source: { kind: 'user' },
  })
  const result = executeAgentRpMemoryCommand({ commandId, agent, rawInput })
  agent.session.append('command/done', { commandId, ...result })
}

test('persists one normalized memory and exposes it to the next prompt snapshot', () => {
  const session = Session.create(SessionId('agent-rp-memory'))
  const input = {
    kind: 'preference',
    subject: '  饮品  ',
    text: '  用户喝咖啡时不加糖  ',
  } as const
  const sourceEventSeq = appendRememberCall(session, 'remember-1', input)
  const record = prepareAgentRpMemory(session, 'remember-1', input)
  appendRememberResult(session, 'remember-1', record, sourceEventSeq)

  assert.deepEqual(record, {
    version: 0,
    id: `memory-${sourceEventSeq}`,
    kind: 'preference',
    subject: '饮品',
    text: '用户喝咖啡时不加糖',
    sourceEventSeq,
  })
  assert.deepEqual(validateJsonSchemaValue(valueSchemaSpecToJsonSchema(MEMORY_VALUE_SCHEMA), record), [])
  assert.deepEqual(readAgentRpMemoryHistory(session.events).active, [record])
  assert.match(renderMemoryContext(session.events), /用户喝咖啡时不加糖/u)
  assert.match(renderMemoryContext(session.events), new RegExp(`\\[memory-${sourceEventSeq} \\| preference \\|`, 'u'))
  assert.match(renderMemoryContext(session.events), /持久记忆只读/u)
  assert.doesNotMatch(renderMemoryContext(session.events), /remember|supersedes/u)
  assert.match(renderMemoryContext(session.events, true), /调用 remember/u)
  assert.match(renderMemoryContext([], true), /跨轮保留意图/u)
  assert.doesNotMatch(renderMemoryContext(session.events), /来源事件/u)
})

test('keeps correction history while only the replacement remains active', () => {
  const session = Session.create(SessionId('agent-rp-correction'))
  const oldInput = {
    kind: 'fact',
    subject: '住处',
    text: '用户住在杭州',
  } as const
  const oldCallSeq = appendRememberCall(session, 'remember-1', oldInput)
  const old = prepareAgentRpMemory(session, 'remember-1', oldInput)
  appendRememberResult(session, 'remember-1', old, oldCallSeq)
  const replacementInput = {
    kind: 'fact',
    subject: '住处',
    text: '用户已经搬到苏州',
    supersedes: old.id,
  } as const
  const replacementCallSeq = appendRememberCall(session, 'remember-2', replacementInput)
  const replacement = prepareAgentRpMemory(session, 'remember-2', replacementInput)
  appendRememberResult(session, 'remember-2', replacement, replacementCallSeq)

  const history = readAgentRpMemoryHistory(session.events)
  assert.deepEqual(history.all, [old, replacement])
  assert.deepEqual(history.active, [replacement])
  assert.doesNotMatch(renderMemoryContext(session.events), /杭州/u)
  assert.match(renderMemoryContext(session.events), /苏州/u)
})

test('rejects a duplicate active topic unless the existing record is superseded', () => {
  const session = Session.create(SessionId('agent-rp-duplicate-topic'))
  const firstInput = { kind: 'preference', subject: '红茶', text: '用户喝红茶不加柠檬' } as const
  const firstCallSeq = appendRememberCall(session, 'remember-1', firstInput)
  const first = prepareAgentRpMemory(session, 'remember-1', firstInput)
  appendRememberResult(session, 'remember-1', first, firstCallSeq)

  const duplicate = { kind: 'preference', subject: ' 红茶 ', text: '用户喜欢热红茶' } as const
  appendRememberCall(session, 'remember-2', duplicate)
  assert.throws(() => prepareAgentRpMemory(session, 'remember-2', duplicate), /use supersedes/u)

  const replacement = { ...duplicate, supersedes: first.id }
  appendRememberCall(session, 'remember-3', replacement)
  assert.equal(prepareAgentRpMemory(session, 'remember-3', replacement).supersedes, first.id)
})

test('lets the user correct and forget active memory without invoking the model', () => {
  const agent = { session: Session.create(SessionId('agent-rp-user-memory')) } as Agent
  const oldInput = { kind: 'preference', subject: '红茶', text: '用户喜欢在红茶里加柠檬' } as const
  const oldCallSeq = appendRememberCall(agent.session, 'remember-user-1', oldInput)
  const old = prepareAgentRpMemory(agent.session, 'remember-user-1', oldInput)
  appendRememberResult(agent.session, 'remember-user-1', old, oldCallSeq)

  const correction = {
    format: 0,
    operation: 'correct',
    id: old.id,
    kind: 'preference',
    subject: '红茶',
    text: '用户希望红茶不要加柠檬',
  } as const
  assert.deepEqual(parseAgentRpMemoryCommandRequest(JSON.stringify(correction)), correction)
  runMemoryCommand(agent, JSON.stringify(correction), 1, true)

  const corrected = readAgentRpMemoryHistory(agent.session.events)
  assert.equal(corrected.all.length, 2)
  assert.deepEqual(corrected.active.map(record => record.text), ['用户希望红茶不要加柠檬'])
  assert.doesNotMatch(renderMemoryContext(agent.session.events), /喜欢在红茶里加柠檬/u)
  assert.match(renderMemoryContext(agent.session.events), /红茶不要加柠檬/u)

  runMemoryCommand(agent, JSON.stringify({
    format: 0,
    operation: 'forget',
    id: corrected.active[0]!.id,
  }), 2)
  const forgotten = readAgentRpMemoryHistory(agent.session.events)
  assert.equal(forgotten.all.length, 2)
  assert.deepEqual(forgotten.active, [])
  assert.equal(renderMemoryContext(agent.session.events), '')
})

test('lets the user add normalized memory without invoking the model', () => {
  const agent = { session: Session.create(SessionId('agent-rp-user-added-memory')) } as Agent
  const request = {
    format: 0,
    operation: 'add',
    kind: 'relationship',
    subject: '  称呼  ',
    text: '  角色称呼用户为小满  ',
  } as const
  assert.deepEqual(parseAgentRpMemoryCommandRequest(JSON.stringify(request)), {
    ...request,
    subject: '称呼',
    text: '角色称呼用户为小满',
  })
  runMemoryCommand(agent, JSON.stringify(request), 1)

  const history = readAgentRpMemoryHistory(agent.session.events)
  assert.equal(history.all.length, 1)
  assert.deepEqual(history.active.map(record => ({ kind: record.kind, subject: record.subject, text: record.text })), [{
    kind: 'relationship', subject: '称呼', text: '角色称呼用户为小满',
  }])
  assert.match(renderMemoryContext(agent.session.events), /角色称呼用户为小满/u)
  assert.throws(() => {
    runMemoryCommand(agent, JSON.stringify({ ...request, subject: '称呼', text: '重复内容' }), 2)
  }, /已经有一条有效记忆/u)
})

test('rejects a user correction that would collide with another active topic', () => {
  const agent = { session: Session.create(SessionId('agent-rp-user-memory-conflict')) } as Agent
  const teaInput = { kind: 'preference', subject: '红茶', text: '用户喝红茶不加柠檬' } as const
  const teaCallSeq = appendRememberCall(agent.session, 'remember-tea', teaInput)
  const tea = prepareAgentRpMemory(agent.session, 'remember-tea', teaInput)
  appendRememberResult(agent.session, 'remember-tea', tea, teaCallSeq)
  const homeInput = { kind: 'fact', subject: '住处', text: '用户住在杭州' } as const
  const homeCallSeq = appendRememberCall(agent.session, 'remember-home', homeInput)
  const home = prepareAgentRpMemory(agent.session, 'remember-home', homeInput)
  appendRememberResult(agent.session, 'remember-home', home, homeCallSeq)
  const commandId = CommandId('memory-command-conflict')
  const request = {
    format: 0,
    operation: 'correct',
    id: home.id,
    kind: 'fact',
    subject: '红茶',
    text: '用户住在杭州',
  } as const
  agent.session.append('command/run', {
    commandId,
    name: 'rp-memory',
    args: JSON.stringify(request),
    source: { kind: 'user' },
  })

  assert.throws(() => executeAgentRpMemoryCommand({ commandId, agent, rawInput: JSON.stringify(request) }), /另一条有效记忆/u)
})

test('copies only active memory into a new Session where it remains editable', () => {
  const source = { session: Session.create(SessionId('agent-rp-memory-source')) } as Agent
  const forgottenInput = { kind: 'fact', subject: '旧住处', text: '用户曾住在杭州' } as const
  const forgottenCallSeq = appendRememberCall(source.session, 'remember-source-1', forgottenInput)
  const forgotten = prepareAgentRpMemory(source.session, 'remember-source-1', forgottenInput)
  appendRememberResult(source.session, 'remember-source-1', forgotten, forgottenCallSeq)
  const retainedInput = { kind: 'preference', subject: '红茶', text: '用户喝红茶不加柠檬' } as const
  const retainedCallSeq = appendRememberCall(source.session, 'remember-source-2', retainedInput)
  const retained = prepareAgentRpMemory(source.session, 'remember-source-2', retainedInput)
  appendRememberResult(source.session, 'remember-source-2', retained, retainedCallSeq)
  runMemoryCommand(source, JSON.stringify({ format: 0, operation: 'forget', id: forgotten.id }), 1)

  const activeSource = readAgentRpMemoryHistory(source.session.events).active
  const target = { session: Session.create(
    SessionId('agent-rp-memory-target'),
    appendAgentRpMemorySeed([], activeSource, String(source.session.id)),
  ) } as Agent
  const inherited = readAgentRpMemoryHistory(target.session.events)
  assert.equal(inherited.all.length, 1)
  assert.deepEqual(inherited.active.map(record => ({ kind: record.kind, subject: record.subject, text: record.text })), [{
    kind: 'preference', subject: '红茶', text: '用户喝红茶不加柠檬',
  }])
  assert.match(String(inherited.active[0]?.id), /^memory-seed-0-0$/u)

  runMemoryCommand(target, JSON.stringify({
    format: 0,
    operation: 'correct',
    id: inherited.active[0]?.id,
    kind: 'preference',
    subject: '红茶',
    text: '用户只在冬天喝红茶',
  }), 2)
  const corrected = readAgentRpMemoryHistory(target.session.events)
  assert.deepEqual(corrected.active.map(record => record.text), ['用户只在冬天喝红茶'])
  runMemoryCommand(target, JSON.stringify({
    format: 0,
    operation: 'forget',
    id: corrected.active[0]?.id,
  }), 3)
  assert.deepEqual(readAgentRpMemoryHistory(target.session.events).active, [])
})

test('rejects blank memory and invalid correction without appending state', () => {
  const session = Session.create(SessionId('agent-rp-invalid'))
  appendRememberCall(session, 'remember-1', {
    kind: 'fact',
    subject: '资料',
    text: '   ',
  })

  assert.throws(() => prepareAgentRpMemory(session, 'remember-1', {
    kind: 'fact',
    subject: '资料',
    text: '   ',
  }), /must contain non-whitespace/u)
  appendRememberCall(session, 'remember-2', {
    kind: 'fact',
    subject: '资料',
    text: '有效内容',
    supersedes: 'memory-999',
  })
  assert.throws(() => prepareAgentRpMemory(session, 'remember-2', {
    kind: 'fact',
    subject: '资料',
    text: '有效内容',
    supersedes: 'memory-999',
  }), /missing or inactive/u)
  assert.equal(readAgentRpMemoryHistory(session.events).all.length, 0)
})

test('rejects a source that is not the direct remember tool call', () => {
  const session = Session.create(SessionId('agent-rp-source'))
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId('other-1'),
    name: 'other',
    arguments: '{}',
  })

  assert.throws(() => prepareAgentRpMemory(session, 'other-1', {
    kind: 'fact',
    subject: '资料',
    text: '有效内容',
  }), /matching direct Session tool call/u)
})

test('rejects a durable record that diverges from its source call arguments', () => {
  const session = Session.create(SessionId('agent-rp-tampered-source'))
  const sourceEventSeq = appendRememberCall(session, 'remember-1', {
    kind: 'fact',
    subject: '称呼',
    text: '用户喜欢被叫作阿澄',
  })
  appendRememberResult(session, 'remember-1', {
    version: 0,
    id: `memory-${sourceEventSeq}` as never,
    kind: 'fact',
    subject: '称呼',
    text: '用户喜欢被叫作小澄',
    sourceEventSeq,
  }, sourceEventSeq)

  assert.throws(() => readAgentRpMemoryHistory(session.events), /does not match its source call arguments/u)
})

test('imports a memory batch as one atomic record that stays editable', () => {
  const agent = { session: Session.create(SessionId('agent-rp-memory-import')) } as Agent
  runMemoryCommand(agent, JSON.stringify({
    format: 0, operation: 'add', kind: 'relationship', subject: '称呼', text: '角色称呼用户为小满',
  }), 1)
  const before = agent.session.events.length

  const importRequest = {
    format: 0,
    operation: 'import',
    entries: [
      { kind: 'preference', subject: '  饮品  ', text: '  用户喝红茶不加糖  ' },
      { kind: 'event', subject: '初遇', text: '两人在海城钟楼下第一次见面。' },
    ],
  } as const
  // Parsing normalizes and drops nothing else; ids in a file are never read.
  assert.deepEqual(parseAgentRpMemoryCommandRequest(JSON.stringify(importRequest)), {
    format: 0,
    operation: 'import',
    entries: [
      { kind: 'preference', subject: '饮品', text: '用户喝红茶不加糖' },
      { kind: 'event', subject: '初遇', text: '两人在海城钟楼下第一次见面。' },
    ],
  })
  runMemoryCommand(agent, JSON.stringify(importRequest), 2)

  const history = readAgentRpMemoryHistory(agent.session.events)
  assert.deepEqual(history.active.map(record => [record.subject, record.origin]), [
    ['称呼', undefined],
    ['饮品', 'imported'],
    ['初遇', 'imported'],
  ])
  // One command/run + one command/done carried the whole batch.
  assert.equal(agent.session.events.length - before, 2)
  const imported = history.active.filter(record => record.origin === 'imported')
  assert.equal(new Set(imported.map(record => record.sourceEventSeq)).size, 1)
  assert.match(renderMemoryContext(agent.session.events), /用户喝红茶不加糖/u)

  // Imported records are ordinary active memories afterwards.
  runMemoryCommand(agent, JSON.stringify({
    format: 0, operation: 'forget', id: String(imported[0]!.id),
  }), 3)
  assert.deepEqual(
    readAgentRpMemoryHistory(agent.session.events).active.map(record => record.subject),
    ['称呼', '初遇'],
  )
})

test('rejects a whole import batch instead of applying part of it', () => {
  const agent = { session: Session.create(SessionId('agent-rp-memory-import-reject')) } as Agent
  runMemoryCommand(agent, JSON.stringify({
    format: 0, operation: 'add', kind: 'relationship', subject: '称呼', text: '角色称呼用户为小满',
  }), 1)
  const settled = agent.session.events.length
  const activeBefore = readAgentRpMemoryHistory(agent.session.events).active.length

  const collides = {
    format: 0,
    operation: 'import',
    entries: [
      { kind: 'event', subject: '初遇', text: '两人在海城钟楼下第一次见面。' },
      // Topic conflicts fold case and surrounding space, exactly like adds do.
      { kind: 'relationship', subject: ' 称呼 ', text: '角色改口叫用户满满' },
    ],
  }
  assert.throws(() => { runMemoryCommand(agent, JSON.stringify(collides), 2) }, /已经有有效记忆/u)
  // The failed command left its own lifecycle events but changed no memory.
  assert.equal(readAgentRpMemoryHistory(agent.session.events).active.length, activeBefore)
  assert.equal(agent.session.events.length, settled + 1)

  assert.throws(() => parseAgentRpMemoryCommandRequest(JSON.stringify({
    format: 0,
    operation: 'import',
    entries: [
      { kind: 'event', subject: '初遇', text: '第一次见面。' },
      { kind: 'event', subject: '初遇 ', text: '重复主题。' },
    ],
  })), /出现多次/u)
  assert.throws(() => parseAgentRpMemoryCommandRequest(JSON.stringify({
    format: 0,
    operation: 'import',
    entries: Array.from({ length: 201 }, (_value, index) => ({
      kind: 'fact', subject: `主题${index}`, text: '内容',
    })),
  })), /最多导入 200 条/u)
  assert.throws(() => parseAgentRpMemoryCommandRequest(JSON.stringify({
    format: 0,
    operation: 'import',
    entries: [{ kind: 'fact', subject: '主题', text: '内容', id: 'memory-9' }],
  })), /字段无效/u)
  assert.throws(() => parseAgentRpMemoryCommandRequest(JSON.stringify({
    format: 0, operation: 'import', entries: [],
  })), /字段无效/u)
})

test('clears every active memory with one record while the history stays readable', () => {
  const agent = { session: Session.create(SessionId('agent-rp-memory-clear')) } as Agent
  runMemoryCommand(agent, JSON.stringify({
    format: 0, operation: 'add', kind: 'relationship', subject: '称呼', text: '角色称呼用户为小满',
  }), 1)
  runMemoryCommand(agent, JSON.stringify({
    format: 0,
    operation: 'import',
    entries: [
      { kind: 'preference', subject: '饮品', text: '用户喝红茶不加糖' },
      { kind: 'event', subject: '初遇', text: '两人在海城钟楼下第一次见面。' },
    ],
  }), 2)
  assert.equal(readAgentRpMemoryHistory(agent.session.events).active.length, 3)
  const before = agent.session.events.length

  assert.deepEqual(parseAgentRpMemoryCommandRequest('{"format":0,"operation":"forget-all"}'), {
    format: 0, operation: 'forget-all',
  })
  runMemoryCommand(agent, JSON.stringify({ format: 0, operation: 'forget-all' }), 3)

  const history = readAgentRpMemoryHistory(agent.session.events)
  assert.deepEqual(history.active, [])
  // One command/run + one command/done cleared the whole set.
  assert.equal(agent.session.events.length - before, 2)
  // Clearing removes nothing from the chronological history, so what was
  // remembered — and later forgotten — is still replayable.
  assert.deepEqual(history.all.map(record => record.subject), ['称呼', '饮品', '初遇'])
  assert.equal(renderMemoryContext(agent.session.events), '')

  // Nothing left to clear, and the Session is unchanged by the refusal.
  const settled = agent.session.events.length
  assert.throws(() => {
    runMemoryCommand(agent, JSON.stringify({ format: 0, operation: 'forget-all' }), 4)
  }, /没有可清空的记忆/u)
  assert.equal(readAgentRpMemoryHistory(agent.session.events).active.length, 0)
  assert.equal(agent.session.events.length, settled + 1)

  assert.throws(() => parseAgentRpMemoryCommandRequest('{"format":0,"operation":"forget-all","id":"memory-1"}'),
    /字段无效/u)
})
