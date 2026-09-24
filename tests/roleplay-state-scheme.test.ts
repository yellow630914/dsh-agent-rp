import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
} from '@deepseek-ai/dsh-session'
import { agentRpProjectionDefinition } from '../src/projection.ts'
import { appendRoleplayState, prepareUserRoleplayState, readRoleplayStates } from '../src/roleplay-state.ts'
import {
  basicRoleplayStateScheme,
  sessionRoleplayStateScheme,
  switchedRoleplayStateScheme,
  parseRoleplayStateScheme,
  readRoleplayStateScheme,
  readRoleplayStateSchemeValue,
  ROLEPLAY_STATE_SCHEME_MODULE_ID,
  roleplayStateSchemeLibraryId,
  roleplayStateSchemeResourceId,
} from '../src/roleplay-state-scheme.ts'
import {
  changeSessionRoleplayStateScheme,
  resolveRoleplayStateTemplate,
} from '../src/roleplay-state-scheme-session.ts'
import { prepareRoleplayTurn } from '../src/roleplay-turn-plan.ts'
import { resolveSessionRoleplayRuntime } from '../src/session-roleplay-runtime.ts'
import { resolveConfig } from '../src/config.ts'
import { resolveRoleplayStateVerificationConfig } from '../src/roleplay-staged-state-settlement.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

interface IgnorableSession {
  appendIgnorable<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T>
}

/** The detached fixture installs `appendIgnorable` at runtime; this names it for the checker. */
function ignorable(session: Session): Session & IgnorableSession {
  return session as Session & IgnorableSession
}

function seeded(id: string): Session & IgnorableSession {
  const session = ignorable(Session.create(SessionId(id)))
  session.appendIgnorable('agent-rp/state-scheme-seed', basicRoleplayStateScheme())
  return session
}

test('freezes the scheme into the Session and folds later revisions over its opening value', () => {
  const session = seeded('state-scheme-fold')
  const scheme = readRoleplayStateScheme(session.snapshotEvents())
  assert.ok(scheme !== undefined)
  assert.equal(scheme.stateId, 'state:native')

  const opening = readRoleplayStateSchemeValue(session.snapshotEvents(), scheme)
  assert.equal(opening.revision, 0)
  assert.deepEqual(opening.value, scheme.initial)

  appendRoleplayState(session, {
    id: scheme.stateId,
    expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
    value: { 场景: { 地点: '码头', 时间: '黄昏' }, 角色: { 状态: '疲惫', 情绪: '警惕' }, 进度: { 回合: 1 } },
  })
  const settled = readRoleplayStateSchemeValue(session.snapshotEvents(), scheme)
  assert.equal(settled.revision, 1)
  assert.deepEqual(settled.value, {
    场景: { 地点: '码头', 时间: '黄昏' },
    角色: { 状态: '疲惫', 情绪: '警惕' },
    进度: { 回合: 1 },
  })
})

test('keeps the scheme namespace owned by its own module', () => {
  const session = seeded('state-scheme-owner')
  appendRoleplayState(session, {
    id: 'state:native',
    expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
    value: { 进度: { 回合: 1 } },
  })

  assert.throws(() => appendRoleplayState(session, {
    id: 'state:native',
    expectedRevision: 1,
    writerModuleId: 'adapter:mvu',
    value: { 进度: { 回合: 2 } },
  }), /is owned by roleplay:state-scheme/u)

  const [state] = readRoleplayStates(session.snapshotEvents())
  assert.equal(state?.ownerModuleId, ROLEPLAY_STATE_SCHEME_MODULE_ID)
  assert.equal(state?.revision, 1)
})

test('refuses a revision that did not start from the prepared baseline', () => {
  const session = seeded('state-scheme-cas')
  appendRoleplayState(session, {
    id: 'state:native', expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID, value: { 进度: { 回合: 1 } },
  })

  assert.throws(() => appendRoleplayState(session, {
    id: 'state:native', expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID, value: { 进度: { 回合: 2 } },
  }), /revision conflict/u)
})

test('round-trips the opaque library reference used by a Session seed', () => {
  assert.equal(roleplayStateSchemeLibraryId(roleplayStateSchemeResourceId('scheme-abc')), 'scheme-abc')
  assert.equal(roleplayStateSchemeLibraryId(basicRoleplayStateScheme().id), undefined)
})

test('declines a scheme whose opening value is not a lossless JSON object', () => {
  const base = basicRoleplayStateScheme()
  assert.throws(() => parseRoleplayStateScheme({ ...base, initial: [1, 2] }), /lossless JSON object/u)
  assert.throws(() => parseRoleplayStateScheme({ ...base, stateId: 'native' }), /state id is invalid/u)
})

test('settling native state leaves every floor and Tavern message id untouched', () => {
  const session = seeded('state-scheme-transcript')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '我走向码头。' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: '黄昏的风从海面吹来。' }],
    }),
    stream: [],
  }, { surfaceOp: 'append' })

  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)
  const before = agentRpProjectionDefinition.wire.view(state)

  // Everything the settlement pipeline writes is a plugin event without a
  // `surfaceOp`, so none of the five transcript layers may notice it.
  const settlementSeq = session.snapshotEvents().length
  session.appendIgnorable('agent-rp/turn-worker-result', {
    format: 0,
    sessionId: String(session.id),
    turn: 1,
    step: 1,
    workerId: 'state-settlement',
    phase: 'settle',
    outcome: 'applied',
  })
  appendRoleplayState(session, {
    id: 'state:native',
    expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
    value: { 场景: { 地点: '码头', 时间: '黄昏' }, 角色: { 状态: '正常', 情绪: '警惕' }, 进度: { 回合: 1 } },
  })
  for (const event of session.snapshotEvents().slice(settlementSeq)) {
    state = agentRpProjectionDefinition.apply(state, event)
  }
  const after = agentRpProjectionDefinition.wire.view(state)

  assert.deepEqual(after.floors, before.floors)
  assert.deepEqual(
    after.tavern?.messages.map(entry => [entry.messageId, entry.seq, entry.role]),
    before.tavern?.messages.map(entry => [entry.messageId, entry.seq, entry.role]),
  )
  assert.equal(after.stateScheme?.revision, 1)
  assert.equal(before.stateScheme?.revision, 0)
})

test('a tool result never becomes a floor, so inline state work cannot shift Tavern ids', () => {
  const session = seeded('state-scheme-tool-floor')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '开始。' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)
  const before = agentRpProjectionDefinition.wire.view(state)

  const toolSeq = session.snapshotEvents().length
  const call = session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'apply_roleplay_state', arguments: '{}',
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  for (const event of session.snapshotEvents().slice(toolSeq)) {
    state = agentRpProjectionDefinition.apply(state, event)
  }
  const after = agentRpProjectionDefinition.wire.view(state)

  assert.deepEqual(after.floors, before.floors)
  assert.deepEqual(
    after.tavern?.messages.map(entry => entry.messageId),
    before.tavern?.messages.map(entry => entry.messageId),
  )
})

test('mints a Session identity that survives a switch and keeps the namespace', () => {
  const library = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-aaaa'),
    name: '西幻通用',
    stateId: 'state:xihuan',
    initial: { 场景: {} },
    rules: '甲规则',
  })
  const own = sessionRoleplayStateScheme(library, '11111111-2222-4333-8444-555555555555')

  assert.match(own.id, /^state-scheme:session:[0-9a-f]{32}$/u)
  assert.equal(own.source, roleplayStateSchemeResourceId('scheme-aaaa'))
  assert.equal(own.stateId, 'state:xihuan')

  const other = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-bbbb'),
    name: '都市现代',
    stateId: 'state:urban',
    initial: { 场景: { 地点: '公寓' } },
    rules: '乙规则',
  })
  const switched = switchedRoleplayStateScheme(own, other)

  // Identity and namespace stay so the settled values carry over; only the
  // recorded source and the authored content follow the new scheme.
  assert.equal(switched.id, own.id)
  assert.equal(switched.stateId, own.stateId)
  assert.equal(switched.source, roleplayStateSchemeResourceId('scheme-bbbb'))
  assert.equal(switched.name, '都市现代')
  assert.equal(switched.rules, '乙规则')
})

test('reads the latest seed, so a mid-session switch simply appends', () => {
  const session = seeded('state-scheme-switch')
  const first = readRoleplayStateScheme(session.snapshotEvents())!
  const own = sessionRoleplayStateScheme(first, '99999999-8888-4777-8666-555555555555')
  session.appendIgnorable('agent-rp/state-scheme-seed', own)

  const next = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-cccc'),
    name: '换过的方案',
    stateId: 'state:ignored',
    initial: {},
    rules: '新规则',
  })
  session.appendIgnorable('agent-rp/state-scheme-seed', switchedRoleplayStateScheme(own, next))

  const active = readRoleplayStateScheme(session.snapshotEvents())!
  assert.equal(active.id, own.id)
  assert.equal(active.name, '换过的方案')
  assert.equal(active.stateId, own.stateId)
})

test('reads a pre-split seed as its own source so old panels keep a template', () => {
  const legacy = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-dddd'),
    name: '旧种子',
    stateId: 'state:legacy',
    initial: {},
    rules: '',
  })

  assert.equal(legacy.source, roleplayStateSchemeResourceId('scheme-dddd'))
  assert.equal(roleplayStateSchemeLibraryId(legacy.source), 'scheme-dddd')
})

test('a mid-session switch keeps settled values, and a session edit never touches the library', () => {
  const session = seeded('state-scheme-session-change')
  const own = sessionRoleplayStateScheme(
    readRoleplayStateScheme(session.snapshotEvents())!,
    '12121212-3434-4545-8656-767676767676',
  )
  session.appendIgnorable('agent-rp/state-scheme-seed', own)
  appendRoleplayState(session, {
    id: own.stateId,
    expectedRevision: 0,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
    value: { 进度: { 回合: 7 } },
  })

  const target = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-eeee'),
    name: '换过的',
    stateId: 'state:other',
    initial: { 别的: {} },
    rules: '新规则',
  })
  changeSessionRoleplayStateScheme({
    session,
    library: { list: () => [], read: id => id === 'scheme-eeee' ? target : undefined },
    change: { resourceId: roleplayStateSchemeResourceId('scheme-eeee') },
  })

  const active = readRoleplayStateScheme(session.snapshotEvents())!
  assert.equal(active.id, own.id)
  assert.equal(active.stateId, own.stateId)
  assert.equal(active.name, '换过的')
  // The settled revision survives the switch untouched.
  const value = readRoleplayStateSchemeValue(session.snapshotEvents(), active)
  assert.equal(value.revision, 1)
  assert.deepEqual(value.value, { 进度: { 回合: 7 } })

  changeSessionRoleplayStateScheme({
    session,
    change: { edit: { name: '只改本会话', rules: '本会话规则' } },
  })
  const edited = readRoleplayStateScheme(session.snapshotEvents())!
  assert.equal(edited.id, own.id)
  assert.equal(edited.name, '只改本会话')
  assert.equal(edited.rules, '本会话规则')
  // The library entry it points at is untouched by a Session-level edit.
  assert.equal(target.name, '换过的')
  assert.equal(target.rules, '新规则')
})

test('a player edit before the first settlement must not lock the scheme module out', () => {
  const session = seeded('state-scheme-owner-lockout')
  const scheme = readRoleplayStateScheme(session.snapshotEvents())!

  // The player corrects the opening value from the state dialog. The namespace
  // has no record yet, so this write is the one that establishes ownership.
  const request = {
    format: 0 as const,
    operation: 'set' as const,
    id: scheme.stateId,
    expectedRevision: 0,
    value: { 进度: { 回合: 1 } },
  }
  const command = session.append('command/run', {
    name: 'rp-state',
    commandId: 'cmd-lockout',
    args: JSON.stringify(request),
    source: { kind: 'user' },
  } as never)
  const record = prepareUserRoleplayState(session, request, command.seq, ROLEPLAY_STATE_SCHEME_MODULE_ID)
  session.appendIgnorable('agent-rp/state', record)

  // The settlement Worker writes as the scheme module; it must still be allowed.
  assert.doesNotThrow(() => appendRoleplayState(session, {
    id: scheme.stateId,
    expectedRevision: 1,
    writerModuleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
    value: { 进度: { 回合: 2 } },
  }))
})

test('projects this Session own rules, so a session-level edit is what the dialog shows', () => {
  const session = seeded('state-scheme-projected-rules')
  const own = sessionRoleplayStateScheme(
    readRoleplayStateScheme(session.snapshotEvents())!,
    '43434343-5656-4767-8878-989898989898',
  )
  session.appendIgnorable('agent-rp/state-scheme-seed', own)
  changeSessionRoleplayStateScheme({
    session,
    change: { edit: { rules: '只在正文写明时更新。' } },
  })

  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)
  const view = agentRpProjectionDefinition.wire.view(state)

  assert.equal(view.stateScheme?.rules, '只在正文写明时更新。')
  assert.equal(view.stateScheme?.id, own.id)
})

test('resolves the panel template from the Session copy, then the source, then the built-in', () => {
  const source = parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeResourceId('scheme-ffff'),
    name: '有模板的方案',
    stateId: 'state:tpl',
    initial: {},
    rules: '',
  })
  const library = {
    list: () => [],
    read: (id: string) => id === 'scheme-ffff' ? source : undefined,
    template: (id: string) => id === 'scheme-ffff'
      ? { format: 'text' as const, source: '来源模板' }
      : undefined,
  }
  const own = sessionRoleplayStateScheme(source, 'abababab-cdcd-4dcd-8ede-fefefefefefe')

  // Following the source: a resource-center edit reaches this Session.
  assert.deepEqual(resolveRoleplayStateTemplate(own, library), {
    template: { format: 'text', source: '来源模板' },
    origin: 'source',
  })

  // A Session copy wins once the player edits the panel here.
  const overridden = parseRoleplayStateScheme({
    ...own,
    template: { format: 'text', source: '本会话模板' },
  })
  assert.deepEqual(resolveRoleplayStateTemplate(overridden, library), {
    template: { format: 'text', source: '本会话模板' },
    origin: 'session',
  })

  // A deleted source falls back rather than blanking a valid panel.
  assert.equal(resolveRoleplayStateTemplate(own, undefined).origin, 'builtin')
})

test('a session template override survives edits and is cleared by an explicit null', () => {
  const session = seeded('state-scheme-template-override')
  const own = sessionRoleplayStateScheme(
    readRoleplayStateScheme(session.snapshotEvents())!,
    'cdcdcdcd-efef-4fef-8a0a-1b1b1b1b1b1b',
  )
  session.appendIgnorable('agent-rp/state-scheme-seed', own)

  changeSessionRoleplayStateScheme({
    session,
    change: { edit: { template: { format: 'text', source: '本会话模板' } } },
  })
  assert.deepEqual(readRoleplayStateScheme(session.snapshotEvents())?.template, {
    format: 'text', source: '本会话模板',
  })

  // An unrelated edit must not silently drop the override.
  changeSessionRoleplayStateScheme({ session, change: { edit: { rules: '新规则' } } })
  const kept = readRoleplayStateScheme(session.snapshotEvents())!
  assert.equal(kept.rules, '新规则')
  assert.deepEqual(kept.template, { format: 'text', source: '本会话模板' })

  changeSessionRoleplayStateScheme({ session, change: { edit: { template: null } } })
  assert.equal(readRoleplayStateScheme(session.snapshotEvents())?.template, undefined)
})

test('prepares a whole turn with a scheme active, and hands the Worker the Session contract', () => {
  const session = seeded('state-scheme-prepare-turn')
  const own = sessionRoleplayStateScheme(
    readRoleplayStateScheme(session.snapshotEvents())!,
    'dededede-fafa-4bab-8cbc-0d0d0d0d0d0d',
  )
  session.appendIgnorable('agent-rp/state-scheme-seed', own)
  changeSessionRoleplayStateScheme({ session, change: { edit: { rules: '本会话规则。' } } })
  session.appendIgnorable('agent-rp/turn-mode', { format: 0, mode: 'agent', source: 'default' })

  const deployment = resolveConfig({} as never)
  const resolved = resolveSessionRoleplayRuntime({ session, deployment })
  // Preparation throws outright when a module declares a phase without an
  // outcome, and the Agent then silently falls back to a bare prompt — short
  // replies and no settlement at once. Pin the whole pipeline, not the parts.
  const plan = prepareRoleplayTurn({ session, pendingMessages: [], deployment, resolved })

  const target = plan.act.stateActions[0]
  assert.equal(target?.engine, 'native-v0')
  assert.equal(target?.stateId, own.stateId)
  // What the Worker sends the model must be this Session's copy, not the library's.
  assert.equal(target?.instructions, '本会话规则。')
  assert.deepEqual(
    plan.stateReads.find(read => read.id === own.stateId)?.value,
    own.initial,
  )
})

test('budgets the verification for reasoning unless it is explicitly turned off', () => {
  const header = { provider: 'fixture', model: 'fixture' }

  // "模型默认" omits the effort, so the provider may reason — and reasoning
  // shares the completion budget with the answer.
  assert.deepEqual(
    resolveRoleplayStateVerificationConfig(header, { model: null, reasoningEffort: null }),
    header,
  )
  assert.deepEqual(
    resolveRoleplayStateVerificationConfig(header, { model: null, reasoningEffort: 'off' }),
    { ...header, reasoningEffort: 'off' },
  )
})

test('keeps a per-scheme verification budget through edits and clears it with null', () => {
  const session = seeded('state-scheme-budget')
  const own = sessionRoleplayStateScheme(
    readRoleplayStateScheme(session.snapshotEvents())!,
    'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000',
  )
  session.appendIgnorable('agent-rp/state-scheme-seed', own)

  changeSessionRoleplayStateScheme({ session, change: { edit: { verificationMaxTokens: 32_768 } } })
  assert.equal(readRoleplayStateScheme(session.snapshotEvents())?.verificationMaxTokens, 32_768)

  changeSessionRoleplayStateScheme({ session, change: { edit: { rules: '别的规则' } } })
  assert.equal(readRoleplayStateScheme(session.snapshotEvents())?.verificationMaxTokens, 32_768)

  changeSessionRoleplayStateScheme({ session, change: { edit: { verificationMaxTokens: null } } })
  assert.equal(readRoleplayStateScheme(session.snapshotEvents())?.verificationMaxTokens, undefined)

  assert.throws(
    () => changeSessionRoleplayStateScheme({ session, change: { edit: { verificationMaxTokens: 10 } } }),
    /1024 到 200000/u,
  )
})

test('projects what the settlement did, so a failed verification is visible', () => {
  const session = seeded('state-scheme-settlement-view')
  const request = session.appendIgnorable('agent-rp/staged-state-request', {
    format: 0,
    requestId: 'r1',
    sessionId: String(session.id),
    turn: 3,
    step: 1,
    throughEventSeq: 1,
    planEventSeq: 0,
    stage: 'verification',
    proposalResultSeq: 0,
    target: {
      engine: 'native-v0', tool: 'apply_roleplay_state', moduleId: ROLEPLAY_STATE_SCHEME_MODULE_ID,
      stateId: 'state:native', expectedRevision: 0, operations: ['replace'],
    },
    dispatch: { provider: 'fixture', model: 'fixture', messages: [] },
  } as never)
  session.appendIgnorable('agent-rp/staged-state-result', {
    format: 0,
    requestId: 'r1',
    requestSeq: request.seq,
    result: { kind: 'failure', failure: 'unknown', detail: { code: 'INVALID_RESPONSE', message: '结果为空' } },
  } as never)
  session.appendIgnorable('agent-rp/turn-worker-result', {
    format: 0, sessionId: String(session.id), turn: 3, step: 1,
    workerId: 'state-settlement', phase: 'settle', outcome: 'failed',
  })

  let state = agentRpProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = agentRpProjectionDefinition.apply(state, event)
  const view = agentRpProjectionDefinition.wire.view(state)

  assert.equal(view.stateSettlement?.turn, 3)
  assert.equal(view.stateSettlement?.outcome, 'failed')
  assert.deepEqual(view.stateSettlement?.stages, [
    { stage: 'verification', outcome: 'failure', error: '结果为空' },
  ])
})
