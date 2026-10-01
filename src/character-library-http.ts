/** Same-origin HTTP surface for the local Character Card library. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { CharacterLibrary } from './character-library.ts'
import {
  CHARACTER_LIBRARY_PATH, type CharacterLibraryDetail, type CharacterLibraryEditRequest,
  type CharacterRemoteResourceType, type CharacterWorldBindingUpdateRequest,
} from './character-library-protocol.ts'
import { CharacterWorldBindingConflictError } from './character-world-binding-store.ts'
import { isCharacterRemoteResourceType } from './card-remote-resource.ts'
import {
  jsonResponse as json,
  readBoundedRequestBody,
  trustedBrowserRequest,
  type AgentRpHttpServer,
} from './host-http.ts'
import { MAX_CHARACTER_CARD_FILE_BYTES } from './import/character-card.ts'
import { decodeCharacterLibraryLaunch } from './import/session-character.ts'

interface SessionPersistenceGateway {
  listSnapshots(): Promise<readonly {
    readonly header: { readonly id: SessionId }
    readonly revision: unknown
  }[]>
  inspect(id: SessionId): Promise<{ readonly events: readonly SessionEvent[] }>
}

class CharacterLibraryConflictError extends Error {}

function snapshotSignature(snapshots: readonly {
  readonly header: { readonly id: SessionId }
  readonly revision: unknown
}[]): string {
  return JSON.stringify(snapshots.map(snapshot => [String(snapshot.header.id), String(snapshot.revision)]).sort())
}

function sessionReferencesCharacter(events: readonly SessionEvent[], id: string): boolean {
  for (const event of events) {
    if (event.type === 'agent-rp/character-card-seed'
      && 'characterLibraryId' in event.data.source
      && event.data.source.characterLibraryId === id) return true
    if (event.type === 'command/done' && event.data.kind === 'success'
      && decodeCharacterLibraryLaunch(event.data.text)?.libraryId === id) return true
  }
  return false
}

async function referencingSessions(hostCtx: Context, id: string): Promise<readonly SessionId[]> {
  const persistence = hostCtx.get('sessionPersistence') as SessionPersistenceGateway | undefined
  if (persistence === undefined) throw new Error('当前 Host 无法核对角色卡的历史会话引用')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await persistence.listSnapshots()
    const references: SessionId[] = []
    for (const snapshot of before) {
      const session = await persistence.inspect(snapshot.header.id)
      if (sessionReferencesCharacter(session.events, id)) references.push(snapshot.header.id)
    }
    const after = await persistence.listSnapshots()
    if (snapshotSignature(before) === snapshotSignature(after)) return references
  }
  throw new CharacterLibraryConflictError('会话正在变化，暂时不能安全删除角色卡；请稍后重试')
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message })
}

function browserDetail(entry: CharacterLibraryDetail): CharacterLibraryDetail {
  const { worldInfo, ...overview } = entry
  void worldInfo
  return overview
}

async function readUpload(request: IncomingMessage): Promise<Uint8Array> {
  return new Uint8Array(await readBoundedRequestBody(request, {
    limit: MAX_CHARACTER_CARD_FILE_BYTES,
    emptyMessage: '角色卡文件为空',
    tooLargeMessage: '角色卡文件过大',
  }))
}

async function readEditRequest(request: IncomingMessage): Promise<CharacterLibraryEditRequest> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readUpload(request)))
  } catch (error) {
    throw new Error('角色修订请求不是有效 JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('角色修订请求无效')
  const record = value as Record<string, unknown>
  if (record.format !== 0 || typeof record.operation !== 'string'
    || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error('角色修订请求字段无效')
  }
  if (record.operation === 'save-content' && typeof record.content === 'object' && record.content !== null) {
    return record as unknown as CharacterLibraryEditRequest
  }
  if (record.operation === 'set-regex-enabled'
    && typeof record.index === 'number' && Number.isSafeInteger(record.index) && record.index >= 0
    && typeof record.enabled === 'boolean') {
    return record as unknown as CharacterLibraryEditRequest
  }
  if (record.operation === 'reset') return record as unknown as CharacterLibraryEditRequest
  throw new Error('角色修订操作无效')
}

async function readWorldBindingUpdateRequest(request: IncomingMessage): Promise<CharacterWorldBindingUpdateRequest> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readUpload(request)))
  } catch (error) {
    throw new Error('角色世界组合请求不是有效 JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('角色世界组合请求无效')
  }
  const record = value as Record<string, unknown>
  if (record.format !== 0
    || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0
    || (record.primaryWorldInfoId !== null && typeof record.primaryWorldInfoId !== 'string')
    || !Array.isArray(record.additionalWorldInfoIds)
    || record.additionalWorldInfoIds.some(worldInfoId => typeof worldInfoId !== 'string')
    || Object.keys(record).some(key => ![
      'format', 'revision', 'primaryWorldInfoId', 'additionalWorldInfoIds',
    ].includes(key))) {
    throw new Error('角色世界组合请求字段无效')
  }
  return record as unknown as CharacterWorldBindingUpdateRequest
}

function pathParts(request: IncomingMessage): readonly string[] {
  const pathname = new URL(request.url ?? '/', 'http://agent-rp.local').pathname
  if (pathname === CHARACTER_LIBRARY_PATH) return []
  if (!pathname.startsWith(`${CHARACTER_LIBRARY_PATH}/`)) return ['invalid']
  return pathname.slice(CHARACTER_LIBRARY_PATH.length + 1).split('/').map(decodeURIComponent)
}

/** Register local library reads plus reversible archive and guarded delete operations for the Roleplay UI. */
export function installCharacterLibraryHttp(
  ctx: Context,
  hostCtx: Context,
  library: CharacterLibrary,
  server: AgentRpHttpServer,
): void {
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: CHARACTER_LIBRARY_PATH,
    async handler(request, response) {
      const parts = pathParts(request)
      const sandboxedImage = parts.length === 3 && parts[0] !== undefined
        && parts[1] === 'images' && parts[2] !== undefined && /^\d+$/u.test(parts[2])
      if (!trustedBrowserRequest(request, sandboxedImage)) {
        fail(response, 403, 'forbidden')
        return
      }
      try {
        if (request.method === 'GET' && parts.length === 0) {
          const url = new URL(request.url ?? '/', 'http://agent-rp.local')
          const collection = url.searchParams.get('collection')
          if (collection !== null && collection !== 'active' && collection !== 'archived') {
            fail(response, 400, 'invalid character collection')
            return
          }
          json(response, 200, { format: 0, entries: library.list(collection ?? 'active') })
          return
        }
        if (request.method === 'GET' && parts.length === 1 && parts[0] !== undefined) {
          json(response, 200, { format: 0, entry: library.overview(parts[0]) })
          return
        }
        if (request.method === 'DELETE' && parts.length === 1 && parts[0] !== undefined) {
          const entry = library.overview(parts[0])
          if (!entry.archived) throw new Error('请先把角色移入收纳箱，再永久删除')
          const references = await referencingSessions(hostCtx, entry.id)
          if (references.length > 0) {
            throw new CharacterLibraryConflictError(
              `仍有 ${references.length} 个历史会话使用角色「${entry.displayName}」，不能永久删除`,
            )
          }
          library.deleteArchived(entry.id)
          json(response, 200, { format: 0, id: entry.id })
          return
        }
        if (request.method === 'GET' && parts.length === 2 && parts[0] !== undefined
          && parts[1] === 'runtime-detail') {
          const resolved = library.resolve(parts[0])
          const displayRegexScripts = resolved.card.frontend.regexScripts
            .filter(script => script.markdownOnly && !script.promptOnly)
          json(response, 200, { format: 0, entry: browserDetail(resolved.detail), displayRegexScripts })
          return
        }
        if (request.method === 'POST' && parts.length === 1 && parts[0] === 'import') {
          const url = new URL(request.url ?? '/', 'http://agent-rp.local')
          const filename = url.searchParams.get('filename')?.trim()
          if (filename === undefined || filename === '') {
            fail(response, 400, '角色卡文件名缺失')
            return
          }
          const result = library.importFileWithOutcome({
            data: await readUpload(request),
            filename,
            ...(request.headers['content-type'] === undefined ? {} : { mediaType: request.headers['content-type'] }),
          })
          json(response, 200, { format: 0, ...result, entry: browserDetail(result.entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 3 && parts[0] !== undefined
          && parts[1] === 'display-extensions' && parts[2] === 'import') {
          const url = new URL(request.url ?? '/', 'http://agent-rp.local')
          const filename = url.searchParams.get('filename')?.trim()
          if (filename === undefined || filename === '') {
            fail(response, 400, '显示扩展文件名缺失')
            return
          }
          let approvedImageOrigins: unknown
          try {
            approvedImageOrigins = JSON.parse(url.searchParams.get('approvedOrigins') ?? '[]')
          } catch {
            fail(response, 400, '外部图片授权无效')
            return
          }
          if (!Array.isArray(approvedImageOrigins)
            || approvedImageOrigins.some(origin => typeof origin !== 'string')) {
            fail(response, 400, '外部图片授权无效')
            return
          }
          const entry = library.importDisplayExtension(parts[0], {
            data: await readUpload(request),
            filename,
            approvedImageOrigins,
          })
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 4 && parts[0] !== undefined
          && parts[1] === 'display-extensions' && parts[2] !== undefined
          && (parts[3] === 'enable' || parts[3] === 'disable' || parts[3] === 'remove')) {
          const entry = parts[3] === 'remove'
            ? library.removeDisplayExtension(parts[0], parts[2])
            : library.setDisplayExtensionEnabled(parts[0], parts[2], parts[3] === 'enable')
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 2 && parts[0] !== undefined
          && parts[1] === 'text-replacements') {
          const body = await readUpload(request)
          let value: unknown
          try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
          } catch {
            fail(response, 400, '本地文字修正不是有效 JSON')
            return
          }
          if (typeof value !== 'object' || value === null || Array.isArray(value)
            || typeof (value as { readonly from?: unknown }).from !== 'string'
            || typeof (value as { readonly to?: unknown }).to !== 'string') {
            fail(response, 400, '本地文字修正字段无效')
            return
          }
          const replacement = value as { readonly from: string; readonly to: string }
          json(response, 200, {
            format: 0,
            entry: browserDetail(library.replaceText(parts[0], replacement.from, replacement.to)),
          })
          return
        }
        if (request.method === 'POST' && parts.length === 2 && parts[0] !== undefined
          && parts[1] === 'edits') {
          const edit = await readEditRequest(request)
          const entry = edit.operation === 'save-content'
            ? library.updateContent(parts[0], edit.content, edit.revision)
            : edit.operation === 'set-regex-enabled'
              ? library.setRegexEnabled(parts[0], edit.index, edit.enabled, edit.revision)
              : library.resetLocalEdits(parts[0], edit.revision)
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 2 && parts[0] !== undefined
          && parts[1] === 'world-binding') {
          const entry = library.updateWorldBinding(parts[0], await readWorldBindingUpdateRequest(request))
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 2 && parts[0] !== undefined
          && (parts[1] === 'archive' || parts[1] === 'restore')) {
          const entry = parts[1] === 'archive' ? library.archive(parts[0]) : library.restore(parts[0])
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 2 && parts[0] !== undefined && parts[1] === 'tags') {
          let value: unknown
          try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readUpload(request)))
          } catch (error) {
            throw new Error('角色分类请求不是有效 JSON', { cause: error })
          }
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('角色分类请求无效')
          const record = value as Record<string, unknown>
          if (record.format !== 0 || Object.keys(record).some(key => !['format', 'tags'].includes(key))) {
            throw new Error('角色分类请求字段无效')
          }
          const entry = library.setTags(parts[0], record.tags as readonly string[])
          json(response, 200, { format: 0, entry: browserDetail(entry) })
          return
        }
        if (request.method === 'POST' && parts.length === 3 && parts[0] !== undefined
          && parts[1] === 'remote-resources' && (parts[2] === 'approve' || parts[2] === 'revoke')) {
          const search = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams
          const origin = search.get('origin')
          if (origin === null) {
            fail(response, 400, '外部资源来源缺失')
            return
          }
          const type = search.get('type')
          if (type !== null && !isCharacterRemoteResourceType(type)) {
            fail(response, 400, '外部资源类型无效')
            return
          }
          json(response, 200, {
            format: 0,
            entry: browserDetail(type === null
              ? library.setRemoteResourceOriginApproved(parts[0], origin, parts[2] === 'approve')
              : library.setRemoteResourceApproved(
                  parts[0], origin, type as CharacterRemoteResourceType, parts[2] === 'approve',
                )),
          })
          return
        }
        if (request.method === 'POST' && parts.length === 3 && parts[0] !== undefined
          && parts[1] === 'remote-resources' && parts[2] === 'policy') {
          const policy = new URL(request.url ?? '/', 'http://agent-rp.local').searchParams.get('value')
          if (policy !== 'prompt' && policy !== 'isolated-https') {
            fail(response, 400, '外部资源策略无效')
            return
          }
          json(response, 200, {
            format: 0,
            entry: browserDetail(library.setRemoteResourcePolicy(parts[0], policy)),
          })
          return
        }
        if (request.method === 'GET' && parts.length === 2 && parts[0] !== undefined && parts[1] === 'world-info') {
          const url = new URL(request.url ?? '/', 'http://agent-rp.local')
          const offset = Number(url.searchParams.get('offset') ?? '0')
          const limit = Number(url.searchParams.get('limit') ?? '40')
          if (!Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            fail(response, 400, 'invalid World Info page')
            return
          }
          const page = library.worldInfoPage(parts[0], offset, limit)
          if (page === undefined) {
            fail(response, 404, 'World Info not found')
            return
          }
          json(response, 200, { format: 0, page })
          return
        }
        if (request.method === 'GET' && parts.length === 2 && parts[0] !== undefined && parts[1] === 'asset') {
          const asset = library.asset(parts[0])
          response.writeHead(200, {
            'cache-control': 'private, max-age=31536000, immutable',
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.originalFilename)}`,
            'content-length': String(asset.data.byteLength),
            'content-type': asset.mediaType,
            'x-content-type-options': 'nosniff',
          })
          response.end(asset.data)
          return
        }
        if (request.method === 'GET' && parts.length === 2 && parts[0] !== undefined && parts[1] === 'export') {
          const asset = library.exportModified(parts[0])
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
            'content-length': String(asset.data.byteLength),
            'content-type': asset.mediaType,
            'x-content-type-options': 'nosniff',
          })
          response.end(asset.data)
          return
        }
        if (request.method === 'GET' && parts.length === 2 && parts[0] !== undefined && parts[1] === 'avatar') {
          const avatar = library.avatar(parts[0])
          if (avatar === undefined) {
            fail(response, 404, 'avatar not found')
            return
          }
          response.writeHead(200, {
            'cache-control': 'private, max-age=31536000, immutable',
            'content-length': String(avatar.data.byteLength),
            'content-type': avatar.mediaType,
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
          })
          response.end(avatar.data)
          return
        }
        if (request.method === 'GET' && parts.length === 3 && parts[0] !== undefined && parts[1] === 'images' && parts[2] !== undefined) {
          const index = /^\d+$/u.test(parts[2]) ? Number(parts[2]) : Number.NaN
          const image = library.image(parts[0], index)
          if (image === undefined) {
            fail(response, 404, 'image not found')
            return
          }
          response.writeHead(200, {
            'cache-control': 'private, max-age=31536000, immutable',
            'content-length': String(image.data.byteLength),
            'content-type': image.mediaType,
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
          })
          response.end(image.data)
          return
        }
        if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
          response.setHeader('allow', 'GET, POST, DELETE')
          fail(response, 405, 'method not allowed')
          return
        }
        fail(response, 404, 'not found')
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        fail(response, error instanceof CharacterLibraryConflictError
          || error instanceof CharacterWorldBindingConflictError ? 409
          : /角色库中没有/u.test(message) ? 404 : /过大/u.test(message) ? 413 : 400, message)
      }
    },
  }), 'agent-rp: character library HTTP')
}
