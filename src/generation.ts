/** Persistent Roleplay reply versions and direct generation commands. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createUserMessage,
  type AssistantMessage,
  type ContentBlock,
  type MessageSource,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  decodeGenerationCommandResult,
  encodeGenerationCommandResult,
} from './generation-command-result.ts'
import {
  appendMvuState,
  applyMvuReply,
  MVU_ROLEPLAY_STATE_ID,
  readCurrentMvuStateFromLorebooks,
  readCurrentSessionMvuStateFromLorebooks,
} from './mvu.ts'
import { configuredLorebook, readWorldInfoConfiguration } from './world-info-configuration-core.ts'
import { readActiveSessionLorebookSourcesFromEvents } from './world-info-configuration.ts'
import {
  appendTavernHelperState,
  decodeTavernHelperState,
  encodeTavernHelperState,
  readTavernHelperStateSnapshot,
  readTavernHelperStateSnapshotAt,
  TAVERN_HELPER_ROLEPLAY_STATE_ID,
  type TavernHelperState,
} from './tavern-helper.ts'
import { prepareTavernHelperState } from './tavern-helper-command.ts'
import {
  roleplayPresentedState,
} from './roleplay-turn-presentation-state.ts'
import type {
  RoleplayTurnPresentation,
} from './roleplay-turn-presentation-types.ts'
import { appendAgentRpSessionEvent, supportsAgentRpSessionEvents } from './session-event-compat.ts'
import { roleplaySurfaceOverride } from './roleplay-surface-overlay.ts'

/** A complete reply-version group snapshot stored after every mutation. */
export interface GenerationStateRecord {
  readonly format: 0
  readonly groupId: string
  readonly operation: 'regenerate' | 'continue' | 'select' | 'review' | 'rewrite-input'
  readonly originSeq: number
  readonly anchorSeq: number
  readonly assistantSeqs: readonly number[]
  readonly versions: readonly {
    readonly seq: number
    readonly text: string
    /** Assistant replies whose tool-stage decisions compose this visible version. */
    readonly artifactReplySeqs?: readonly number[]
    readonly tavernStateSeq?: number
    readonly mvu?: {
      readonly statData: JsonValue
      readonly updateCount: number
      readonly lastError?: string
    }
  }[]
  readonly baseTavernStateSeq?: number
  readonly baseMvu?: {
    readonly statData: JsonValue
    readonly updateCount: number
    readonly lastError?: string
  }
  readonly selectedVersionSeq: number
  readonly surfaceSeq: number
  /**
   * User row superseded by `rewrite-input`, with the text that replaced it.
   *
   * The Host transcript is built from append-origin events only — a surface
   * replacement stays model-visible and never becomes a row — so the edited
   * message cannot appear on its own. The display planner instead renders this
   * text into the original row, the same way a reply version renders into its
   * anchor.
   */
  readonly rewrittenInput?: {
    readonly seq: number
    readonly text: string
  }
  readonly tavern?: TavernHelperState
  readonly mvu?: {
    readonly statData: JsonValue
    readonly updateCount: number
    readonly lastError?: string
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Ignorable reply-version snapshot written by an automatic post-narrative Worker. */
    'agent-rp/generation-state': GenerationStateRecord
  }
}

/** Browser request sent through the private generation command. */
export type GenerationRequest =
  | { readonly operation: 'regenerate'; readonly replySeq: number }
  | { readonly operation: 'continue'; readonly replySeq: number }
  | { readonly operation: 'select'; readonly replySeq: number; readonly versionIndex: number }
  /**
   * Replace the last turn's user message and answer it again. Unlike the
   * `rewrite` Session launch this edits the current Session in place, and
   * unlike `regenerate` it keeps no version of the discarded reply.
   */
  | { readonly operation: 'rewrite-input'; readonly replySeq: number; readonly text: string }

/** A validated reply-version group reconstructed from the latest snapshot event. */
export interface ActiveGenerationGroup extends GenerationStateRecord {
  readonly eventSeq: number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function eventSeq(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`)
  return value
}

/** Parse one browser generation request without accepting extra fields. */
export function parseGenerationRequest(source: string): GenerationRequest {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new Error('回复操作请求不是有效 JSON', { cause: error })
  }
  const request = object(value, '回复操作请求')
  const replySeq = eventSeq(request.replySeq, '回复序号')
  if (request.operation === 'regenerate' || request.operation === 'continue') {
    if (Object.keys(request).some(key => key !== 'operation' && key !== 'replySeq')) throw new Error('回复操作请求包含未知字段')
    return { operation: request.operation, replySeq }
  }
  if (request.operation === 'select') {
    const versionIndex = eventSeq(request.versionIndex, '版本序号')
    if (Object.keys(request).some(key => key !== 'operation' && key !== 'replySeq' && key !== 'versionIndex')) {
      throw new Error('回复操作请求包含未知字段')
    }
    return { operation: 'select', replySeq, versionIndex }
  }
  if (request.operation === 'rewrite-input') {
    if (typeof request.text !== 'string' || request.text.trim() === '' || request.text.length > 8_000
      || Object.keys(request).some(key => key !== 'operation' && key !== 'replySeq' && key !== 'text')) {
      throw new Error('修改输入请求字段无效')
    }
    return { operation: 'rewrite-input', replySeq, text: request.text }
  }
  throw new Error('未知的回复操作')
}

function uniqueSeqs(value: readonly number[], label: string): readonly number[] {
  if (value.length === 0 || value.some(seq => !Number.isSafeInteger(seq) || seq < 0)
    || new Set(value).size !== value.length) throw new Error(`${label}无效`)
  return value
}

function validMvu(value: GenerationStateRecord['mvu']): boolean {
  return value === undefined || (Number.isSafeInteger(value.updateCount) && value.updateCount >= 0
    && (value.lastError === undefined || typeof value.lastError === 'string'))
}

function validTavern(value: GenerationStateRecord['tavern']): boolean {
  if (value === undefined) return true
  try {
    return decodeTavernHelperState(encodeTavernHelperState(value)) !== undefined
  } catch {
    return false
  }
}

function validArtifactReplySeqs(value: readonly number[] | undefined): boolean {
  return value === undefined || (value.length > 0
    && value.every(seq => Number.isSafeInteger(seq) && seq >= 0)
    && new Set(value).size === value.length)
}

function parseGenerationState(data: GenerationStateRecord, eventSeq: number): ActiveGenerationGroup {
  const assistantSeqs = uniqueSeqs(data.assistantSeqs, '回复来源序号')
  const versionSeqs = uniqueSeqs(data.versions.map(version => version.seq), '回复版本序号')
  if (data.format !== 0 || !/^[0-9a-f-]{36}$/iu.test(data.groupId)
    || (data.operation !== 'regenerate' && data.operation !== 'continue'
      && data.operation !== 'select' && data.operation !== 'review' && data.operation !== 'rewrite-input')
    || (data.rewrittenInput !== undefined
      && (typeof data.rewrittenInput !== 'object' || data.rewrittenInput === null
        || !Number.isSafeInteger(data.rewrittenInput.seq) || data.rewrittenInput.seq < 0
        || typeof data.rewrittenInput.text !== 'string' || data.rewrittenInput.text.trim() === ''))
    || !Number.isSafeInteger(data.originSeq) || data.originSeq < 0
    || !Number.isSafeInteger(data.anchorSeq) || data.anchorSeq < 0
    || !Number.isSafeInteger(data.selectedVersionSeq) || data.selectedVersionSeq < 0
    || !Number.isSafeInteger(data.surfaceSeq) || data.surfaceSeq < 0
    || (data.baseTavernStateSeq !== undefined
      && (!Number.isSafeInteger(data.baseTavernStateSeq) || data.baseTavernStateSeq < 0))
    || data.versions.some(version => typeof version.text !== 'string' || version.text.trim() === '')
    || data.versions.some(version => version.tavernStateSeq !== undefined
      && (!Number.isSafeInteger(version.tavernStateSeq) || version.tavernStateSeq < 0))
    || data.versions.some(version => !validArtifactReplySeqs(version.artifactReplySeqs))
    || data.versions.some(version => !validMvu(version.mvu))
    || !validMvu(data.baseMvu) || !validMvu(data.mvu) || !validTavern(data.tavern)
    || versionSeqs[0] !== data.originSeq
    || !versionSeqs.includes(data.selectedVersionSeq)
    || !assistantSeqs.includes(data.originSeq)) throw new Error('回复版本事件无效')
  return { ...data, eventSeq }
}

/** Encode one complete reply-version snapshot into a supported command result. */
export function encodeGenerationState(data: GenerationStateRecord): string {
  return encodeGenerationCommandResult(data)
}

/** Decode one reply-version snapshot, declining unrelated command output. */
export function decodeGenerationState(source: string | undefined): GenerationStateRecord | undefined {
  return decodeGenerationCommandResult(source) as unknown as GenerationStateRecord | undefined
}

/** Fold the latest durable snapshot for every reply group. */
export function readGenerationGroups(events: readonly SessionEvent[]): readonly ActiveGenerationGroup[] {
  const groups = new Map<string, ActiveGenerationGroup>()
  for (const event of events) {
    const data = event.type === 'command/done' && event.data.kind === 'success'
      ? decodeGenerationState(event.data.text)
      : event.type === ('agent-rp/generation-state' as SessionEvent['type'])
        ? (event as SessionEvent & { readonly data: GenerationStateRecord }).data
        : undefined
    if (data === undefined) continue
    const group = parseGenerationState(data, event.seq)
    for (const seq of [...group.assistantSeqs, ...group.versions.map(version => version.seq), group.anchorSeq, group.surfaceSeq]) {
      if (seq >= event.seq || events[seq]?.type !== 'assistant/message') throw new Error('回复版本引用了不存在的助手消息')
    }
    for (const seq of group.versions.flatMap(version => version.artifactReplySeqs ?? [])) {
      if (seq >= event.seq || events[seq]?.type !== 'assistant/message') throw new Error('回复版本引用了不存在的产物来源')
    }
    for (const seq of [group.baseTavernStateSeq, ...group.versions.map(version => version.tavernStateSeq)]) {
      if (seq === undefined) continue
      if (seq >= event.seq) throw new Error('回复版本引用了未来的脚本状态')
      readTavernHelperStateSnapshotAt(events, seq)
    }
    groups.set(group.groupId, group)
  }
  return [...groups.values()].sort((left, right) => left.eventSeq - right.eventSeq)
}

function assistantEvent(events: readonly SessionEvent[], seq: number): Extract<SessionEvent, { type: 'assistant/message' }> {
  const event = events[seq]
  if (event?.type !== 'assistant/message') throw new Error('目标回复不存在')
  return event
}

function visibleText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

function replacementMessage(message: AssistantMessage, content: ContentBlock[] = message.content): AssistantMessage {
  const { kind: _kind, ...source } = message.source
  if (JSON.stringify(content) === JSON.stringify(message.content)) {
    return createAssistantMessage({ content, source })
  }
  // Adapter replay metadata describes the exact provider response. Regeneration placeholders and
  // continued replies change that response, so retaining the old state would pair one provider's
  // signatures/block map with different durable content on the next model request.
  const { replayState: _replayState, ...portableSource } = source
  return createAssistantMessage({ content, source: portableSource })
}

function continuedContent(before: readonly ContentBlock[], continuation: readonly ContentBlock[]): ContentBlock[] {
  const result = structuredClone([...before, ...continuation])
  const joinAt = before.length - 1
  const left = result[joinAt]
  const right = result[joinAt + 1]
  if (left?.type === 'text' && right?.type === 'text') {
    result.splice(joinAt, 2, { type: 'text', text: `${left.text}${right.text}` })
  }
  return result
}

function sourceSeqs(nodes: readonly number[], selectedVersionSeq: number): number[] {
  return [...new Set([...nodes, selectedVersionSeq])]
}

function appendCurrentReplySurface(
  agent: Agent,
  currentSurfaceSeq: number,
  selected: Extract<SessionEvent, { type: 'assistant/message' }>,
  content?: ContentBlock[],
): Extract<SessionEvent, { type: 'assistant/message' }> {
  const nodes = [...agent.session.surface.nodes]
  const startIndex = nodes.indexOf(SessionSeq(currentSurfaceSeq))
  if (startIndex < 0) throw new Error('回复已不在当前对话末尾')
  const superseded = sourceSeqs(nodes.slice(startIndex), selected.seq)
  if (superseded.length === 0) throw new Error('当前回复不可替换')
  // DSH 0.1.3 forbids sourceEventSeqs on assistant/message, so a reply can no
  // longer replace surface nodes. Append the version and record the
  // supersession for Agent RP's own model-visible overlay instead.
  const replacement = agent.session.append('assistant/message', {
    turn: selected.data.turn,
    step: selected.data.step,
    message: replacementMessage(selected.data.message, content),
    // The v2 embedded stream only describes the original text, so replaced content drops it.
    stream: content === undefined ? selected.data.stream : [],
    ...(selected.data.usage === undefined || content !== undefined ? {} : { usage: selected.data.usage }),
  }, { surfaceOp: 'append' })
  appendAgentRpSessionEvent(
    agent.session,
    'agent-rp/surface-override',
    roleplaySurfaceOverride(replacement.seq, superseded),
  )
  return replacement
}

/** Return the final visible non-empty assistant reply produced in one turn. */
export function currentVisibleRoleplayReply(
  agent: Agent,
  turn: number,
): Extract<SessionEvent, { type: 'assistant/message' }> | undefined {
  return [...agent.session.surface.nodes].reverse()
    .map(seq => agent.session.snapshotEvents()[seq])
    .find((event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
      event?.type === 'assistant/message' && event.data.turn === turn && visibleText(event) !== '')
}

/** Register a reviewed current reply as a selectable version without losing the character Agent's original. */
export function appendReviewedReplyVersion(
  agent: Agent,
  turn: number,
  reviewedText: string,
): { readonly originalSeq: number; readonly reviewedSeq: number; readonly stateEventSeq: number } {
  if (!supportsAgentRpSessionEvents(agent.session)) {
    throw new Error('当前 DSH Host 无法记录正文 Worker 的可回放结果')
  }
  const original = currentVisibleRoleplayReply(agent, turn)
  if (original === undefined) throw new Error('正文 Worker 找不到本轮可见角色回复')
  const originalText = visibleText(original)
  const content: ContentBlock[] = [{ type: 'text', text: reviewedText }]
  const reviewed = appendCurrentReplySurface(agent, original.seq, original, content)
  const tavern = readTavernHelperStateSnapshot(agent.session.snapshotEvents())
  const mvu = mvuSnapshot(agent)
  const shared = {
    ...(tavern === undefined ? {} : { tavernStateSeq: tavern.eventSeq }),
    ...(mvu === undefined ? {} : { mvu }),
  }
  const state = appendState({
    groupId: crypto.randomUUID(),
    operation: 'review',
    originSeq: original.seq,
    anchorSeq: original.seq,
    assistantSeqs: [original.seq, reviewed.seq],
    versions: [
      { seq: original.seq, text: originalText, artifactReplySeqs: [original.seq], ...shared },
      { seq: reviewed.seq, text: reviewedText.trim(), artifactReplySeqs: [original.seq], ...shared },
    ],
    selectedVersionSeq: reviewed.seq,
    surfaceSeq: reviewed.seq,
  }, mvu, tavern?.state)
  const stateEvent = appendAgentRpSessionEvent(agent.session, 'agent-rp/generation-state', state)
  return { originalSeq: original.seq, reviewedSeq: reviewed.seq, stateEventSeq: stateEvent.seq }
}

function latestReply(
  agent: Agent,
  replySeq: number,
): { readonly group?: ActiveGenerationGroup; readonly surfaceSeq: number; readonly selectedSeq: number } {
  const events = agent.session.snapshotEvents()
  const surfaceSeq = agent.session.surface.nodes.at(-1)
  if (surfaceSeq === undefined) throw new Error('当前会话还没有角色回复')
  const groups = readGenerationGroups(events)
  const group = groups.findLast(candidate => candidate.anchorSeq === replySeq)
  if (group !== undefined) {
    if (group.surfaceSeq !== surfaceSeq) {
      const currentSurface = assistantEvent(events, surfaceSeq)
      const selected = group.versions.find(version => version.seq === group.selectedVersionSeq)
      if (selected === undefined || visibleText(currentSurface) !== selected.text) {
        throw new Error('只能操作对话末尾的角色回复')
      }
    }
    return { group, surfaceSeq, selectedSeq: group.selectedVersionSeq }
  }
  const reply = assistantEvent(events, replySeq)
  if (reply.surfaceOp !== 'append' || surfaceSeq !== reply.seq || visibleText(reply) === '') {
    throw new Error('只能操作对话末尾的角色回复')
  }
  return { surfaceSeq, selectedSeq: reply.seq }
}

function mvuSnapshot(agent: Agent): GenerationStateRecord['mvu'] {
  const configuration = readWorldInfoConfiguration(agent.session.snapshotEvents())
  const lorebooks = readActiveSessionLorebookSourcesFromEvents(agent.session.snapshotEvents())
    .map(source => configuredLorebook(source, configuration).lorebook)
  return readCurrentSessionMvuStateFromLorebooks(lorebooks, agent.session)
}

function mvuBeforeReply(agent: Agent, replySeq: number): GenerationStateRecord['mvu'] {
  const configuration = readWorldInfoConfiguration(agent.session.snapshotEvents())
  const lorebooks = readActiveSessionLorebookSourcesFromEvents(agent.session.snapshotEvents())
    .map(source => configuredLorebook(source, configuration).lorebook)
  const visiblePrefix = new Set(agent.session.surface.nodes.filter(seq => seq < replySeq))
  return readCurrentMvuStateFromLorebooks(lorebooks, agent.session.snapshotEvents()
    .slice(0, replySeq)
    .filter(event => event.type !== 'assistant/message' || visiblePrefix.has(event.seq)))
}

function continuedMvuState(
  current: GenerationStateRecord['mvu'],
  generated: Extract<SessionEvent, { type: 'assistant/message' }>,
): GenerationStateRecord['mvu'] {
  if (current === undefined) return undefined
  try {
    const update = applyMvuReply(current.statData, visibleText(generated))
    return update === undefined
      ? current
      : { statData: update.statData, updateCount: current.updateCount + 1 }
  } catch (error: unknown) {
    return { ...current, lastError: error instanceof Error ? error.message : String(error) }
  }
}

function appendState(
  record: Omit<GenerationStateRecord, 'format' | 'mvu'>,
  mvu: GenerationStateRecord['mvu'],
  tavern: GenerationStateRecord['tavern'],
): GenerationStateRecord {
  return {
    format: 0,
    ...record,
    ...(tavern === undefined ? {} : { tavern }),
    ...(mvu === undefined ? {} : { mvu }),
  }
}

function appendMvuSelection(agent: Agent, mvu: GenerationStateRecord['mvu']): void {
  if (mvu !== undefined && supportsAgentRpSessionEvents(agent.session)) appendMvuState(agent.session, mvu)
}

function selectedTavernState(
  agent: Agent,
  eventSeq: number | undefined,
): TavernHelperState | undefined {
  return eventSeq === undefined
    ? undefined
    : readTavernHelperStateSnapshotAt(agent.session.snapshotEvents(), eventSeq).state
}

function latestPresentationForReply(
  events: readonly SessionEvent[],
  replySeq: number,
): RoleplayTurnPresentation | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-rp/turn-presentation') continue
    if (event.data.selectedReply?.sourceSeq === replySeq || event.data.selectedReply?.surfaceSeq === replySeq) {
      return event.data
    }
  }
  return undefined
}

function restoreTavernState(agent: Agent, state: TavernHelperState | undefined): number | undefined {
  if (state === undefined || !supportsAgentRpSessionEvents(agent.session)) return undefined
  return appendTavernHelperState(agent.session, state).eventSeq
}

function initialTavernState(agent: Agent): TavernHelperState | undefined {
  return readTavernHelperStateSnapshot(agent.session.snapshotEvents()) === undefined
    ? undefined
    : prepareTavernHelperState(agent, undefined)
}

type GenerateOperation = 'regenerate' | 'continue' | 'rewrite-input'

function instruction(operation: GenerateOperation): string {
  if (operation === 'continue') {
    return 'Continue the latest in-character response seamlessly from its final sentence. Do not repeat or summarize any existing text. Output only the continuation.'
  }
  if (operation === 'rewrite-input') {
    // The discarded reply answered the message the player just replaced, so
    // this is a first answer to a new message, not an alternative to an
    // existing one.
    return 'The player has revised their latest message. Answer the revised message in character as if replying to it for the first time. Do not mention the revision, and do not reference or continue any earlier reply. Output only the roleplay response.'
  }
  return 'Write a fresh alternative response to the latest user turn. Stay fully in character and preserve established facts, but do not mention, summarize, revise, or continue the previous response. Output only the replacement roleplay response.'
}

function generationSummary(operation: GenerateOperation): string {
  if (operation === 'continue') return '正在续写角色回复'
  return operation === 'rewrite-input' ? '正在按修改后的输入重新生成' : '正在重写角色回复'
}

async function generate(agent: Agent, operation: GenerateOperation, signal: AbortSignal): Promise<number> {
  if (agent.status !== 'idle' || agent.inbox.hasPending) throw new Error('请等待当前回复完成后再操作')
  const before = agent.session.seq
  const onAbort = (): void => { agent.cancel({ kind: 'user' }) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: instruction(operation) }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-agent-rp-generation',
        operation,
        form: 'notice',
        summary: generationSummary(operation),
      } as MessageSource,
    }))
    await agent.whenIdle()
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  const generated = agent.session.snapshotEvents().slice(before)
    .findLast((event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
      event.type === 'assistant/message' && event.surfaceOp === 'append')
  if (generated === undefined || visibleText(generated) === '') throw new Error('模型没有生成可用的角色回复')
  return generated.seq
}

/**
 * Replace the last turn's user message and answer it again in place.
 *
 * The discarded reply is shadowed on the surface rather than kept as a version:
 * a version group holds alternative answers to the *same* message, and after an
 * edit the old reply answers a message that no longer exists. The Session log
 * still holds every original event; only the surface changes.
 */
async function executeInputRewrite(
  agent: Agent,
  request: Extract<GenerationRequest, { operation: 'rewrite-input' }>,
  signal: AbortSignal,
): Promise<{ readonly kind: 'success'; readonly text: string; readonly sourceEventSeq: SessionSeq }> {
  const nodes = agent.session.surface.nodes
  const replyIndex = nodes.indexOf(SessionSeq(request.replySeq))
  if (replyIndex < 0 || replyIndex !== nodes.length - 1) throw new Error('只能修改对话末尾这一轮的输入')
  const events = agent.session.snapshotEvents()
  const reply = assistantEvent(events, request.replySeq)
  // Everything from the player's message to the end of the surface is replaced,
  // so any notice or tool result this turn put on the surface goes with it.
  const userIndex = nodes.slice(0, replyIndex).findLastIndex(seq => {
    const event = events[seq]
    return event?.type === 'user/message' && event.data.source.kind === 'user'
  })
  const userSeq = userIndex < 0 ? undefined : nodes[userIndex]
  const userEvent = userSeq === undefined ? undefined : events[userSeq]
  if (userSeq === undefined || userEvent?.type !== 'user/message') {
    throw new Error('这一轮没有可修改的用户消息')
  }
  if (userEvent.data.content.some(block => block.type !== 'text')) {
    throw new Error('这一轮的用户消息含附件，暂时不能修改')
  }
  const currentTavern = readTavernHelperStateSnapshot(events)
  const currentMvu = mvuSnapshot(agent)
  const baseMvu = mvuBeforeReply(agent, request.replySeq)
  const baseTavern = readTavernHelperStateSnapshot(events, request.replySeq)?.state
  if ((baseTavern !== undefined || baseMvu !== undefined) && !supportsAgentRpSessionEvents(agent.session)) {
    throw new Error('当前 DSH Host 缺少安全插件事件能力，无法重新生成含状态的回复')
  }
  let baseTavernStateSeq: number | undefined
  const shadowed = nodes.slice(userIndex)
  const replacement = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: request.text }],
    source: userEvent.data.source,
  }), {
    surfaceOp: { op: 'replace', start: SessionSeq(userSeq), end: SessionSeq(request.replySeq) },
    sourceEventSeqs: [...shadowed],
  })
  try {
    // Answer the revised message from the state this turn started with, the
    // same baseline `regenerate` restores.
    baseTavernStateSeq = restoreTavernState(
      agent,
      baseTavern ?? (currentTavern === undefined ? undefined : initialTavernState(agent)),
    )
    appendMvuSelection(agent, baseMvu)
    const generatedSeq = await generate(agent, 'rewrite-input', signal)
    const generated = assistantEvent(agent.session.snapshotEvents(), generatedSeq)
    const after = agent.session.surface.nodes
    const shadowStart = after[after.indexOf(replacement.seq) + 1]
    const surface = shadowStart === undefined
      ? generated
      : appendCurrentReplySurface(agent, shadowStart, generated)
    // The transcript keeps showing the rows that were appended — the original
    // message and the discarded reply — because a surface replacement never
    // becomes a row. Anchoring a group on those rows is what lets the display
    // planner render the new text into them, exactly as `regenerate` does.
    // A single version means no version switcher: the old reply is gone, not
    // parked behind an arrow.
    const state = appendState({
      groupId: crypto.randomUUID(),
      operation: 'rewrite-input',
      originSeq: generatedSeq,
      anchorSeq: request.replySeq,
      assistantSeqs: [request.replySeq, generatedSeq],
      versions: [{ seq: generatedSeq, text: visibleText(generated), artifactReplySeqs: [generatedSeq] }],
      selectedVersionSeq: generatedSeq,
      surfaceSeq: surface.seq,
      rewrittenInput: { seq: userSeq, text: request.text },
      ...(baseTavernStateSeq === undefined ? {} : { baseTavernStateSeq }),
      ...(baseMvu === undefined ? {} : { baseMvu }),
    }, mvuSnapshot(agent), readTavernHelperStateSnapshot(agent.session.snapshotEvents())?.state)
    return { kind: 'success', text: encodeGenerationState(state), sourceEventSeq: SessionSeq(state.surfaceSeq) }
  } catch (error: unknown) {
    const current = agent.session.surface.nodes
    const index = current.indexOf(replacement.seq)
    if (index >= 0) {
      const tail = current.slice(index)
      const end = tail.at(-1)
      if (end !== undefined) {
        agent.session.append('user/message', userEvent.data, {
          surfaceOp: { op: 'replace', start: replacement.seq, end },
          sourceEventSeqs: [...tail],
        })
      }
      // An append cites no source events: DSH 0.1.3 reserves the Assistant
      // message's provenance slot for its embedded stream.
      agent.session.append('assistant/message', reply.data, { surfaceOp: 'append' })
    }
    restoreTavernState(agent, currentTavern?.state)
    appendMvuSelection(agent, currentMvu)
    throw error
  }
}

/** Execute Regenerate, Swipe selection, or Continue against the current Roleplay reply. */
export async function executeGenerationCommand(invocation: {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}): Promise<{ readonly kind: 'success'; readonly text: string; readonly sourceEventSeq: SessionSeq }> {
  const request = parseGenerationRequest(invocation.rawInput)
  if (request.operation === 'rewrite-input') {
    return await executeInputRewrite(invocation.agent, request, invocation.signal)
  }
  const current = latestReply(invocation.agent, request.replySeq)
  const events = invocation.agent.session.snapshotEvents()
  const existing = current.group
  const groupId = existing?.groupId ?? crypto.randomUUID()
  const originSeq = existing?.originSeq ?? current.selectedSeq
  const assistantSeqs = [...(existing?.assistantSeqs ?? [originSeq])]
  const currentTavern = readTavernHelperStateSnapshot(events)
  const currentMvu = mvuSnapshot(invocation.agent)
  const versions = [...(existing?.versions ?? [{
    seq: originSeq,
    text: visibleText(assistantEvent(events, originSeq)),
    artifactReplySeqs: [originSeq],
  }])].map(version => version.seq !== current.selectedSeq ? version : {
    ...version,
    ...(currentTavern === undefined ? {} : { tavernStateSeq: currentTavern.eventSeq }),
    ...(currentMvu === undefined ? {} : { mvu: currentMvu }),
  })

  if (request.operation === 'select') {
    let selectedVersion = versions[request.versionIndex]
    if (selectedVersion === undefined) throw new Error('所选回复版本不存在')
    const selectedSeq = selectedVersion.seq
    if (selectedSeq === current.selectedSeq) {
      if (existing === undefined) throw new Error('当前回复还没有其他版本')
      return { kind: 'success', text: encodeGenerationState(existing), sourceEventSeq: SessionSeq(existing.surfaceSeq) }
    }
    const selected = assistantEvent(events, selectedSeq)
    const surface = appendCurrentReplySurface(invocation.agent, current.surfaceSeq, selected)
    const presented = latestPresentationForReply(invocation.agent.session.snapshotEvents(), selectedSeq)
    const presentedTavern = roleplayPresentedState(presented, TAVERN_HELPER_ROLEPLAY_STATE_ID)
    const presentedTavernStateSeq = presentedTavern?.eventSeq
    if (presentedTavernStateSeq !== undefined && presentedTavernStateSeq !== selectedVersion.tavernStateSeq) {
      selectedVersion = { ...selectedVersion, tavernStateSeq: presentedTavernStateSeq }
      versions[request.versionIndex] = selectedVersion
    }
    const selectedVersionState = selectedTavernState(invocation.agent, selectedVersion.tavernStateSeq)
      ?? (currentTavern === undefined ? undefined : initialTavernState(invocation.agent))
    restoreTavernState(invocation.agent, selectedVersionState)
    const presentedMvu = roleplayPresentedState(presented, MVU_ROLEPLAY_STATE_ID)
    const mvuOwnedByPresentedTavern = presentedMvu?.eventSeq !== undefined
      && presentedMvu.eventSeq === presentedTavern?.eventSeq
    if (selectedVersion.mvu !== undefined && !mvuOwnedByPresentedTavern) {
      appendMvuSelection(invocation.agent, selectedVersion.mvu)
    }
    const state = appendState({
      groupId, operation: 'select', originSeq,
      anchorSeq: existing?.anchorSeq ?? originSeq,
      assistantSeqs, versions, selectedVersionSeq: selectedSeq, surfaceSeq: surface.seq,
      ...(existing?.baseTavernStateSeq === undefined ? {} : { baseTavernStateSeq: existing.baseTavernStateSeq }),
      ...(existing?.baseMvu === undefined ? {} : { baseMvu: existing.baseMvu }),
    }, selectedVersion.mvu, selectedVersionState)
    return { kind: 'success', text: encodeGenerationState(state), sourceEventSeq: SessionSeq(state.surfaceSeq) }
  }

  let generatedSeq: number | undefined
  let replacementStartSeq = current.surfaceSeq
  let baseTavernStateSeq = existing?.baseTavernStateSeq
  const baseMvu = existing?.baseMvu ?? mvuBeforeReply(invocation.agent, originSeq)
  try {
    if (request.operation === 'regenerate') {
      const candidateBaseTavern = baseTavernStateSeq === undefined
        ? readTavernHelperStateSnapshot(events, originSeq)?.state
        : readTavernHelperStateSnapshotAt(events, baseTavernStateSeq).state
      if ((candidateBaseTavern !== undefined || baseMvu !== undefined)
        && !supportsAgentRpSessionEvents(invocation.agent.session)) {
        throw new Error('当前 DSH Host 缺少安全插件事件能力，无法重新生成含状态的回复')
      }
      const selected = assistantEvent(invocation.agent.session.snapshotEvents(), current.selectedSeq)
      replacementStartSeq = appendCurrentReplySurface(
        invocation.agent,
        current.surfaceSeq,
        selected,
        [],
      ).seq
      let baseTavern = candidateBaseTavern
      baseTavern ??= currentTavern === undefined ? undefined : initialTavernState(invocation.agent)
      baseTavernStateSeq = restoreTavernState(invocation.agent, baseTavern) ?? baseTavernStateSeq
      appendMvuSelection(invocation.agent, baseMvu)
    }
    generatedSeq = await generate(invocation.agent, request.operation, invocation.signal)
    const generated = assistantEvent(invocation.agent.session.snapshotEvents(), generatedSeq)
    assistantSeqs.push(generatedSeq)
    let selectedSeq = generatedSeq
    let surface
    if (request.operation === 'continue') {
      const selected = assistantEvent(invocation.agent.session.snapshotEvents(), current.selectedSeq)
      const content = continuedContent(selected.data.message.content, generated.data.message.content)
      surface = appendCurrentReplySurface(invocation.agent, replacementStartSeq, generated, content)
      selectedSeq = surface.seq
      const continuedMvu = continuedMvuState(currentMvu, generated) ?? mvuSnapshot(invocation.agent)
      appendMvuSelection(invocation.agent, continuedMvu)
      versions.push({
        seq: selectedSeq,
        text: content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim(),
        artifactReplySeqs: [...new Set([
          ...(versions.find(version => version.seq === current.selectedSeq)?.artifactReplySeqs
            ?? [current.selectedSeq]),
          generatedSeq,
        ])],
        ...(currentTavern === undefined ? {} : { tavernStateSeq: currentTavern.eventSeq }),
        ...(continuedMvu === undefined ? {} : { mvu: continuedMvu }),
      })
    } else {
      surface = appendCurrentReplySurface(invocation.agent, replacementStartSeq, generated)
      const generatedTavern = readTavernHelperStateSnapshot(invocation.agent.session.snapshotEvents())
      const generatedMvu = mvuSnapshot(invocation.agent)
      versions.push({
        seq: selectedSeq,
        text: visibleText(generated),
        artifactReplySeqs: [generatedSeq],
        ...(generatedTavern === undefined ? {} : { tavernStateSeq: generatedTavern.eventSeq }),
        ...(generatedMvu === undefined ? {} : { mvu: generatedMvu }),
      })
    }
    const selectedVersion = versions.find(version => version.seq === selectedSeq)
    const state = appendState({
      groupId, operation: request.operation, originSeq,
      anchorSeq: existing?.anchorSeq ?? request.replySeq,
      assistantSeqs, versions, selectedVersionSeq: selectedSeq, surfaceSeq: surface.seq,
      ...(baseTavernStateSeq === undefined ? {} : { baseTavernStateSeq }),
      ...(baseMvu === undefined ? {} : { baseMvu }),
    }, selectedVersion?.mvu, selectedVersion === undefined
      ? undefined
      : selectedTavernState(invocation.agent, selectedVersion.tavernStateSeq))
    return { kind: 'success', text: encodeGenerationState(state), sourceEventSeq: SessionSeq(state.surfaceSeq) }
  } catch (error: unknown) {
    const surfaceNodes = invocation.agent.session.surface.nodes
    const restoreRequired = replacementStartSeq !== current.surfaceSeq
      || surfaceNodes.at(-1) !== replacementStartSeq
    if (restoreRequired && surfaceNodes.includes(SessionSeq(replacementStartSeq))) {
      const selected = assistantEvent(invocation.agent.session.snapshotEvents(), current.selectedSeq)
      appendCurrentReplySurface(invocation.agent, replacementStartSeq, selected)
    }
    restoreTavernState(invocation.agent, currentTavern?.state)
    appendMvuSelection(invocation.agent, currentMvu)
    throw error
  }
}
