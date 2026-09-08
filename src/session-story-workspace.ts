/** Durable selection of one editable story workspace for a Roleplay Session. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { appendAgentRpSessionEvent, supportsAgentRpSessionEvents } from './session-event-compat.ts'
import { StoryWorkspaceStore } from './story-workspace.ts'

/** User-authored selection event applied before later story turns. */
export interface SessionStoryWorkspaceSelectionRecord {
  readonly format: 0
  readonly workspaceId?: string
  readonly sourceEventSeq: number
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Ignorable user selection of the story workspace that prepares future turns. */
    'agent-rp/story-workspace-selection': SessionStoryWorkspaceSelectionRecord
  }
}

interface StoryWorkspaceCommandRequest {
  readonly format: 0
  readonly workspaceId: string | null
}

function parseRequest(rawInput: string): StoryWorkspaceCommandRequest {
  let value: unknown
  try {
    value = JSON.parse(rawInput) as unknown
  } catch (error: unknown) {
    throw new Error('故事工作区命令不是有效 JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('故事工作区命令不是对象')
  const record = value as Record<string, unknown>
  if (record.format !== 0 || !(record.workspaceId === null || typeof record.workspaceId === 'string')
    || Object.keys(record).some(key => key !== 'format' && key !== 'workspaceId')) {
    throw new Error('故事工作区命令字段无效')
  }
  return record as unknown as StoryWorkspaceCommandRequest
}

/** Return the latest explicitly selected story workspace, including a later clear. */
export function readSessionStoryWorkspaceId(events: readonly SessionEvent[]): string | undefined {
  let active: string | undefined
  for (const event of events) {
    if (event.type !== 'agent-rp/story-workspace-selection') continue
    if (event.data.format !== 0 || !Number.isSafeInteger(event.data.sourceEventSeq)
      || event.data.sourceEventSeq < 0 || event.data.sourceEventSeq >= event.seq) {
      throw new Error('故事工作区 Session 事件无效')
    }
    const source = events[event.data.sourceEventSeq]
    if (source?.type !== 'command/run' || source.data.name !== 'rp-story-workspace'
      || source.data.source.kind !== 'user') {
      throw new Error('故事工作区选择没有对应的用户命令')
    }
    active = event.data.workspaceId
  }
  return active
}

/** Apply or clear one Session-owned story workspace without invoking a model. */
export function executeStoryWorkspaceCommand(
  store: StoryWorkspaceStore,
  invocation: {
    readonly commandId: CommandId
    readonly agent: Agent
    readonly rawInput: string
  },
): { readonly kind: 'success'; readonly sourceEventSeq: SessionSeq } {
  if (!supportsAgentRpSessionEvents(invocation.agent.session)) {
    throw new Error('当前 DSH Host 缺少安全插件事件能力，无法启用故事工作区')
  }
  const request = parseRequest(invocation.rawInput)
  if (request.workspaceId !== null) store.get(request.workspaceId)
  const source = invocation.agent.session.snapshotEvents().findLast(event => event.type === 'command/run'
    && String(event.data.commandId) === String(invocation.commandId))
  if (source?.type !== 'command/run' || source.data.name !== 'rp-story-workspace'
    || source.data.source.kind !== 'user') {
    throw new Error('故事工作区命令不是当前 Session 事件')
  }
  appendAgentRpSessionEvent(invocation.agent.session, 'agent-rp/story-workspace-selection', {
    format: 0,
    ...(request.workspaceId === null ? {} : { workspaceId: request.workspaceId }),
    sourceEventSeq: source.seq,
  })
  return { kind: 'success', sourceEventSeq: source.seq }
}
