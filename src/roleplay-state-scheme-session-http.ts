/** Same-origin route for switching or editing one Session's state contract. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import {
  changeSessionRoleplayStateScheme,
  resolveRoleplayStateTemplate,
  type RoleplayStateSchemeChange,
  type RoleplayStateSchemeTemplateSource,
} from './roleplay-state-scheme-session.ts'
import { readRoleplayStateScheme } from './roleplay-state-scheme.ts'
import { ROLEPLAY_STATE_SCHEME_SESSION_PATH } from './roleplay-state-scheme-session-protocol.ts'

export { ROLEPLAY_STATE_SCHEME_SESSION_PATH } from './roleplay-state-scheme-session-protocol.ts'

const MAX_CHANGE_BYTES = 1024 * 1024

interface AgentRegistryGateway {
  get(sessionId: SessionId): Agent | undefined
}

/** Register the explicit contract-change endpoint for the open roleplay session. */
export function installRoleplayStateSchemeSessionHttp(
  routeCtx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
  library: RoleplayStateSchemeTemplateSource,
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: ROLEPLAY_STATE_SCHEME_SESSION_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST')
        json(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        if (request.method === 'GET') {
          const id = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('session')
          if (id === null || id === '') throw new Error('会话标识缺失')
          const agents = hostCtx.get('agents') as AgentRegistryGateway | undefined
          const live = agents?.get(SessionId(id))
          if (live === undefined) throw new Error('角色会话当前不可用，请重新打开会话后再试')
          // The effective template is resolved here, not in the browser, so the
          // dock panel and the dialog can never disagree about which one wins.
          const scheme = readRoleplayStateScheme(live.session.snapshotEvents())
          const resolved = resolveRoleplayStateTemplate(scheme, library)
          json(response, 200, {
            format: 0,
            ...(scheme === undefined ? {} : { scheme }),
            template: resolved.template,
            templateOrigin: resolved.origin,
          })
          return
        }
        const body = await readJsonRequest(request, {
          limit: MAX_CHANGE_BYTES,
          emptyMessage: '状态方案变更请求为空',
          tooLargeMessage: '状态方案变更请求过大',
          invalidMessage: '状态方案变更请求不是有效 JSON',
        }) as {
          readonly format?: unknown
          readonly sessionId?: unknown
          readonly resourceId?: unknown
          readonly edit?: unknown
        }
        if (body.format !== 0 || typeof body.sessionId !== 'string' || body.sessionId === '') {
          throw new Error('状态方案变更请求无效')
        }
        const agents = hostCtx.get('agents') as AgentRegistryGateway | undefined
        const agent = agents?.get(SessionId(body.sessionId))
        if (agent === undefined) throw new Error('角色会话当前不可用，请重新打开会话后再试')
        const rawEdit = typeof body.edit === 'object' && body.edit !== null && !Array.isArray(body.edit)
          ? body.edit as Record<string, unknown>
          : undefined
        const edit = rawEdit === undefined ? undefined : {
          ...(typeof rawEdit.name === 'string' ? { name: rawEdit.name } : {}),
          ...(Object.hasOwn(rawEdit, 'initial') ? { initial: rawEdit.initial as never } : {}),
          ...(typeof rawEdit.rules === 'string' ? { rules: rawEdit.rules } : {}),
          ...(Object.hasOwn(rawEdit, 'template') ? { template: rawEdit.template as never } : {}),
          ...(Object.hasOwn(rawEdit, 'verificationMaxTokens')
            ? { verificationMaxTokens: rawEdit.verificationMaxTokens as never } : {}),
        }
        const change: RoleplayStateSchemeChange = {
          ...(typeof body.resourceId === 'string' && body.resourceId !== ''
            ? { resourceId: body.resourceId } : {}),
          ...(edit === undefined ? {} : { edit }),
        }
        const scheme = changeSessionRoleplayStateScheme({
          session: agent.session as Session,
          library,
          change,
        })
        await routeCtx.sessions.flush(agent.session as Session)
        json(response, 200, { format: 0, scheme })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      }
    },
  }), 'agent-rp: state scheme session HTTP')
}
