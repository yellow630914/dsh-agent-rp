/** Same-origin route proposing the memory a Session's transcript still lacks. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentHasAgentRpRuntime, type AgentPresetGateway } from './agent-capability-preset.ts'
import { agentHasPendingInput } from './agent-inbox.ts'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { completeAgentRpMemory, normalizeMemoryCompletionInput } from './memory-completion.ts'
import { AGENT_RP_MEMORY_COMPLETION_PATH } from './memory-completion-protocol.ts'

/** Room for a full rejected proposal plus the player's guidance. */
const MAX_COMPLETION_BYTES = 256 * 1024

interface ModelRoute {
  readonly provider: string
  readonly model: string
}

interface AgentRegistryGateway {
  get(sessionId: SessionId): Agent | undefined
}

interface SessionProjectionGateway {
  stateOf(session: Agent['session'], key: 'modelSelection'): {
    readonly lastUsed: ModelRoute | null
    readonly pending: ModelRoute | null
  } | undefined
}

interface SessionControllerGateway {
  modelCatalog(): Promise<{ readonly default: ModelRoute }>
}

/**
 * Pick the route the completion dispatches to.
 *
 * The Session's last recorded request is the model the player is actually
 * playing with. A Session that has not sent one yet — a fresh import or branch —
 * has no header, so its pending selection or the deployment default stands in.
 */
async function completionRoute(hostCtx: Context, agent: Agent): Promise<ModelRoute> {
  const header = agent.session.requestHeader()
  if (header !== undefined) return { provider: header.config.provider, model: header.config.model }
  const selection = (hostCtx.get('sessionProjections') as SessionProjectionGateway | undefined)
    ?.stateOf(agent.session, 'modelSelection')
  const selected = selection?.pending ?? selection?.lastUsed
  if (selected != null) return { provider: selected.provider, model: selected.model }
  const controller = hostCtx.get('sessionController') as SessionControllerGateway | undefined
  if (controller === undefined) throw new Error('当前会话还没有选择模型，无法补全记忆')
  const fallback = (await controller.modelCatalog()).default
  return { provider: fallback.provider, model: fallback.model }
}

/** Register the memory-completion endpoint used by the floor panel. */
export function installAgentRpMemoryCompletionHttp(
  routeCtx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: AGENT_RP_MEMORY_COMPLETION_PATH,
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
      // The player can close the panel while the model is still reading; the
      // dropped connection is the only signal that nobody wants the answer.
      const controller = new AbortController()
      const abort = (): void => { controller.abort(new Error('记忆补全请求已中断')) }
      request.once('aborted', abort)
      response.once('close', () => { if (!response.writableEnded) abort() })
      try {
        const body = await readJsonRequest(request, {
          limit: MAX_COMPLETION_BYTES,
          emptyMessage: '记忆补全请求为空',
          tooLargeMessage: '记忆补全请求过大',
          invalidMessage: '记忆补全请求不是有效 JSON',
        }) as Record<string, unknown> | null
        if (typeof body !== 'object' || body === null || Array.isArray(body) || body.format !== 0
          || typeof body.sessionId !== 'string' || body.sessionId === '' || body.sessionId.length > 512
          || Object.keys(body).some(key => !['format', 'sessionId', 'instruction', 'previous'].includes(key))) {
          throw new Error('记忆补全请求无效')
        }
        const guidance = normalizeMemoryCompletionInput(body.instruction, body.previous)
        const agent = (hostCtx.get('agents') as AgentRegistryGateway | undefined)?.get(SessionId(body.sessionId))
        const presets = hostCtx.get('agentPresets') as AgentPresetGateway | undefined
        if (presets === undefined || !agentHasAgentRpRuntime(presets, agent)) throw new Error('角色会话当前不可用')
        // A reply still streaming would be read as a finished floor.
        if (agent.status !== 'idle' || agentHasPendingInput(agent)) throw new Error('请等待当前回复完成后再补全记忆')
        const value = await completeAgentRpMemory({
          ctx: routeCtx,
          session: agent.session,
          route: await completionRoute(hostCtx, agent),
          signal: controller.signal,
          ...guidance,
        })
        json(response, 200, value)
      } catch (error: unknown) {
        if (response.writableEnded || response.destroyed) return
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      } finally {
        request.off('aborted', abort)
      }
    },
  }), 'agent-rp: memory completion HTTP')
}
