/** Same-origin route for attaching one library regex pack to a live Session. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import type { RegexPackLibrary } from './regex-pack-library.ts'
import { attachSessionRegexPack } from './session-regex-pack.ts'
import {
  SESSION_REGEX_PACK_PATH,
  type SessionRegexPackAttachResponse,
} from './session-regex-pack-protocol.ts'

const MAX_ATTACH_BYTES = 4 * 1024

interface AgentRegistryGateway {
  get(sessionId: SessionId): Agent | undefined
}

/** Register the pack-attach endpoint used by the open Session's regex manager. */
export function installSessionRegexPackHttp(
  routeCtx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
  library: RegexPackLibrary,
): void {
  routeCtx.effect(() => server.register({
    kind: 'exact',
    path: SESSION_REGEX_PACK_PATH,
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
          limit: MAX_ATTACH_BYTES,
          emptyMessage: '正则包引入请求为空',
          tooLargeMessage: '正则包引入请求过大',
          invalidMessage: '正则包引入请求不是有效 JSON',
        }) as Record<string, unknown>
        if (body.format !== 0 || typeof body.sessionId !== 'string' || body.sessionId === ''
          || typeof body.packId !== 'string' || body.packId === ''
          || Object.keys(body).some(key => !['format', 'sessionId', 'packId'].includes(key))) {
          throw new Error('正则包引入请求无效')
        }
        const agents = hostCtx.get('agents') as AgentRegistryGateway | undefined
        const agent = agents?.get(SessionId(body.sessionId))
        // Only a live Session can take one: the request comes from the regex
        // manager of a conversation the player currently has open.
        if (agent === undefined) throw new Error('角色会话当前不可用，请重新打开会话后再试')
        // Read the library once and freeze the content into the log, so editing
        // or deleting the pack later never changes what this Session runs.
        const pack = library.get(body.packId)
        const attached = attachSessionRegexPack(agent.session, {
          format: 0,
          id: pack.id,
          name: pack.name,
          scripts: pack.scripts,
        })
        await routeCtx.sessions.flush(agent.session as Session)
        const value: SessionRegexPackAttachResponse = {
          format: 0,
          id: attached.id,
          name: attached.name,
          scriptCount: attached.scripts.length,
        }
        json(response, 200, value)
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(text) ? 413 : 400, { error: text })
      }
    },
  }), 'agent-rp: session regex pack HTTP')
}
