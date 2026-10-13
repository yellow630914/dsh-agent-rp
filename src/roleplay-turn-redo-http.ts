/** Same-origin route for redoing the last turn with edited player input. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import {
  ROLEPLAY_TURN_REDO_PATH,
  type RoleplayTurnRedoResponse,
} from './roleplay-turn-redo-protocol.ts'
import { retireRoleplayLastTurn, roleplayLastTurnRedo } from './roleplay-turn-redo.ts'

/** The edited input is one chat message, so the same ceiling the composer uses. */
const MAX_REDO_BYTES = 128 * 1024

interface AgentRegistryGateway {
  get(sessionId: SessionId): Agent | undefined
}

interface BusyAgent {
  readonly status?: string
  hasPendingInput?(): boolean
}

/** Register the redo endpoint used by the transcript's edit-input control. */
export function installRoleplayTurnRedoHttp(
  routeCtx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: ROLEPLAY_TURN_REDO_PATH,
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
        const body = await readJsonRequest(request, {
          limit: MAX_REDO_BYTES,
          emptyMessage: '重做请求为空',
          tooLargeMessage: '重做请求过大',
          invalidMessage: '重做请求不是有效 JSON',
        }) as Record<string, unknown>
        if (body.format !== 0 || typeof body.sessionId !== 'string' || body.sessionId === ''
          || typeof body.text !== 'string' || body.text.trim() === ''
          || Object.keys(body).some(key => !['format', 'sessionId', 'text'].includes(key))) {
          throw new Error('重做请求无效')
        }
        const agents = hostCtx.get('agents') as AgentRegistryGateway | undefined
        const agent = agents?.get(SessionId(body.sessionId))
        if (agent === undefined) throw new Error('角色会话当前不可用，请重新打开会话后再试')
        // Retiring a turn while one is running would cut rows the live turn is
        // still appending to, and the re-send would race the reply in flight.
        const busy = agent as unknown as BusyAgent
        if (busy.status !== undefined && busy.status !== 'idle') {
          throw new Error('请等待当前回复完成后再重做')
        }
        const redo = roleplayLastTurnRedo(agent.session as Session)
        if (redo === undefined) throw new Error('最后一轮没有可改写的玩家输入')
        const restoredStates = retireRoleplayLastTurn(agent.session as Session, redo)
        await routeCtx.sessions.flush(agent.session as Session)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: body.text }],
          source: { kind: 'user' },
        }))
        const value: RoleplayTurnRedoResponse = {
          format: 0,
          turn: redo.turn,
          retiredRows: redo.retiredSeqs.length,
          restoredStates,
        }
        json(response, 200, value)
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(text) ? 413 : 400, { error: text })
      }
    },
  }), 'agent-rp: roleplay turn redo HTTP')
}
