/** Replay-safe admission for Agent RP events owned outside the DSH repository. */

import {
  Session,
  type SessionEvent,
  type SessionEventMap,
} from '@deepseek-ai/dsh-session'

/** Complete private event vocabulary owned by Agent RP. */
export const AGENT_RP_SESSION_EVENT_TYPES = [
  'agent-rp/act-model-request',
  'agent-rp/act-model-result',
  'agent-rp/character-card-seed',
  'agent-rp/memory-seed',
  'agent-rp/mvu-state',
  'agent-rp/generation-state',
  'agent-rp/narrative-review-request',
  'agent-rp/narrative-review-result',
  'agent-rp/native-prompt-policy-seed',
  'agent-rp/persona-seed',
  'agent-rp/sillytavern-chat-import',
  'agent-rp/sillytavern-preset-seed',
  'agent-rp/story-workspace-selection',
  'agent-rp/surface-override',
  'agent-rp/story-stage-request',
  'agent-rp/story-stage-result',
  'agent-rp/story-turn-brief',
  'agent-rp/story-turn-materialized',
  'agent-rp/story-web-search-request',
  'agent-rp/story-web-search-result',
  'agent-rp/staged-state-request',
  'agent-rp/staged-state-result',
  'agent-rp/state',
  'agent-rp/tavern-generation-request',
  'agent-rp/tavern-generation-result',
  'agent-rp/tavern-message-annotation',
  'agent-rp/tavern-state',
  'agent-rp/tavern-state-attachment',
  'agent-rp/turn-mode',
  'agent-rp/turn-plan',
  'agent-rp/turn-presentation',
  'agent-rp/turn-settlement',
  'agent-rp/turn-worker-result',
  'agent-rp/world-info-library-seed',
] as const

export type AgentRpSessionEventType = typeof AGENT_RP_SESSION_EVENT_TYPES[number]

interface IgnorableSession extends Session {
  appendIgnorable<T extends AgentRpSessionEventType & keyof SessionEventMap>(
    type: T,
    data: SessionEventMap[T],
  ): SessionEvent<T> & { readonly ignorable: true }
}

/** Whether this Host build exposes the replay-safe plugin-event seam at all. */
export function hostSupportsAgentRpSessionEvents(): boolean {
  return typeof (Session.prototype as unknown as Partial<IgnorableSession>).appendIgnorable === 'function'
}

/** Whether this Host can persist plugin-owned events without poisoning future replay. */
export function supportsAgentRpSessionEvents(session: Session): session is IgnorableSession {
  return typeof (session as Partial<IgnorableSession>).appendIgnorable === 'function'
}

/**
 * Append one plugin-owned record only through the Host's replay-safe event seam.
 * `ignorable` lets a Host without Agent RP skip its private vocabulary; the
 * event remains in the log and Agent RP still folds it when the plugin exists.
 */
export function appendAgentRpSessionEvent<T extends AgentRpSessionEventType & keyof SessionEventMap>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
): SessionEvent<T> & { readonly ignorable: true } {
  if (!supportsAgentRpSessionEvents(session)) {
    throw new Error('当前 DSH Host 缺少安全的插件事件写入能力；已拒绝写入，避免重启后会话无法加载')
  }
  return session.appendIgnorable(type, data)
}
