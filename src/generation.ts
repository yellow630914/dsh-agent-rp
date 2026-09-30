/**
 * Persistent Roleplay reply versions.
 *
 * The player-facing reply-version commands (regenerate / continue / select /
 * rewrite-input) were removed: they were the plugin's densest bug surface and
 * the player replaced them with export -> migrate. What remains is the substrate
 * the automatic narrative-review Worker needs to register a reviewed reply
 * without losing the character Agent's original, plus the readers that replay
 * and chat export use on sessions written while the commands existed.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  type AssistantMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  decodeGenerationCommandResult,
  encodeGenerationCommandResult,
} from './generation-command-result.ts'
import { readCurrentSessionMvuStateFromLorebooks } from './mvu.ts'
import { configuredLorebook, readWorldInfoConfiguration } from './world-info-configuration-core.ts'
import { readActiveSessionLorebookSourcesFromEvents } from './world-info-configuration.ts'
import {
  decodeTavernHelperState,
  encodeTavernHelperState,
  readTavernHelperStateSnapshot,
  readTavernHelperStateSnapshotAt,
  type TavernHelperState,
} from './tavern-helper.ts'
import { appendAgentRpSessionEvent, supportsAgentRpSessionEvents } from './session-event-compat.ts'
import { roleplaySurfaceNodes, roleplaySurfaceOverride } from './roleplay-surface-overlay.ts'

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

/** A validated reply-version group reconstructed from the latest snapshot event. */
export interface ActiveGenerationGroup extends GenerationStateRecord {
  readonly eventSeq: number
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
    // `regenerate` / `continue` / `select` / `rewrite-input` no longer have a
    // producer — only `review` does. They stay admitted because sessions written
    // before their removal carry them, and replay must keep reading those rows.
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

function sourceSeqs(nodes: readonly number[], selectedVersionSeq: number): number[] {
  return [...new Set([...nodes, selectedVersionSeq])]
}

function appendCurrentReplySurface(
  agent: Agent,
  currentSurfaceSeq: number,
  selected: Extract<SessionEvent, { type: 'assistant/message' }>,
  content?: ContentBlock[],
): Extract<SessionEvent, { type: 'assistant/message' }> {
  const nodes = [...roleplaySurfaceNodes(agent.session)]
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
    roleplaySurfaceOverride([replacement.seq], superseded),
  )
  return replacement
}

/** Return the final visible non-empty assistant reply produced in one turn. */
export function currentVisibleRoleplayReply(
  agent: Agent,
  turn: number,
): Extract<SessionEvent, { type: 'assistant/message' }> | undefined {
  return [...roleplaySurfaceNodes(agent.session)].reverse()
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

function mvuSnapshot(agent: Agent): GenerationStateRecord['mvu'] {
  const configuration = readWorldInfoConfiguration(agent.session.snapshotEvents())
  const lorebooks = readActiveSessionLorebookSourcesFromEvents(agent.session.snapshotEvents())
    .map(source => configuredLorebook(source, configuration).lorebook)
  return readCurrentSessionMvuStateFromLorebooks(lorebooks, agent.session)
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
