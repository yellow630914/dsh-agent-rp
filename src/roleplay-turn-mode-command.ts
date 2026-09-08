/** Model-free player selection of the per-Session Roleplay turn mode. */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import {
  appendUserRoleplayTurnMode,
  parseRoleplayTurnModeCommandRequest,
} from './roleplay-turn-mode.ts'
import { supportsAgentRpSessionEvents } from './session-event-compat.ts'

/** Apply one private turn-mode request without invoking the character model. */
export function executeRoleplayTurnModeCommand(invocation: {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
}): { readonly kind: 'success'; readonly sourceEventSeq: SessionSeq } {
  if (!supportsAgentRpSessionEvents(invocation.agent.session)) {
    throw new Error('当前 DSH Host 缺少安全插件事件能力，无法启用 Agent 回合')
  }
  const request = parseRoleplayTurnModeCommandRequest(invocation.rawInput)
  const source = invocation.agent.session.snapshotEvents().findLast(event => event.type === 'command/run'
    && String(event.data.commandId) === String(invocation.commandId))
  if (source?.type !== 'command/run' || source.data.name !== 'rp-turn-mode'
    || source.data.source.kind !== 'user' || source.data.args !== invocation.rawInput) {
    throw new Error('回合方式命令不是当前 Session 事件')
  }
  appendUserRoleplayTurnMode(invocation.agent.session, request, source.seq)
  return { kind: 'success', sourceEventSeq: source.seq }
}
