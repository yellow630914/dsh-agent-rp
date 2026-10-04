/** Memory completion: continue the story's timeline up to the latest floor. */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { jsonrepair } from 'jsonrepair'
import { readActiveSessionCharacter } from './import/session-character.ts'
import {
  normalizeAgentRpMemorySeedEntry,
  readAgentRpMemoryHistory,
  type AgentRpMemorySeedEntry,
} from './memory.ts'
import {
  AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH,
  AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES,
  type AgentRpMemoryCompletionEntry,
  type AgentRpMemoryCompletionResponse,
} from './memory-completion-protocol.ts'
import { roleplayChatFloors, type RoleplayChatFloor } from './roleplay-chat-floors.ts'
// Mounts the `agent-rp/state` event declaration the time markers read.
import type {} from './roleplay-state.ts'
import { negotiateWorkerReasoningEffort } from './worker-reasoning-effort.ts'

/** Completion budget when the whole of it reaches the answer. */
const MEMORY_COMPLETION_MAX_TOKENS = 8_192
/** Completion budget on a model that cannot stop thinking, where reasoning shares it. */
const MEMORY_COMPLETION_REASONING_MAX_TOKENS = 16_384
const MAX_REPLY_LENGTH = 256 * 1024
/**
 * How long the model is asked to keep one entry.
 *
 * Deliberately below the memory text cap: the cap is what the Host refuses, and
 * the gap between the two is the room an entry has to run over on an eventful
 * day without the whole day being lost.
 */
const ENTRY_TARGET_LENGTH = 1_000

function subjectKey(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * Write one span of story time the way a timeline entry is titled.
 * @param span - the span as the model or an earlier entry wrote it, bracketed or not.
 * @returns the span inside one pair of 【】.
 */
export function memoryTimelineTitle(span: string): string {
  return `【${span.trim().replace(/^【\s*/u, '').replace(/\s*】$/u, '').trim()}】`
}

/** Whether one memory is an entry of the timeline rather than a standalone note. */
export function isMemoryTimelineEntry(memory: Pick<AgentRpMemorySeedEntry, 'kind' | 'subject'>): boolean {
  return memory.kind === 'event' && /^【.+】$/u.test(memory.subject.trim())
}

/**
 * Validate what the player sent along with one completion run.
 * @param instruction - free-form guidance, or `undefined`.
 * @param previous - the rejected proposal, or `undefined`.
 * @returns both normalized; a blank instruction counts as none.
 */
export function normalizeMemoryCompletionInput(instruction: unknown, previous: unknown): {
  readonly instruction?: string
  readonly previous?: readonly AgentRpMemorySeedEntry[]
} {
  if (instruction !== undefined && typeof instruction !== 'string') throw new Error('补全要求无效')
  const trimmed = instruction?.trim() ?? ''
  if (trimmed.length > AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH) {
    throw new Error(`补全要求不能超过 ${AGENT_RP_MEMORY_COMPLETION_INSTRUCTION_MAX_LENGTH} 字`)
  }
  if (previous !== undefined && (!Array.isArray(previous)
    || previous.length > AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES)) {
    throw new Error('上一版补全结果无效')
  }
  const entries = (previous as readonly unknown[] | undefined)
    ?.map((entry, index) => normalizeAgentRpMemorySeedEntry(entry, `上一版记忆 ${index + 1} `))
  return {
    ...(trimmed === '' ? {} : { instruction: trimmed }),
    ...(entries === undefined || entries.length === 0 ? {} : { previous: entries }),
  }
}

/** State keys that hold the story's own clock or calendar. */
const STATE_TIME_KEY = /时间|時間|日期|时刻|時刻|时辰|時辰|时段|時段|时空|時空|星期|纪年|紀年|历法|曆法|time|date|clock/iu
const STATE_TIME_MAX_FIELDS = 6
const STATE_TIME_MAX_VALUE_LENGTH = 40

function stateTimeFields(value: JsonValue, path: readonly string[] = [], found: string[] = []): readonly string[] {
  if (found.length >= STATE_TIME_MAX_FIELDS) return found
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) stateTimeFields(child, [...path, key], found)
    return found
  }
  if (typeof value !== 'string' && typeof value !== 'number') return found
  const text = String(value).trim()
  // A clock is a short scalar. A long string under a matching key is prose that
  // happens to mention time, and would bury the floors it is attached to.
  if (text === '' || text.length > STATE_TIME_MAX_VALUE_LENGTH || !path.some(key => STATE_TIME_KEY.test(key))) return found
  found.push(`${path.at(-1)}=${text}`)
  return found
}

/**
 * Read the story time the state data held as each floor was played.
 *
 * In a Session on a native state scheme the clock lives in the state data, not
 * in the prose, so the floors alone would leave the model guessing. Each state
 * revision is attributed to the floor it followed; a revision written before
 * the first floor is skipped, because a branch re-states its carried state
 * ahead of the transcript and that value describes the *end* of the kept
 * floors, not their beginning.
 * @param events - complete Session events.
 * @param floors - the visible floors, in order.
 * @returns for each floor index that changed the clock, the clock after it.
 */
export function memoryCompletionTimeMarkers(
  events: readonly SessionEvent[],
  floors: readonly Pick<RoleplayChatFloor, 'event'>[],
): ReadonlyMap<number, string> {
  const latest = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'agent-rp/state') continue
    const fields = stateTimeFields(event.data.value)
    if (fields.length === 0) continue
    const index = floors.findLastIndex(floor => floor.event.seq < event.seq)
    if (index >= 0) latest.set(index, fields.join('，'))
  }
  const markers = new Map<number, string>()
  let previous: string | undefined
  for (const index of [...latest.keys()].sort((left, right) => left - right)) {
    const marker = latest.get(index)!
    if (marker !== previous) markers.set(index, marker)
    previous = marker
  }
  return markers
}

/**
 * Lay out everything the completion model reads, as one tagged document.
 *
 * All active memory goes in, not only the timeline: the model has to find where
 * the record stops before it can continue it, and a standalone note may already
 * cover an event the floors show.
 * @param input - active memory, the transcript, and the player's guidance.
 * @returns the user message text.
 */
export function memoryCompletionEvidence(input: {
  readonly active: readonly AgentRpMemorySeedEntry[]
  readonly floors: readonly Pick<RoleplayChatFloor, 'role' | 'text'>[]
  readonly timeMarkers?: ReadonlyMap<number, string>
  readonly characterName?: string
  readonly userName?: string
  readonly instruction?: string
  readonly previous?: readonly AgentRpMemorySeedEntry[]
}): string {
  const player = input.userName === undefined ? '玩家' : `玩家（${input.userName}）`
  const character = input.characterName === undefined ? '角色' : `角色（${input.characterName}）`
  const timeline = input.active.filter(isMemoryTimelineEntry)
  const others = input.active.filter(memory => !isMemoryTimelineEntry(memory))
  return [
    '<timeline>',
    ...(timeline.length === 0
      ? ['（还没有时间线，从楼层的开头记起）']
      : timeline.map(memory => `${memory.subject}\n${memory.text}`)),
    '</timeline>',
    '<other_memories>',
    ...(others.length === 0
      ? ['（无）']
      : others.map(memory => `- [${memory.kind} | ${memory.subject}] ${memory.text}`)),
    '</other_memories>',
    '<floors>',
    ...input.floors.flatMap((floor, index) => {
      const marker = input.timeMarkers?.get(index)
      return [
        `[${index}] ${floor.role === 'user' ? player : character}：\n${floor.text.trim()}`,
        ...(marker === undefined ? [] : [`〔状态时间：${marker}〕`]),
      ]
    }),
    '</floors>',
    ...(input.previous === undefined ? [] : [
      '<previous_proposal>',
      ...input.previous.map(entry => `${entry.subject}\n${entry.text}`),
      '</previous_proposal>',
    ]),
    ...(input.instruction === undefined ? [] : [
      '<player_instruction>',
      input.instruction,
      '</player_instruction>',
    ]),
  ].join('\n')
}

const MEMORY_COMPLETION_SYSTEM = [
  '你是角色扮演运行时的后台记忆记录器。<floors> 是这段会话目前保留的全部聊天记录；更早的楼层已经被裁掉，只留在记忆里。玩家即将另开分支，届时 <floors> 里较早的楼层也会被裁掉，之后角色只能靠持久记忆知道那些楼层里发生过什么。不要续写、评价或解释剧情。',
  '任务：把 <floors> 里还没有被记下的事件，按时间顺序接着 <timeline> 记成新的时间线条目，一直记到最后一层为止。<timeline> 是已经记下的时间线，<other_memories> 是其它已有记忆；两者已经记过的事件一律不再重复。<floors> 开头的一段通常已经记过：先对照 <timeline> 最后的几个事件，在楼层里找到它记到的位置，再从那之后开始记。<timeline> 为空时从第一层记起。',
  '条目格式：',
  '- 一个条目以它覆盖的起止时间为标题（title），例如「2025/10/01 08:00:00~16:00:00」「圣龙曆852年4月28日 12:00 ~ 圣龙曆852年4月30日 18:00」。',
  '- 一个条目至少覆盖完整的一天，同一天的事件不要拆到两个条目里；事件稀疏的连续几天合成一个条目，由场景事件的密度决定。',
  '- 一个条目包含多个场景事件（events），按先后排列。',
  '- 每个场景事件有自己的时间（time）和一句 20~50 字的描述（text）：写清人物、地点、做了什么、结果如何，用第三人称陈述句，不抄录对白。约定、关系与称呼的变化、得失的关键物品和数字要写进去。覆盖多天的条目里，time 要带上日期。',
  `- 整个条目控制在 ${ENTRY_TARGET_LENGTH} 字以内。场景事件太多、照上面的字数写会超出时，不要丢掉事件：舍弃描述里的细节，把每个事件写得更短。`,
  '时间：',
  '- 一律使用故事内的时间，沿用正文、〔状态时间〕标记和 <timeline> 已经在用的历法与写法；公历、架空历法、「第 3 天 上午」都可以，但整条时间线的写法要一致。〔状态时间〕标记的是它上面那一层结束时的故事内时间。',
  '- 正文或标记给到几点几分就写到几点几分；只给到「清晨」「午后」「夜晚」这类时段就写时段，不要编造没有依据的钟点。',
  '- 没有明确时间的场景，按前后文推断它的先后，用一致的写法标出。不要使用现实世界的当前时间。',
  '接续：',
  '- <timeline> 最后一条所在的那一天还没有记完、而楼层接着同一天时，不要另起一条：输出一个替换它的条目，replaces 填它原来的标题，title 写新的起止时间，events 保留原有事件并接上新的事件。',
  '- 其它情况一律新增条目，不要改动已有条目，也不要输出不需要改动的已有条目。',
  '- 只记录楼层里实际发生的事，不要推测或补写没有出现的情节。',
  '<player_instruction> 存在时，它是玩家对这次记录的要求，取舍与它冲突时以它为准。<previous_proposal> 是玩家不满意的上一版结果：按要求修改后输出完整的新结果，而不是只输出改动的部分。',
  '只输出一个 JSON 对象，不要输出任何其他文字：{"entries":[{"title":"起止时间","replaces":"被替换条目的原标题，没有就省略这个字段","events":[{"time":"时间","text":"事件描述"}]}]}。没有需要记录的内容时输出 {"entries":[]}。',
].join('\n')

function replyRecords(text: string): readonly unknown[] {
  if (text.length > MAX_REPLY_LENGTH) throw new Error('模型返回的记忆过长')
  const unfenced = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  if (unfenced === '') throw new Error('模型没有返回内容；它可能把全部输出额度用在了思考上')
  const objectStart = unfenced.indexOf('{')
  const arrayStart = unfenced.indexOf('[')
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart
  const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error('模型返回的内容里没有记忆条目')
  let value: unknown
  try {
    // A reply cut off by the completion budget still ends in whole entries once
    // repaired, which is worth more to the player than a parse error.
    value = JSON.parse(jsonrepair(unfenced.slice(start, end + 1)))
  } catch {
    throw new Error('模型返回的内容不是有效的记忆条目')
  }
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null ? (value as { readonly entries?: unknown }).entries : undefined
  if (!Array.isArray(list)) throw new Error('模型返回的内容里没有记忆条目')
  return list
}

/**
 * Turn one entry of the reply into a timeline memory.
 *
 * The model returns the events as data and the Host writes the lines, so every
 * event in memory opens with its time whatever the model would have typed.
 */
function timelineEntry(record: unknown, label: string): AgentRpMemorySeedEntry & { readonly replaces?: string } {
  const { title, events, replaces } = (record ?? {}) as Record<string, unknown>
  if (typeof title !== 'string' || !Array.isArray(events) || events.length === 0) throw new Error(`${label}字段无效`)
  const lines = events.map((event) => {
    const { time, text } = (event ?? {}) as Record<string, unknown>
    if (typeof time !== 'string' || typeof text !== 'string' || time.trim() === '' || text.trim() === '') {
      throw new Error(`${label}的场景事件无效`)
    }
    return `[${time.trim()}] ${text.trim().replace(/\s*\n\s*/gu, ' ')}`
  })
  return {
    ...normalizeAgentRpMemorySeedEntry({ kind: 'event', subject: memoryTimelineTitle(title), text: lines.join('\n') }, label),
    ...(typeof replaces === 'string' && replaces.trim() !== '' ? { replaces: memoryTimelineTitle(replaces) } : {}),
  }
}

/**
 * Turn one model reply into a proposal the player can review.
 *
 * Entries are judged one at a time: a reply with one unusable entry still
 * yields the rest, and the count of what was left out goes back to the player.
 * An entry that restates an active memory word for word is dropped silently —
 * it changes nothing, so it is neither a proposal nor a fault.
 * @param text - the model's complete reply.
 * @param active - the memories currently in force in the source Session.
 * @returns the usable entries and how many were rejected.
 */
export function parseMemoryCompletionReply(
  text: string,
  active: readonly AgentRpMemorySeedEntry[],
): { readonly entries: readonly AgentRpMemoryCompletionEntry[]; readonly rejectedCount: number } {
  const activeByKey = new Map(active.map(memory => [subjectKey(memory.subject), memory]))
  const titles = new Set<string>()
  const replaced = new Set<string>()
  const entries: AgentRpMemoryCompletionEntry[] = []
  let rejectedCount = 0
  for (const [index, record] of replyRecords(text).entries()) {
    let parsed: ReturnType<typeof timelineEntry>
    try {
      parsed = timelineEntry(record, `时间线条目 ${index + 1} `)
    } catch {
      rejectedCount += 1
      continue
    }
    const { replaces, ...entry } = parsed
    const key = subjectKey(entry.subject)
    // An entry extends the memory it names, or failing that the one already
    // filed under its own title. A title the timeline never had names nothing,
    // and the entry is simply new.
    const existing = (replaces === undefined ? undefined : activeByKey.get(subjectKey(replaces)))
      ?? activeByKey.get(key)
    const target = existing === undefined ? undefined : subjectKey(existing.subject)
    if (titles.has(key) || (target !== undefined && replaced.has(target))
      || entries.length >= AGENT_RP_MEMORY_COMPLETION_MAX_ENTRIES) {
      rejectedCount += 1
      continue
    }
    if (existing !== undefined && target === key && existing.kind === entry.kind && existing.text === entry.text) continue
    titles.add(key)
    if (existing === undefined || target === undefined) {
      entries.push(entry)
      continue
    }
    replaced.add(target)
    entries.push({ ...entry, replaces: { subject: existing.subject, kind: existing.kind, text: existing.text } })
  }
  return { entries, rejectedCount }
}

async function completionRequest(
  ctx: Context,
  route: Pick<GenerateOptions, 'provider' | 'model'>,
  evidence: string,
  signal: AbortSignal,
): Promise<GenerateOptions> {
  // Only the route is inherited. The Session's sampling scalars, stop strings
  // and output cap were chosen for prose and would cut a JSON reply short.
  const effort = await negotiateWorkerReasoningEffort(ctx, route, 'off', signal)
  return {
    provider: route.provider,
    model: route.model,
    ...effort.config,
    temperature: 0.2,
    maxTokens: effort.reasoningOff ? MEMORY_COMPLETION_MAX_TOKENS : MEMORY_COMPLETION_REASONING_MAX_TOKENS,
    system: MEMORY_COMPLETION_SYSTEM,
    messages: [createUserMessage({
      source: { kind: 'agent-rp', plugin: 'dsh-agent-rp-memory-completion' },
      content: [{ type: 'text', text: evidence }],
    })],
    signal,
  }
}

/**
 * Propose the timeline entries a Session's transcript has not been given yet.
 *
 * The model reads every visible floor together with all active memory and works
 * out for itself where the record stops. Which floors a branch will drop does
 * not enter into it: memory is brought up to the latest floor, so whatever the
 * branch cuts has already been recorded.
 *
 * Nothing is written: the source Session stays as it is, and the proposal only
 * becomes durable when the player launches the branch with it.
 * @param input - Session to read, the route and the player's guidance.
 * @returns the proposal, for review in the floor panel.
 */
export async function completeAgentRpMemory(input: {
  readonly ctx: Context
  readonly session: Session
  readonly route: Pick<GenerateOptions, 'provider' | 'model'>
  readonly instruction?: string
  readonly previous?: readonly AgentRpMemorySeedEntry[]
  readonly signal: AbortSignal
}): Promise<AgentRpMemoryCompletionResponse> {
  const floors = roleplayChatFloors(input.session)
  if (floors.length === 0) throw new Error('这段会话还没有楼层，没有可以记录的内容')
  const events = input.session.snapshotEvents()
  const active = readAgentRpMemoryHistory(events).active
  const character = readActiveSessionCharacter(events)?.result
  const request = await completionRequest(input.ctx, input.route, memoryCompletionEvidence({
    active,
    floors,
    timeMarkers: memoryCompletionTimeMarkers(events, floors),
    ...(character?.name === undefined ? {} : { characterName: character.name }),
    ...(character?.userName === undefined ? {} : { userName: character.userName }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  }), input.signal)
  const assembler = new BlockAssembler()
  for await (const chunk of input.ctx.llm.stream(request)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'aborted') throw new Error('记忆补全已取消')
  if (finish.kind === 'error') throw new Error(`记忆补全请求失败：${finish.failure.message}`)
  const reply = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const parsed = parseMemoryCompletionReply(reply, active)
  return {
    format: 0,
    entries: parsed.entries,
    floorCount: floors.length,
    activeCount: active.length,
    rejectedCount: parsed.rejectedCount,
    provider: request.provider,
    model: request.model,
  }
}
