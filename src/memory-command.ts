/** Model-free user management of persistent Roleplay memory. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  encodeAgentRpMemoryCommandRecord,
  findAgentRpMemorySubjectConflict,
  parseAgentRpMemoryCommandRequest,
  readAgentRpMemoryHistory,
  type AgentRpMemoryCommandRecord,
  type AgentRpMemoryHistory,
} from './memory.ts'

/**
 * Fold one not-yet-durable command record with the real reader before returning
 * it. `readAgentRpMemoryHistory` throws on anything it cannot validate, and it
 * runs on the prompt, turn-plan and settlement paths — so a record that parses
 * as a request but does not fold would break every later turn in this Session,
 * with no way to take it back out of an append-only log. Rejecting here leaves
 * the Session with nothing but a failed command.
 * @param events - complete history, ending at this command's `command/run`.
 * @param commandId - identity the paired `command/done` will carry.
 * @param record - the record about to be encoded as the command result.
 * @param before - memory history as it stands before this command.
 * @param expectedActive - active count this command must produce.
 */
function assertFoldsBack(
  events: readonly SessionEvent[],
  commandId: CommandId,
  record: AgentRpMemoryCommandRecord,
  before: AgentRpMemoryHistory,
  expectedActive: number,
): void {
  const probe = [...events, {
    type: 'command/done',
    seq: events.length,
    time: Date.now(),
    data: { commandId, kind: 'success', text: encodeAgentRpMemoryCommandRecord(record) },
  } as unknown as SessionEvent]
  let after: AgentRpMemoryHistory
  try {
    after = readAgentRpMemoryHistory(probe)
  } catch (error: unknown) {
    throw new Error(`这次记忆操作无法被回放，已取消：${error instanceof Error ? error.message : String(error)}`)
  }
  if (after.active.length !== expectedActive) {
    throw new Error(`这次记忆操作的结果与预期不符（有效记忆 ${before.active.length} → ${after.active.length}），已取消`)
  }
}

/** Apply one private memory-manager request without invoking the character model. */
export function executeAgentRpMemoryCommand(invocation: {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
}): { readonly kind: 'success'; readonly text: string } {
  const request = parseAgentRpMemoryCommandRequest(invocation.rawInput)
  const events = invocation.agent.session.snapshotEvents()
  const source = events.at(-1)
  if (source?.type !== 'command/run' || source.data.name !== 'rp-memory'
    || String(source.data.commandId) !== String(invocation.commandId)) {
    throw new Error('记忆操作命令不是当前 Session 事件')
  }
  const history = readAgentRpMemoryHistory(events)
  let expectedActive = history.active.length
  if (request.operation === 'add') {
    const conflict = findAgentRpMemorySubjectConflict(history.active, request.subject)
    if (conflict !== undefined) throw new Error(`“${request.subject}”已经有一条有效记忆，请直接纠正原记录`)
    expectedActive += 1
  } else if (request.operation === 'import') {
    // Validate the whole batch first and refuse all of it on any conflict: one
    // command/done carries every entry, so a partially acceptable import has no
    // durable form. Duplicate topics inside the file itself were already
    // rejected while parsing the request.
    const conflicts = request.entries
      .filter(entry => findAgentRpMemorySubjectConflict(history.active, entry.subject) !== undefined)
      .map(entry => entry.subject)
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, 5).map(subject => `“${subject}”`).join('、')
      const rest = conflicts.length > 5 ? `等 ${conflicts.length} 个主题` : ''
      throw new Error(`${shown}${rest}已经有有效记忆，导入已取消；请先整理这些主题，或从文件里移除它们`)
    }
    expectedActive += request.entries.length
  } else if (request.operation === 'forget-all') {
    // One record for the whole set, so the log states what happened once
    // instead of a forget per memory. The player is asked to confirm and the
    // set is exported before this runs, because the log only appends: nothing
    // undoes it afterwards.
    if (history.active.length === 0) throw new Error('当前没有可清空的记忆')
    expectedActive = 0
  } else {
    if (!history.active.some(record => record.id === request.id)) {
      throw new Error('这条记忆已经被纠正或忘记，请刷新后再试')
    }
    if (request.operation === 'correct') {
      const conflict = findAgentRpMemorySubjectConflict(history.active, request.subject, request.id)
      if (conflict !== undefined) throw new Error(`“${request.subject}”已经是另一条有效记忆的主题，请先整理其中一条`)
    } else {
      expectedActive -= 1
    }
  }
  const record: AgentRpMemoryCommandRecord = { ...request, sourceEventSeq: source.seq }
  assertFoldsBack(events, invocation.commandId, record, history, expectedActive)
  return { kind: 'success', text: encodeAgentRpMemoryCommandRecord(record) }
}
