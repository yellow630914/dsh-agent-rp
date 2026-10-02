/** Same-origin HTTP import surface for the local SillyTavern preset library. */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  jsonResponse as json,
  readBoundedRequestBody,
  readJsonRequest,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { parseSillyTavernPresetBytes } from './import/sillytavern-preset.ts'
import { PresetLibrary } from './preset-library.ts'
import { PRESET_LIBRARY_PATH } from './preset-library-http-protocol.ts'
import { configurePreset, parsePresetConfigurationRequest } from './preset-configuration-core.ts'
import { presetProjection } from './projection.ts'

const MAX_PRESET_EDIT_BYTES = 4 * 1024 * 1024

const MAX_PRESET_BYTES = 64 * 1024 * 1024

async function readUpload(request: IncomingMessage): Promise<Uint8Array> {
  return new Uint8Array(await readBoundedRequestBody(request, {
    limit: MAX_PRESET_BYTES,
    emptyMessage: '预设文件为空',
    tooLargeMessage: '预设文件过大',
  }))
}

async function readRename(request: IncomingMessage): Promise<string> {
  const value = await readJsonRequest(request, {
    limit: 8 * 1024,
    emptyMessage: '预设名称请求为空',
    tooLargeMessage: '预设名称请求过大',
    invalidMessage: '预设名称请求不是有效 JSON',
  })
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>).name !== 'string') {
    throw new Error('预设名称请求缺少 name')
  }
  return (value as { readonly name: string }).name
}

/** Register model-free preset listing and upload routes for the Roleplay UI. */
export function installPresetLibraryHttp(ctx: Context, library: PresetLibrary, server: AgentRpHttpServer): void {
  ctx.effect(() => server.register({
    kind: 'exact',
    path: PRESET_LIBRARY_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      try {
        if (request.method === 'GET') {
          const id = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('id')
          if (id === null) {
            json(response, 200, { format: 0, entries: library.list() })
            return
          }
          // One preset in full, shaped the way the manager dialog already reads
          // a Session's own: the stored value is its own baseline, so nothing
          // reads as modified and "restore" restores to what is on disk.
          const entry = library.get(id)
          json(response, 200, {
            format: 0,
            id: entry.id,
            updatedAt: entry.updatedAt,
            view: presetProjection(entry.name, entry.preset, 0, entry.preset, entry.id),
          })
          return
        }
        if (request.method === 'PUT') {
          const body = await readJsonRequest(request, {
            limit: MAX_PRESET_EDIT_BYTES,
            emptyMessage: '预设编辑请求为空',
            tooLargeMessage: '预设编辑请求过大',
            invalidMessage: '预设编辑请求不是有效 JSON',
          }) as Record<string, unknown>
          if (body.format !== 0 || typeof body.id !== 'string' || body.id === ''
            || typeof body.expectedUpdatedAt !== 'number' || !Number.isSafeInteger(body.expectedUpdatedAt)
            || Object.keys(body).some(key => !['format', 'id', 'expectedUpdatedAt', 'request'].includes(key))) {
            throw new Error('预设编辑请求无效')
          }
          const entry = library.get(body.id)
          // The library has no overlay, so two editors would silently overwrite
          // one another. The stored timestamp is the concurrency token.
          if (entry.updatedAt !== body.expectedUpdatedAt) {
            throw new Error('这个预设已在别处改变，请关闭后重新打开')
          }
          // The same pure reducer the Session manager uses. `importedPreset` is
          // the stored value, so `revision` is always 0 here and "restore"
          // means "back to what is on disk".
          const next = configurePreset({
            result: {
              version: 0,
              name: entry.name,
              sourceEventSeq: 0,
              sourceAttachmentId: entry.id,
              promptCount: entry.promptCount,
              enabledCount: entry.enabledCount,
              regexScriptCount: entry.regexScriptCount,
            },
            importedPreset: entry.preset,
            preset: entry.preset,
            revision: 0,
          }, parsePresetConfigurationRequest(JSON.stringify(body.request)))
          const saved = library.replace(entry.id, next)
          json(response, 200, {
            format: 0,
            id: saved.id,
            updatedAt: saved.updatedAt,
            view: presetProjection(saved.name, saved.preset, 0, saved.preset, saved.id),
          })
          return
        }
        if (request.method === 'PATCH') {
          const id = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('id')
          if (id === null) {
            json(response, 400, { error: '预设库 id 缺失' })
            return
          }
          const { preset: _preset, ...entry } = library.rename(id, await readRename(request))
          json(response, 200, { format: 0, entry })
          return
        }
        if (request.method === 'DELETE') {
          const id = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('id')
          if (id === null) {
            json(response, 400, { error: '预设库 id 缺失' })
            return
          }
          library.delete(id)
          json(response, 200, { format: 0, id })
          return
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'DELETE, GET, PATCH, POST, PUT')
          json(response, 405, { error: 'method not allowed' })
          return
        }
        const filename = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('filename')?.trim()
        if (filename === undefined || filename === '' || !/\.json$/iu.test(filename)) {
          json(response, 400, { error: '请选择 SillyTavern 预设 JSON 文件' })
          return
        }
        const preset = parseSillyTavernPresetBytes(await readUpload(request), filename)
        json(response, 200, { format: 0, entry: library.import(preset) })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        json(response, /过大/u.test(message) ? 413 : 400, { error: message })
      }
    },
  }), 'agent-rp: preset library HTTP')
}
