/** Same-origin HTTP surface for the local Persona library. */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  jsonResponse as json,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { PersonaLibrary } from './persona-library.ts'
import { PERSONA_LIBRARY_PATH, type PersonaLibrarySaveRequest } from './persona-library-protocol.ts'

async function readJson(request: IncomingMessage): Promise<unknown> {
  return readJsonRequest(request, {
    limit: 16_384,
    emptyMessage: 'Persona 请求为空',
    tooLargeMessage: 'Persona 请求过大',
    invalidMessage: 'Persona 请求不是有效 JSON',
  })
}

function parseSaveRequest(value: unknown): PersonaLibrarySaveRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Persona 请求不是对象')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.format !== 0 || typeof record.name !== 'string' || typeof record.description !== 'string'
    || (record.id !== undefined && typeof record.id !== 'string')
    || keys.some(key => !['format', 'id', 'name', 'description', 'tags'].includes(key))) {
    throw new Error('Persona 请求字段无效')
  }
  return record as unknown as PersonaLibrarySaveRequest
}

/** Register local Persona list, read, create, update, and delete operations. */
export function installPersonaLibraryHttp(ctx: Context, library: PersonaLibrary, server: AgentRpHttpServer): void {
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: PERSONA_LIBRARY_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://agent-rp.local').pathname
      const suffix = pathname === PERSONA_LIBRARY_PATH ? '' : pathname.slice(PERSONA_LIBRARY_PATH.length + 1)
      try {
        if (request.method === 'GET' && suffix === '') {
          json(response, 200, { format: 0, entries: library.list() })
          return
        }
        if (request.method === 'GET' && suffix !== '' && !suffix.includes('/')) {
          json(response, 200, { format: 0, entry: library.get(decodeURIComponent(suffix)) })
          return
        }
        if (request.method === 'POST' && suffix === '') {
          json(response, 200, { format: 0, entry: library.save(parseSaveRequest(await readJson(request))) })
          return
        }
        if (request.method === 'DELETE' && suffix !== '' && !suffix.includes('/')) {
          json(response, 200, { format: 0, entry: library.remove(decodeURIComponent(suffix)) })
          return
        }
        response.setHeader('allow', 'GET, POST, DELETE')
        json(response, request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE' ? 404 : 405, { error: 'not found' })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /库中没有/u.test(message) ? 404 : 400, { error: message })
      }
    },
  }), 'agent-rp: Persona library HTTP')
}
