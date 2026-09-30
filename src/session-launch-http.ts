/** Same-origin creation of complete seeded Agent RP Sessions on public DSH. */

import { agentHasPendingInput } from './agent-inbox.ts'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { normalize as normalizePath, win32 as win32Path } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CharacterLibrary } from './character-library.ts'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import {
  prepareAgentRpBranchSession,
  prepareAgentRpRewriteSession,
  prepareAgentRpSession,
  parseAgentRpSessionLaunchRequest,
} from './session-launch.ts'
import { AGENT_RP_SESSION_PATH } from './session-launch-protocol.ts'
import type { PresetLibrary } from './preset-library.ts'
import { SillyTavernChatLibrary } from './sillytavern-chat-library.ts'
import { WorldInfoLibrary } from './world-info-library.ts'
import { appendAgentRpMemorySeed, readAgentRpMemoryHistory } from './memory.ts'
import { readActiveSessionCharacter } from './import/session-character.ts'
import type { RoleplayResourceCatalog } from './roleplay-resource-catalog.ts'
import {
  agentHasAgentRpRuntime,
  resolveAgentRpCapabilityPreset,
  type AgentPresetGateway,
} from './agent-capability-preset.ts'
import { AGENT_RP_PRESET_ID } from './preset.ts'

const MAX_REQUEST_BYTES = 32 * 1024

interface LaunchWorkspace {
  readonly id: string
  readonly path?: string
  readonly sessionIds: readonly SessionId[]
  attachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceGateway {
  list(): readonly LaunchWorkspace[]
  resolveByPath?(path: string): Promise<LaunchWorkspace | undefined>
}

interface SessionTitleGateway {
  get(session: Agent['session']): { readonly title: string } | undefined
  rename(session: Agent['session'], title: string): unknown
}

/** One resolved provider route as the Host records it on a Session. */
interface LaunchModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Durable model selection read from the Host's Session projection registry.
 * DSH 0.1.3 retired the `apiProxy` service; the selection now lives in the
 * `modelSelection` projection folded from `model/selection` events.
 */
interface SessionProjectionGateway {
  stateOf(session: Agent['session'], key: 'modelSelection'): {
    readonly lastUsed: LaunchModelSelection | null
    readonly pending: LaunchModelSelection | null
  } | undefined
}

/** Model selection and catalog through the Host's Session Controller. */
interface SessionControllerGateway {
  selectModel(request: LaunchModelSelection & { readonly sessionId: SessionId }): Promise<{
    readonly selected: LaunchModelSelection
  }>
  modelCatalog(): Promise<{
    readonly default: LaunchModelSelection
    /** Providers and the models each one currently routes. */
    readonly groups: readonly {
      readonly id: string
      readonly models: readonly { readonly id: string }[]
    }[]
  }>
}

/** Normalize a workspace path for conservative same-directory fallback matching. */
export function normalizeWorkspacePath(value: string): string {
  const trimmed = trimTrailingPathSeparators(value)
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  const normalized = windowsStyle ? win32Path.normalize(trimmed) : normalizePath(trimmed)
  const caseInsensitive = windowsStyle || process.platform === 'win32'
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/** Compare workspace paths without guessing filesystem aliases or volume case rules. */
export function sameWorkspacePath(left: string, right: string): boolean {
  if (left === '' || right === '') return false
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right)
}

function trimTrailingPathSeparators(value: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(value)) return value
  if (/^[\\/]+$/u.test(value)) return value
  return value.replace(/[\\/]+$/u, '')
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return readJsonRequest(request, {
    limit: MAX_REQUEST_BYTES,
    emptyMessage: '角色会话启动请求为空',
    tooLargeMessage: '角色会话启动请求过大',
    invalidMessage: '角色会话启动请求不是有效 JSON',
  })
}

/** Create an Agent whose constructor sees the complete imported history. */
export async function launchAgentRpSession(
  ctx: Context,
  characters: CharacterLibrary,
  chats: SillyTavernChatLibrary,
  presetLibrary: PresetLibrary,
  worldInfos: WorldInfoLibrary,
  input: unknown,
  resources?: RoleplayResourceCatalog,
): Promise<{
  readonly sessionId: SessionId
  readonly title: string
  readonly seed: readonly SessionEvent[]
  readonly workspaceWarning?: string
}> {
  const request = parseAgentRpSessionLaunchRequest(input)
  const sourceId = SessionId(request.sourceSessionId)
  const agents = ctx.get('agents') as Context['agents'] | undefined
  if (agents === undefined) throw new Error('当前 Host 无法创建角色会话')
  const sessionController = ctx.get('sessionController') as SessionControllerGateway | undefined
  if (sessionController === undefined) throw new Error('当前 Host 无法读取来源会话')
  const source = agents.get(sourceId)
  if (source === undefined) throw new Error('来源会话当前不可用')
  // A Session that never recorded a selection still answers with the deployment default.
  const projections = ctx.get('sessionProjections') as SessionProjectionGateway | undefined
  const sourceSelection = projections?.stateOf(source.session, 'modelSelection')
  const catalog = await sessionController.modelCatalog()
  // The source's selection is only inherited while the Host still routes it.
  // A retired model (DSH 0.2.0 replaced deepseek-v4-flash with deepseek-flash)
  // would otherwise be copied verbatim into the new Session, which then refuses
  // to send with "Select an available model before sending a message" — the
  // launch appears to succeed and the Session is unusable.
  const routable = (selection: LaunchModelSelection | null | undefined): boolean =>
    selection != null && catalog.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
  const inherited = [sourceSelection?.pending, sourceSelection?.lastUsed].find(routable)
  const currentModel = inherited ?? catalog.default

  const agentPresets = ctx.get('agentPresets') as AgentPresetGateway | undefined
  if (agentPresets === undefined) throw new Error('当前 Host 无法挂载角色会话预设')
  const carriesSourceIdentity = request.kind === 'rewrite' || request.kind === 'branch'
  const requestedAgentPreset = carriesSourceIdentity
    ? source.session.header.agentPreset
    : request.agentPresetId ?? AGENT_RP_PRESET_ID
  if (requestedAgentPreset === undefined) throw new Error('来源角色会话没有记录 Agent 能力预设')
  const preset = await resolveAgentRpCapabilityPreset(agentPresets, requestedAgentPreset)
  const titles = ctx.get('sessionTitle') as SessionTitleGateway | undefined
  if (carriesSourceIdentity) {
    const verb = request.kind === 'rewrite' ? '改写' : '分支'
    if (!agentHasAgentRpRuntime(agentPresets, source)) throw new Error(`只能${verb} Agent RP 角色会话`)
    if (source.status !== 'idle' || agentHasPendingInput(source)) throw new Error(`请等待当前回复完成后再${verb}`)
  }
  let prepared = request.kind === 'rewrite'
    ? prepareAgentRpRewriteSession(source.session, request.turn, titles?.get(source.session)?.title)
    : request.kind === 'branch'
      ? prepareAgentRpBranchSession(source.session, request.fromFloor, titles?.get(source.session)?.title)
      : prepareAgentRpSession(characters, chats, presetLibrary, worldInfos, request, resources)
  if (request.kind === 'character' && request.memory === 'copy-active') {
    if (!agentHasAgentRpRuntime(agentPresets, source)) throw new Error('只能从角色会话继承记忆')
    if (source.status !== 'idle' || agentHasPendingInput(source)) throw new Error('请等待当前回复完成后再继承记忆')
    const sourceCharacter = readActiveSessionCharacter(source.session.snapshotEvents())
    if (sourceCharacter?.result.libraryId !== request.characterId) throw new Error('只能把记忆带给同一个角色')
    const memory = readAgentRpMemoryHistory(source.session.snapshotEvents()).active
    prepared = {
      ...prepared,
      seed: appendAgentRpMemorySeed(prepared.seed, memory, String(source.id)),
    }
  }
  const sessionId = SessionId(`session-${randomUUID()}`)
  const agentOptions: AgentOptions = {
    provider: currentModel.provider,
    model: currentModel.model,
  }
  const handle = await agents.create({
    sessionId,
    seed: prepared.seed,
    agentOptions,
    meta: {
      ...(source.session.header.cwd === undefined ? {} : { cwd: source.session.header.cwd }),
      // A rewrite forks the source: DSH 0.1.3 marks that with `isSeeded` plus the
      // exact inherited prefix length, replacing the retired `seedLength` field.
      ...(request.kind === 'rewrite' ? { parentSession: source.id, isSeeded: true } : {}),
      // A branch records the same lineage but is deliberately NOT seeded: its
      // transcript is re-stated rather than inherited, so the seed is not a
      // prefix of the parent's log and must not claim an inherited event count.
      ...(request.kind === 'branch' ? { parentSession: source.id } : {}),
      agentPreset: preset.id,
    },
    ...(request.kind === 'rewrite'
      ? { inheritedEventCount: SessionLogOffset(prepared.seed.length) }
      : {}),
    setup: async agentCtx => { await agentPresets.mount(agentCtx, preset.id) },
  })
  if (!agentHasAgentRpRuntime(agentPresets, handle.agent)) {
    await handle.dispose()
    throw new Error('所选 Agent 能力预设没有成功挂载 Agent RP 角色运行时')
  }
  try {
    await sessionController.selectModel({
      sessionId,
      provider: currentModel.provider,
      model: currentModel.model,
      ...(currentModel.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: currentModel.reasoningEffort }),
    })
  } catch (error: unknown) {
    await handle.dispose()
    throw error instanceof Error ? error : new Error('无法为新的角色会话选择模型')
  }

  if (titles !== undefined) {
    try {
      titles.rename(handle.agent.session, prepared.title)
    } catch (error: unknown) {
      ctx.logger.warn(`agent-rp: Session ${JSON.stringify(sessionId)} title was not applied: ${String(error)}`)
    }
  }
  let workspaceWarning: string | undefined
  try {
    const workspaces = (ctx.get('workspace') ?? ctx.get('workspaceRegistry')) as WorkspaceGateway | undefined
    if (workspaces === undefined) {
      workspaceWarning = '当前 DSH 没有可用的工作区服务，新角色会话保留在“未分组”'
    } else {
      const listed = workspaces.list()
      const sourceCwd = source.session.header.cwd
      const byMembership = listed.find(item => item.sessionIds.includes(sourceId))
      let workspace = byMembership
      if (workspace === undefined && sourceCwd !== undefined) {
        workspace = await workspaces.resolveByPath?.(sourceCwd)
        if (workspace === undefined) {
          const byCwd = listed.filter(item => item.path !== undefined && sameWorkspacePath(item.path, sourceCwd))
          if (byCwd.length === 1) {
            workspace = byCwd[0]
          } else if (byCwd.length > 1) {
            workspaceWarning = '多个工作区与来源工作目录匹配，拒绝猜测，新角色会话保留在“未分组”'
          }
        }
      }
      if (workspace === undefined) {
        workspaceWarning ??= sourceCwd === undefined
          ? '来源会话没有工作目录，新角色会话保留在“未分组”'
          : '没有找到来源工作目录对应的工作区，新角色会话保留在“未分组”'
      } else {
        await workspace.attachSession(sessionId)
      }
    }
  } catch (error: unknown) {
    workspaceWarning = `工作区挂靠失败：${error instanceof Error ? error.message : String(error)}`
  }
  if (workspaceWarning !== undefined) {
    ctx.logger.warn(`agent-rp: Session ${JSON.stringify(sessionId)} remains ungrouped: ${workspaceWarning}`)
  }
  if (request.kind === 'rewrite') {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.text }],
      source: { kind: 'user' },
    }))
  }
  return {
    sessionId,
    title: prepared.title,
    seed: prepared.seed,
    ...(workspaceWarning === undefined ? {} : { workspaceWarning }),
  }
}

/** Register the current-public-DSH bridge for seeded Session creation. */
export function installSessionLaunchHttp(
  routeCtx: Context,
  hostCtx: Context,
  characters: CharacterLibrary,
  chats: SillyTavernChatLibrary,
  presets: PresetLibrary,
  worldInfos: WorldInfoLibrary,
  resources: RoleplayResourceCatalog,
  server: AgentRpHttpServer,
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: AGENT_RP_SESSION_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        json(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const result = await launchAgentRpSession(
          hostCtx,
          characters,
          chats,
          presets,
          worldInfos,
          await readJson(request),
          resources,
        )
        json(response, 200, {
          format: 0,
          sessionId: result.sessionId,
          title: result.title,
          ...(result.workspaceWarning === undefined ? {} : { workspaceWarning: result.workspaceWarning }),
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      }
    },
  }), 'agent-rp: seeded Session launch HTTP')
}
