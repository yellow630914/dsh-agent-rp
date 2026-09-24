/** Same-origin route for the player-requested state recalculation. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import type { EjsTemplateEngine } from './ejs-template.ts'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { resettleRoleplayState } from './roleplay-state-resettle.ts'
import {
  ROLEPLAY_STATE_RESETTLE_PATH,
  type RoleplayStateResettleResponse,
} from './roleplay-state-resettle-protocol.ts'
import type { RoleplayRuntimeExtensionRegistry } from './roleplay-runtime-extension.ts'
import type { WorkspaceSettingsStore } from './workspace-settings-store.ts'

const MAX_RESETTLE_BYTES = 8 * 1024

interface AgentRegistryGateway {
  get(sessionId: SessionId): Agent | undefined
}

/** Register the explicit recalculation endpoint for the open roleplay session. */
export function installRoleplayStateResettleHttp(
  routeCtx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
  options: {
    readonly deployment: ResolvedConfig
    readonly workspaceSettings: WorkspaceSettingsStore
    readonly templateEngine?: EjsTemplateEngine
    readonly extensions?: RoleplayRuntimeExtensionRegistry
  },
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: ROLEPLAY_STATE_RESETTLE_PATH,
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
      const controller = new AbortController()
      const abort = (): void => { controller.abort(new Error('状态重新结算请求已中断')) }
      request.once('aborted', abort)
      try {
        const body = await readJsonRequest(request, {
          limit: MAX_RESETTLE_BYTES,
          emptyMessage: '状态重新结算请求为空',
          tooLargeMessage: '状态重新结算请求过大',
          invalidMessage: '状态重新结算请求不是有效 JSON',
        }) as { readonly format?: unknown; readonly sessionId?: unknown }
        if (body.format !== 0 || typeof body.sessionId !== 'string' || body.sessionId === '') {
          throw new Error('状态重新结算请求无效')
        }
        const agents = hostCtx.get('agents') as AgentRegistryGateway | undefined
        const agent = agents?.get(SessionId(body.sessionId))
        // Only a live Session can be recalculated: the request comes from the
        // panel of a conversation the player currently has open.
        if (agent === undefined) throw new Error('角色会话当前不可用，请重新打开会话后再试')
        const result = await resettleRoleplayState({
          ctx: routeCtx,
          agent,
          deployment: options.deployment,
          verification: options.workspaceSettings.get().turnWorkers.stateVerification,
          signal: controller.signal,
          ...(options.templateEngine === undefined ? {} : { templateEngine: options.templateEngine }),
          ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        })
        const value: RoleplayStateResettleResponse = {
          format: 0,
          outcome: result.outcome,
          ...(result.revision === undefined ? {} : { revision: result.revision }),
          ...(result.error === undefined ? {} : { error: result.error }),
        }
        json(response, 200, value)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      } finally {
        request.off('aborted', abort)
      }
    },
  }), 'agent-rp: state resettle HTTP')
}
