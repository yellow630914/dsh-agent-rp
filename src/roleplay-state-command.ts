/** Model-free player editing of durable native Roleplay state. */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import {
  appendUserRoleplayState,
  encodeRoleplayStateRecord,
  parseRoleplayStateCommandRequest,
  prepareUserRoleplayState,
} from './roleplay-state.ts'
import {
  readRoleplayStateScheme,
  ROLEPLAY_STATE_SCHEME_MODULE_ID,
} from './roleplay-state-scheme.ts'
import { supportsAgentRpSessionEvents } from './session-event-compat.ts'

/** Apply one private player state request without invoking the character model. */
export function executeRoleplayStateCommand(invocation: {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
}): { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq } {
  const request = parseRoleplayStateCommandRequest(invocation.rawInput)
  const source = invocation.agent.session.snapshotEvents().findLast(event =>
    event.type === 'command/run' && String(event.data.commandId) === String(invocation.commandId))
  if (source?.type !== 'command/run' || source.data.name !== 'rp-state'
    || source.data.source.kind !== 'user'
    || source.data.args !== invocation.rawInput
    || String(source.data.commandId) !== String(invocation.commandId)) {
    throw new Error('状态操作命令不是当前 Session 事件')
  }
  // A namespace declared by this Session's scheme stays owned by the scheme
  // module even when the player is the first to write it.
  const scheme = readRoleplayStateScheme(invocation.agent.session.snapshotEvents())
  const owner = scheme?.stateId === request.id ? ROLEPLAY_STATE_SCHEME_MODULE_ID : undefined
  if (supportsAgentRpSessionEvents(invocation.agent.session)) {
    const written = appendUserRoleplayState(invocation.agent.session, request, source.seq, owner)
    return { kind: 'success', sourceEventSeq: SessionSeq(written.eventSeq) }
  }
  const record = prepareUserRoleplayState(invocation.agent.session, request, source.seq, owner)
  return { kind: 'success', text: encodeRoleplayStateRecord(record) }
}
