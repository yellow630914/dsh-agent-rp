/** Player-requested recalculation of the latest closed turn's state. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'
import type { EjsTemplateEngine } from './ejs-template.ts'
import { applyMvuOperations } from './mvu.ts'
import { appendRoleplayState, readRoleplayStates } from './roleplay-state.ts'
import {
  claimRoleplayStateSettlement,
  collectRoleplayStagedStateSettlement,
  runRoleplayStagedStateSettlement,
} from './roleplay-staged-state-settlement.ts'
import type { RoleplayRuntimeExtensionRegistry } from './roleplay-runtime-extension.ts'
import {
  readSessionRoleplayTurnPlans,
  replaySessionRoleplayTurnPlan,
} from './session-roleplay-turn-plan.ts'
import type { RoleplayStateVerificationSettings } from './workspace-settings.ts'

/** Terminal outcome reported back to the state panel. */
export interface RoleplayStateResettleResult {
  readonly outcome: 'applied' | 'unchanged' | 'skipped' | 'failed'
  readonly revision?: number
  readonly error?: string
}

function lastClosedTurn(events: readonly SessionEvent[]): number | undefined {
  const closing = events.findLast((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
  return closing?.data.turn
}

/**
 * Recalculate and re-apply the state for the most recently closed turn.
 *
 * The calculation reuses the same two-stage Worker the automatic pipeline runs,
 * so there is no second settlement program. Only the application differs: the
 * new value is computed from the revision the turn *prepared* rather than from
 * whatever the namespace holds now, so a repeat never applies a `delta` twice.
 * The result is written as the next revision instead of rewinding the log,
 * because Session history is append-only.
 * @param input - Session, Agent and the verification route to use.
 * @returns what happened, for display in the state panel.
 */
export async function resettleRoleplayState(input: {
  readonly ctx: Context
  readonly agent: Agent
  readonly deployment: ResolvedConfig
  readonly verification: RoleplayStateVerificationSettings
  readonly signal: AbortSignal
  readonly templateEngine?: EjsTemplateEngine
  readonly extensions?: RoleplayRuntimeExtensionRegistry
}): Promise<RoleplayStateResettleResult> {
  // Claimed before anything is read, and held across the whole recalculation.
  //
  // The automatic pipeline settles inside `agent/turn-stopping`, which runs
  // before the turn's `turn/end` is appended, so a request arriving in that
  // window would resettle the *previous* turn and write its revision first —
  // the real settlement then fails its `expectedRevision` check and the turn's
  // actual state change is lost. Claiming here rather than inside the runner
  // also makes two overlapping player requests cost one plan replay, not two.
  const release = claimRoleplayStateSettlement(String(input.agent.session.id))
  if (release === undefined) return { outcome: 'skipped', error: '本轮正在结算，请等它结束后再试' }
  try {
    return await recalculateRoleplayState(input)
  } finally {
    release()
  }
}

async function recalculateRoleplayState(
  input: Parameters<typeof resettleRoleplayState>[0],
): Promise<RoleplayStateResettleResult> {
  const session = input.agent.session
  const turn = lastClosedTurn(session.snapshotEvents())
  if (turn === undefined) return { outcome: 'skipped', error: '当前会话还没有已完成的回合' }
  const records = readSessionRoleplayTurnPlans(session.snapshotEvents())
    .filter(record => record.data.turn === turn)
  const record = records.at(-1)
  if (record === undefined) return { outcome: 'skipped', error: '这一回合没有可重放的准备计划' }
  const plan = replaySessionRoleplayTurnPlan({
    session,
    record,
    deployment: input.deployment,
    ...(input.templateEngine === undefined ? {} : { templateEngine: input.templateEngine }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  })
  const target = plan.act.stateActions[0]
  if (target === undefined) return { outcome: 'skipped', error: '这一回合没有准备状态契约' }
  const baseline = plan.stateReads.find(read => read.id === target.stateId)?.value
  if (baseline === undefined) return { outcome: 'skipped', error: '这一回合没有读取到状态基线' }
  const bound = { step: record.data.reference.step, plan }
  const outcome = await runRoleplayStagedStateSettlement({
    ctx: input.ctx,
    agent: input.agent,
    turn,
    plan: bound,
    verification: input.verification,
    signal: input.signal,
    force: true,
    claimed: true,
  })
  if (outcome.outcome === 'failed') return { outcome: 'failed', error: '状态重新结算失败，已保留原状态' }
  const settled = collectRoleplayStagedStateSettlement({
    events: session.snapshotEvents(),
    sessionId: String(session.id),
    turn,
    plans: [record.data.reference],
  })
  if (settled === undefined || settled.outcome !== 'success') {
    return { outcome: 'failed', error: settled?.error ?? '状态重新结算没有得到可用结果' }
  }
  const current = readRoleplayStates(session.snapshotEvents()).find(state => state.id === target.stateId)
  const currentRevision = current?.revision ?? 0
  let next: JsonValue
  try {
    next = applyMvuOperations(baseline, settled.operations).statData
  } catch (reason: unknown) {
    return { outcome: 'failed', error: reason instanceof Error ? reason.message : String(reason) }
  }
  if (JSON.stringify(next) === JSON.stringify(current?.value ?? baseline)) {
    return { outcome: 'unchanged', revision: currentRevision }
  }
  const written = appendRoleplayState(session, {
    id: target.stateId,
    expectedRevision: currentRevision,
    writerModuleId: current?.ownerModuleId ?? target.moduleId,
    value: next,
  })
  await input.ctx.sessions.flush(session as Session)
  return { outcome: 'applied', revision: written.revision }
}
