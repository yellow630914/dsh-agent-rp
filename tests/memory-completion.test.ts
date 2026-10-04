import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  completeAgentRpMemory,
  isMemoryTimelineEntry,
  memoryCompletionEvidence,
  memoryCompletionTimeMarkers,
  memoryTimelineTitle,
  normalizeMemoryCompletionInput,
  parseMemoryCompletionReply,
} from '../src/memory-completion.ts'
import { AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES } from '../src/memory-completion-protocol.ts'
import { AGENT_RP_MEMORY_TEXT_MAX_LENGTH } from '../src/memory-protocol.ts'
import { readAgentRpMemoryHistory, type AgentRpMemorySeedEntry } from '../src/memory.ts'
import { roleplayChatFloors } from '../src/roleplay-chat-floors.ts'
import { resolveModelInfoDouble } from './model-reasoning-double.ts'

const active: readonly AgentRpMemorySeedEntry[] = [
  { kind: 'event', subject: '【第1天 清晨 ~ 第1天 深夜】', text: '[清晨] 旅人在港口遇见白露。\n[深夜] 两人在旅店住下。' },
  { kind: 'event', subject: '【第2天 清晨 ~ 第2天 午后】', text: '[清晨] 两人离开旅店，沿海岸往王都走。' },
  { kind: 'relationship', subject: '称呼', text: '白露叫旅人“客人”。' },
]

function reply(entries: readonly unknown[]): string {
  return JSON.stringify({ entries })
}

function entry(title: string, events: readonly (readonly [string, string])[], replaces?: string): unknown {
  return {
    title,
    ...(replaces === undefined ? {} : { replaces }),
    events: events.map(([time, text]) => ({ time, text })),
  }
}

test('titles an entry by the time it spans and opens every scene event with its time', () => {
  const parsed = parseMemoryCompletionReply(reply([
    entry('圣龙曆852年4月28日 12:00 ~ 圣龙曆852年4月30日 18:00', [
      ['4月28日 12:00', '白露带旅人进入王都，在东门被卫兵盘问后放行。'],
      ['4月30日 18:00', '两人在钟楼下约定，雨停之后一起去北境。'],
    ]),
    // The model may bracket the title itself; the entry still gets one pair.
    entry('【2025/10/01 08:00:00~16:00:00】', [['08:00:00', '旅人在码头卸货，换到三枚银币。']]),
  ]), [])

  assert.equal(parsed.rejectedCount, 0)
  assert.deepEqual(parsed.entries, [
    {
      kind: 'event',
      subject: '【圣龙曆852年4月28日 12:00 ~ 圣龙曆852年4月30日 18:00】',
      text: '[4月28日 12:00] 白露带旅人进入王都，在东门被卫兵盘问后放行。\n[4月30日 18:00] 两人在钟楼下约定，雨停之后一起去北境。',
    },
    { kind: 'event', subject: '【2025/10/01 08:00:00~16:00:00】', text: '[08:00:00] 旅人在码头卸货，换到三枚银币。' },
  ])
  assert.equal(parsed.entries.every(isMemoryTimelineEntry), true)
  assert.equal(memoryTimelineTitle(' 【 第3天 上午 】 '), '【第3天 上午】')
})

test('extends the unfinished last day instead of opening a second entry for it', () => {
  const parsed = parseMemoryCompletionReply(reply([
    entry('第2天 清晨 ~ 第2天 深夜', [
      ['清晨', '两人离开旅店，沿海岸往王都走。'],
      ['深夜', '白露在篝火边第一次叫了旅人的名字。'],
    ], '第2天 清晨 ~ 第2天 午后'),
    entry('第3天 清晨 ~ 第3天 傍晚', [['清晨', '两人抵达王都东门。']]),
  ]), active)

  assert.deepEqual(parsed.entries, [
    {
      kind: 'event',
      subject: '【第2天 清晨 ~ 第2天 深夜】',
      text: '[清晨] 两人离开旅店，沿海岸往王都走。\n[深夜] 白露在篝火边第一次叫了旅人的名字。',
      // The title changed with the span, so the proposal names the entry it stands in for.
      replaces: { subject: '【第2天 清晨 ~ 第2天 午后】', kind: 'event', text: '[清晨] 两人离开旅店，沿海岸往王都走。' },
    },
    { kind: 'event', subject: '【第3天 清晨 ~ 第3天 傍晚】', text: '[清晨] 两人抵达王都东门。' },
  ])
})

test('drops a restated entry silently and counts what it cannot use', () => {
  const parsed = parseMemoryCompletionReply(reply([
    // Word for word what the timeline already holds: neither a proposal nor a fault.
    entry('第1天 清晨 ~ 第1天 深夜', [['清晨', '旅人在港口遇见白露。'], ['深夜', '两人在旅店住下。']]),
    entry('第3天 清晨 ~ 第3天 傍晚', [['清晨', '两人抵达王都东门。']]),
    entry('第3天 清晨 ~ 第3天 傍晚', [['清晨', '同一段时间的第二条。']]),
    // Naming a title the timeline never had replaces nothing: the entry is new.
    entry('第4天 上午 ~ 第4天 夜晚', [['上午', '两人在集市买齐了北上的干粮。']], '不存在的旧标题'),
    // Two entries cannot both stand in for the same day.
    entry('第2天 清晨 ~ 第2天 深夜', [['深夜', '第一条替换。']], '第2天 清晨 ~ 第2天 午后'),
    entry('第2天 清晨 ~ 第2天 夜晚', [['夜晚', '第二条替换。']], '第2天 清晨 ~ 第2天 午后'),
    { title: '没有事件', events: [] },
    { title: '事件缺时间', events: [{ text: '少了 time。' }] },
    { title: '过长', events: [{ time: '清晨', text: '长'.repeat(AGENT_RP_MEMORY_TEXT_MAX_LENGTH + 1) }] },
    '不是对象',
  ]), active)

  assert.deepEqual(parsed.entries.map(item => [item.subject, item.replaces?.subject]), [
    ['【第3天 清晨 ~ 第3天 傍晚】', undefined],
    ['【第4天 上午 ~ 第4天 夜晚】', undefined],
    ['【第2天 清晨 ~ 第2天 深夜】', '【第2天 清晨 ~ 第2天 午后】'],
  ])
  assert.equal(parsed.rejectedCount, 6)
})

test('reads fenced, bare-array and truncated replies', () => {
  const one = entry('第1天 上午 ~ 第1天 夜晚', [['上午', '一。']])
  assert.deepEqual(parseMemoryCompletionReply(`\`\`\`json\n${reply([one])}\n\`\`\``, []).entries.map(item => item.subject),
    ['【第1天 上午 ~ 第1天 夜晚】'])
  assert.deepEqual(parseMemoryCompletionReply(JSON.stringify([one]), []).entries.map(item => item.subject),
    ['【第1天 上午 ~ 第1天 夜晚】'])

  // Cut off by the completion budget in the middle of the second entry.
  const truncated = parseMemoryCompletionReply(
    '{"entries":[{"title":"第1天 上午 ~ 第1天 夜晚","events":[{"time":"上午","text":"一。"}]},{"title":"第2天 上午 ~ 第2天 夜晚","eve', [],
  )
  assert.deepEqual(truncated.entries.map(item => item.subject), ['【第1天 上午 ~ 第1天 夜晚】'])

  assert.deepEqual(parseMemoryCompletionReply('{"entries":[]}', active).entries, [])
  assert.throws(() => parseMemoryCompletionReply('', []), /没有返回内容/u)
  assert.throws(() => parseMemoryCompletionReply('我整理好了。', []), /没有记忆条目/u)
})

test('caps one proposal at the shared entry limit', () => {
  const many = Array.from({ length: AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES + 3 }, (_, index) =>
    entry(`第${index + 1}天 上午 ~ 第${index + 1}天 夜晚`, [['上午', `第 ${index + 1} 天的事。`]]))
  const parsed = parseMemoryCompletionReply(reply(many), [])
  assert.equal(parsed.entries.length, AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES)
  assert.equal(parsed.rejectedCount, 3)
})

test('accepts an eventful day that runs over what the model was asked to aim for', () => {
  // The model is told to keep an entry within 1000 characters; the Host only
  // refuses past the memory cap, so an overrun does not cost the whole day.
  const day = (count: number): unknown => entry('第5天 清晨 ~ 第5天 深夜',
    Array.from({ length: count }, (_, index) => [`时段${index}`, '字'.repeat(50)] as const))
  const over = parseMemoryCompletionReply(reply([day(24)]), [])
  assert.equal(over.rejectedCount, 0)
  const length = over.entries[0]?.text.length ?? 0
  assert.equal(length > 1_000 && length <= AGENT_RP_MEMORY_TEXT_MAX_LENGTH, true)

  const beyond = parseMemoryCompletionReply(reply([day(30)]), [])
  assert.deepEqual(beyond.entries, [])
  assert.equal(beyond.rejectedCount, 1)
})

test('gives the model the whole memory, split into the timeline and everything else', () => {
  const evidence = memoryCompletionEvidence({
    active,
    floors: [{ role: 'user', text: '先去港口。' }, { role: 'assistant', text: '好。' }],
    timeMarkers: new Map([[1, '日期=第2天，时间=深夜']]),
    characterName: '白露',
    userName: '旅人',
    instruction: '第 2 天拆细一点',
    previous: [{ kind: 'event', subject: '【第2天 清晨 ~ 第2天 深夜】', text: '[深夜] 旧的一版。' }],
  })
  // The timeline keeps its own order and shape, so the model can see where it stops.
  assert.match(evidence, /<timeline>\n【第1天 清晨 ~ 第1天 深夜】\n\[清晨\] 旅人在港口遇见白露。\n\[深夜\] 两人在旅店住下。\n【第2天 清晨 ~ 第2天 午后】/u)
  assert.match(evidence, /<other_memories>\n- \[relationship \| 称呼\] 白露叫旅人“客人”。/u)
  assert.match(evidence, /\[0\] 玩家（旅人）：\n先去港口。\n\[1\] 角色（白露）：\n好。\n〔状态时间：日期=第2天，时间=深夜〕/u)
  assert.match(evidence, /<previous_proposal>\n【第2天 清晨 ~ 第2天 深夜】\n\[深夜\] 旧的一版。\n<\/previous_proposal>/u)
  assert.match(evidence, /<player_instruction>\n第 2 天拆细一点\n<\/player_instruction>/u)

  const plain = memoryCompletionEvidence({ active: [], floors: [{ role: 'user', text: '你好。' }] })
  assert.match(plain, /<timeline>\n（还没有时间线，从楼层的开头记起）/u)
  assert.match(plain, /<other_memories>\n（无）/u)
  assert.doesNotMatch(plain, /previous_proposal|player_instruction|状态时间/u)
})

test('normalizes the guidance a player sends with a run', () => {
  assert.deepEqual(normalizeMemoryCompletionInput(undefined, undefined), {})
  assert.deepEqual(normalizeMemoryCompletionInput('   ', []), {})
  assert.deepEqual(normalizeMemoryCompletionInput(' 少记战斗 ', [{ kind: 'event', subject: ' 【第1天】 ', text: '[上午] 一。' }]), {
    instruction: '少记战斗',
    previous: [{ kind: 'event', subject: '【第1天】', text: '[上午] 一。' }],
  })
  assert.throws(() => normalizeMemoryCompletionInput(7, undefined), /补全要求无效/u)
  assert.throws(() => normalizeMemoryCompletionInput('长'.repeat(2_001), undefined), /不能超过/u)
  assert.throws(() => normalizeMemoryCompletionInput(undefined, [{ kind: 'event', subject: '【第1天】' }]), /字段无效/u)
})

function conversation(): Session {
  const session = Session.create(SessionId('memory-completion'))
  const lines: readonly [string, string][] = [
    ['先去港口。', '好，我们沿着潮声往前走。'],
    ['下次带我去钟楼。', '一言为定。'],
    ['现在呢？', '先歇一会儿。'],
  ]
  lines.forEach(([user, assistant], index) => {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: user }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: assistant }], source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  })
  return session
}

function appendState(session: Session, revision: number, value: Record<string, unknown>): void {
  session.append('agent-rp/state', {
    format: 0, id: 'state:fixture', revision, ownerModuleId: 'roleplay:fixture', writerModuleId: 'roleplay:fixture',
    value: value as never,
  })
}

test('marks each floor with the story time the state data held after it', () => {
  const session = Session.create(SessionId('memory-completion-clock'))
  // A branch re-states its carried state ahead of the transcript. That value is
  // the clock at the end of the kept floors, so it must not mark the first one.
  appendState(session, 1, { 时空: { 日期: '第9天', 时间: '深夜' } })
  const turn = (number: number, user: string, assistant: string): void => {
    session.append('turn/start', { turn: number })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: user }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: number,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: assistant }], source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  turn(1, '出发。', '走吧。')
  appendState(session, 2, { 时空: { 日期: '第4天', 时间: '午后' }, 角色: { 经历时间线: '很长'.repeat(30) }, 金币: 40 })
  turn(2, '歇一下。', '好。')
  // Unchanged clock: no second marker.
  appendState(session, 3, { 时空: { 日期: '第4天', 时间: '午后' }, 金币: 38 })
  turn(3, '天黑了。', '点灯吧。')
  appendState(session, 4, { 时空: { 日期: '第4天', 时间: '夜晚' }, 金币: 38 })

  const markers = memoryCompletionTimeMarkers(session.snapshotEvents(), roleplayChatFloors(session))
  // Only short scalars under a clock-like key; the long prose and the coins stay out.
  assert.deepEqual([...markers], [[1, '日期=第4天，时间=午后'], [5, '日期=第4天，时间=夜晚']])
})

function hostDouble(text: string, seen: { request?: Record<string, unknown> }, efforts: readonly string[] = []): Context {
  return {
    llm: {
      resolveModelInfo: resolveModelInfoDouble(...efforts),
      stream(options: Record<string, unknown>) {
        seen.request = options
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  } as unknown as Context
}

test('reads the whole transcript with all memory and writes nothing to the Session', async () => {
  // The player's case: memory already covers the opening floors, which are
  // still in the transcript. Everything goes to the model — it finds where the
  // record stops and continues to the latest floor.
  const session = conversation()
  session.append('agent-rp/memory-seed', {
    format: 0,
    sourceSessionId: 'earlier-branch',
    memories: [
      { kind: 'event', subject: '【第1天 上午 ~ 第1天 午后】', text: '[上午] 两人沿着潮声走到港口。' },
      { kind: 'relationship', subject: '称呼', text: '白露叫旅人“客人”。' },
    ],
  })
  const before = session.snapshotEvents().length
  const seen: { request?: Record<string, unknown> } = {}
  const result = await completeAgentRpMemory({
    ctx: hostDouble(reply([
      entry('第1天 上午 ~ 第1天 夜晚', [
        ['上午', '两人沿着潮声走到港口。'],
        ['夜晚', '白露答应下次带旅人去钟楼。'],
      ], '第1天 上午 ~ 第1天 午后'),
    ]), seen),
    session,
    route: { provider: 'fixture', model: 'fixture-model' },
    instruction: '约定要记',
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, {
    format: 0,
    entries: [{
      kind: 'event',
      subject: '【第1天 上午 ~ 第1天 夜晚】',
      text: '[上午] 两人沿着潮声走到港口。\n[夜晚] 白露答应下次带旅人去钟楼。',
      replaces: { subject: '【第1天 上午 ~ 第1天 午后】', kind: 'event', text: '[上午] 两人沿着潮声走到港口。' },
    }],
    floorCount: 6,
    activeCount: 2,
    rejectedCount: 0,
    provider: 'fixture',
    model: 'fixture-model',
  })
  const sent = JSON.stringify(seen.request?.messages)
  // Every floor, from the ones memory already covers to the latest.
  assert.match(sent, /先去港口。/u)
  assert.match(sent, /一言为定。/u)
  assert.match(sent, /现在呢？/u)
  assert.match(sent, /先歇一会儿。/u)
  // All memory: the timeline to continue, and the notes beside it.
  assert.match(sent, /<timeline>[^<]*【第1天 上午 ~ 第1天 午后】/u)
  assert.match(sent, /<other_memories>[^<]*称呼/u)
  assert.match(sent, /约定要记/u)
  // The format the player fixed is what the model is told to produce.
  const system = String(seen.request?.system)
  assert.match(system, /以它覆盖的起止时间为标题/u)
  assert.match(system, /至少覆盖完整的一天/u)
  assert.match(system, /20~50 字/u)
  assert.match(system, /在楼层里找到它记到的位置，再从那之后开始记/u)
  assert.match(system, /一直记到最后一层为止/u)
  // The guidance stays at 1000 characters although the Host accepts more, and
  // a crowded day is shortened rather than thinned out.
  assert.match(system, /整个条目控制在 1000 字以内/u)
  assert.match(system, /不要丢掉事件：舍弃描述里的细节，把每个事件写得更短/u)
  // Reasoning is off, so the whole budget reaches the answer.
  assert.equal(seen.request?.reasoningEffort, 'off')
  assert.equal(seen.request?.maxTokens, 8_192)
  assert.equal(seen.request?.stop, undefined)
  assert.equal(session.snapshotEvents().length, before)
  assert.equal(readAgentRpMemoryHistory(session.snapshotEvents()).active.length, 2)
})

test('leaves room for reasoning on a model that cannot stop thinking', async () => {
  const seen: { request?: Record<string, unknown> } = {}
  await completeAgentRpMemory({
    ctx: hostDouble('{"entries":[]}', seen, ['low', 'high']),
    session: conversation(),
    route: { provider: 'fixture', model: 'always-thinking' },
    signal: new AbortController().signal,
  })
  assert.equal(seen.request?.reasoningEffort, 'low')
  assert.equal(seen.request?.maxTokens, 16_384)
})

test('refuses a completion with nothing to read or a failed request', async () => {
  const session = conversation()
  const seen: { request?: Record<string, unknown> } = {}
  const base = {
    ctx: hostDouble('{"entries":[]}', seen),
    session,
    route: { provider: 'fixture', model: 'fixture' },
    signal: new AbortController().signal,
  }
  await assert.rejects(
    completeAgentRpMemory({ ...base, session: Session.create(SessionId('memory-completion-empty')) }),
    /还没有楼层/u,
  )
  assert.equal(seen.request, undefined)

  const failing = {
    llm: {
      resolveModelInfo: resolveModelInfoDouble(),
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } } }
      })(),
    },
  } as unknown as Context
  await assert.rejects(completeAgentRpMemory({ ...base, ctx: failing }), /记忆补全请求失败：context window exceeded/u)
})
