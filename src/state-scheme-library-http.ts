/** Same-origin authoring surface for the local native state-scheme library. */

import type { Context } from '@deepseek-ai/cordis'
import {
  jsonResponse as json,
  readBoundedRequestBody,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { StateSchemeLibrary } from './state-scheme-library.ts'
import {
  MAX_STATE_SCHEME_BYTES,
  STATE_SCHEME_LIBRARY_PATH,
  type StateSchemeLibrarySaveRequest,
} from './state-scheme-library-protocol.ts'

function requestId(url: string | undefined): string | null {
  return new URL(url ?? '/', 'http://agent-rp.local').searchParams.get('id')
}

/** Register model-free list, read, save, and removal routes. */
export function installStateSchemeLibraryHttp(
  ctx: Context,
  library: StateSchemeLibrary,
  server: AgentRpHttpServer,
): void {
  ctx.effect(() => server.register({
    kind: 'exact',
    path: STATE_SCHEME_LIBRARY_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      try {
        if (request.method === 'GET') {
          const id = requestId(request.url)
          if (id === null) json(response, 200, { format: 0, entries: library.list() })
          else json(response, 200, { format: 0, entry: library.get(id) })
          return
        }
        if (request.method === 'DELETE') {
          const id = requestId(request.url)
          if (id === null) {
            json(response, 400, { error: '状态方案库 id 缺失' })
            return
          }
          library.delete(id)
          json(response, 200, { format: 0, id })
          return
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'DELETE, GET, POST')
          json(response, 405, { error: 'method not allowed' })
          return
        }
        const body = await readBoundedRequestBody(request, {
          limit: MAX_STATE_SCHEME_BYTES,
          emptyMessage: '状态方案请求为空',
          tooLargeMessage: '状态方案超过 1 MiB',
        })
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('状态方案保存请求无效')
        }
        json(response, 200, { format: 0, entry: library.save(parsed as StateSchemeLibrarySaveRequest) })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /超过 1 MiB/u.test(message) ? 413 : 400, { error: message })
      }
    },
  }), 'agent-rp: state-scheme library HTTP')
}
