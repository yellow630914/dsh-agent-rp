/** Same-origin upload surface for direct World Info imports. */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { blankLorebookEntry, worldInfoWithEntries } from './embedded-world-info.ts'
import {
  jsonResponse as json,
  readBoundedRequestBody,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { MAX_WORLD_INFO_JSON_BYTES } from './import/world-info.ts'
import { applyEditable, editable, editableWorldInfoEntry } from './world-info-configuration-core.ts'
import { WorldInfoLibrary } from './world-info-library.ts'
import { WORLD_INFO_LIBRARY_PATH } from './world-info-library-protocol.ts'

/** Upper bound on entries one edit may store, mirroring the importer's own ceiling. */
const MAX_WORLD_INFO_ENTRIES = 4_096

async function readUpload(request: IncomingMessage): Promise<Uint8Array> {
  return new Uint8Array(await readBoundedRequestBody(request, {
    limit: MAX_WORLD_INFO_JSON_BYTES,
    emptyMessage: '世界书文件为空',
    tooLargeMessage: '世界书文件过大',
  }))
}

/** Register the browser upload used by the private World Info import command. */
export function installWorldInfoLibraryHttp(
  ctx: Context,
  library: WorldInfoLibrary,
  server: AgentRpHttpServer,
): void {
  ctx.effect(() => server.register({
    kind: 'exact',
    path: WORLD_INFO_LIBRARY_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method === 'GET') {
        const id = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('id')?.trim()
        if (id === undefined || id === '') {
          json(response, 200, { format: 0, entries: library.list() })
          return
        }
        try {
          const asset = library.asset(id)
          json(response, 200, {
            format: 0,
            id,
            name: asset.upload.name,
            entries: asset.worldInfo.lorebook.entries.map(entry => editableWorldInfoEntry(entry)),
          })
        } catch (error: unknown) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (request.method === 'PATCH') {
        try {
          const value = await readJsonRequest(request, {
            limit: 4 * 1024,
            emptyMessage: '世界书默认加载设置为空',
            tooLargeMessage: '世界书默认加载设置过大',
            invalidMessage: '世界书默认加载设置不是有效 JSON',
          })
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('世界书默认加载设置无效')
          const record = value as Record<string, unknown>
          if (record.format !== 0 || typeof record.id !== 'string'
            || typeof record.defaultForNewSessions !== 'boolean'
            || Object.keys(record).some(key => !['format', 'id', 'defaultForNewSessions'].includes(key))) {
            throw new Error('世界书默认加载设置字段无效')
          }
          json(response, 200, { format: 0, upload: library.setDefault(record.id, record.defaultForNewSessions) })
        } catch (error: unknown) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (request.method === 'PUT') {
        try {
          const value = await readJsonRequest(request, {
            limit: MAX_WORLD_INFO_JSON_BYTES + 4 * 1024,
            emptyMessage: '世界书编辑内容为空',
            tooLargeMessage: '世界书编辑内容过大',
            invalidMessage: '世界书编辑内容不是有效 JSON',
          })
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('世界书编辑请求无效')
          const record = value as Record<string, unknown>
          if (record.format !== 0 || typeof record.id !== 'string' || !Array.isArray(record.entries)
            || record.entries.length > MAX_WORLD_INFO_ENTRIES
            || Object.keys(record).some(key => !['format', 'id', 'entries'].includes(key))) {
            throw new Error('世界书编辑请求字段无效')
          }
          const asset = library.asset(record.id)
          const existing = asset.worldInfo.lorebook.entries
          const rows = record.entries.map((value, index) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              throw new Error(`第 ${index + 1} 个条目无效`)
            }
            const row = value as Record<string, unknown>
            const sourceIndex = row.sourceIndex
            if (sourceIndex !== undefined
              && (typeof sourceIndex !== 'number' || !Number.isSafeInteger(sourceIndex)
                || sourceIndex < 0 || sourceIndex >= existing.length)) {
              throw new Error(`第 ${index + 1} 个条目引用了不存在的原始条目`)
            }
            const base = sourceIndex === undefined
              ? blankLorebookEntry(`new-${index}`)
              : existing[sourceIndex]!
            return {
              ...(sourceIndex === undefined ? {} : { sourceIndex }),
              entry: applyEditable(base, editable(row.entry, `第 ${index + 1} 个条目`)),
            }
          })
          const rebuilt = worldInfoWithEntries(asset.worldInfo, rows)
          const upload = library.update(record.id, new TextEncoder().encode(`${JSON.stringify(rebuilt, null, 2)}
`))
          json(response, 200, { format: 0, upload })
        } catch (error: unknown) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (request.method === 'DELETE') {
        try {
          const value = await readJsonRequest(request, {
            limit: 4 * 1024,
            emptyMessage: '世界书移除请求为空',
            tooLargeMessage: '世界书移除请求过大',
            invalidMessage: '世界书移除请求不是有效 JSON',
          })
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('世界书移除请求无效')
          const record = value as Record<string, unknown>
          if (record.format !== 0 || typeof record.id !== 'string'
            || Object.keys(record).some(key => !['format', 'id'].includes(key))) {
            throw new Error('世界书移除请求字段无效')
          }
          json(response, 200, { format: 0, upload: library.remove(record.id) })
        } catch (error: unknown) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'DELETE, GET, PATCH, POST, PUT')
        json(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const filename = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('filename')?.trim()
        if (filename === undefined || filename === '') throw new Error('世界书文件名缺失')
        json(response, 200, { format: 0, upload: library.importFile({ data: await readUpload(request), filename }) })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      }
    },
  }), 'agent-rp: World Info upload HTTP')
}
