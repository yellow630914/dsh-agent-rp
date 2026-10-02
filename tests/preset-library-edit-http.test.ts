/** Reading and editing one library preset from the resource center. */

import assert from 'node:assert/strict'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRpHttpServer } from '../src/host-http.ts'
import { parseSillyTavernPresetJson } from '../src/import/sillytavern-preset.ts'
import { PresetLibrary } from '../src/preset-library.ts'
import { installPresetLibraryHttp } from '../src/preset-library-http.ts'
import { PRESET_LIBRARY_PATH } from '../src/preset-library-http-protocol.ts'

type RegisteredRoute = Parameters<AgentRpHttpServer['register']>[0]

const source = JSON.stringify({
  prompts: [
    { identifier: 'main', name: '主提示', role: 'system', content: '默认正文' },
    { identifier: 'style', name: '风格', role: 'system', content: '简短' },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true },
    { identifier: 'style', enabled: false },
  ] }],
  extensions: { regex_scripts: [] },
})

function fixture(context: { after: (fn: () => void) => void }): {
  readonly route: RegisteredRoute
  readonly library: PresetLibrary
  readonly id: string
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-rp-preset-edit-'))
  context.after(() => { rmSync(root, { force: true, recursive: true }) })
  const library = new PresetLibrary({ root })
  const entry = library.import(parseSillyTavernPresetJson(source, '通用预设.json'))
  let route: RegisteredRoute | undefined
  const ctx = { effect(register: () => unknown) { register() } } as unknown as Context
  const server: AgentRpHttpServer = { register(next) { route = next; return () => {} } }
  installPresetLibraryHttp(ctx, library, server)
  assert.ok(route)
  return { route, library, id: entry.id }
}

async function invoke(route: RegisteredRoute, options: {
  readonly method: string
  readonly query?: string
  readonly body?: unknown
  readonly headers?: IncomingHttpHeaders
}): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const payload = options.body === undefined ? [] : [JSON.stringify(options.body)]
  const request = Object.assign(Readable.from(payload), {
    method: options.method,
    url: `${PRESET_LIBRARY_PATH}${options.query ?? ''}`,
    headers: {
      host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...options.headers,
    } satisfies IncomingHttpHeaders,
  }) as unknown as IncomingMessage
  let status = 0
  let out = Buffer.alloc(0)
  const response = {
    setHeader() { return response },
    writeHead(value: number) { status = value; return response },
    end(value?: string | Uint8Array) { if (value !== undefined) out = Buffer.from(value); return response },
  } as unknown as ServerResponse
  await route.handler(request, response)
  return { status, json: JSON.parse(out.toString('utf8')) as Record<string, unknown> }
}

type View = {
  readonly name: string
  readonly promptCount: number
  readonly enabledCount: number
  readonly prompts: readonly {
    readonly identifier: string
    readonly content: string
    readonly attached: boolean
    readonly contentModified: boolean
  }[]
}

test('reads one library preset as the manager dialog reads a Session preset', async context => {
  const { route, id } = fixture(context)

  const listed = await invoke(route, { method: 'GET' })
  assert.equal(listed.status, 200)
  assert.equal((listed.json.entries as readonly unknown[]).length, 1, 'no id still lists the library')

  const read = await invoke(route, { method: 'GET', query: `?id=${encodeURIComponent(id)}` })
  assert.equal(read.status, 200)
  assert.equal(read.json.id, id)
  assert.equal(typeof read.json.updatedAt, 'number')
  const view = read.json.view as View
  assert.equal(view.name, '通用预设')
  assert.equal(view.promptCount, 2)
  assert.equal(view.enabledCount, 1)
  // The stored value is its own baseline, so nothing reads as a local edit.
  assert.equal(view.prompts.every(prompt => !prompt.contentModified), true)
})

test('edits run the same reducer the Session manager uses, and persist', async context => {
  const { route, library, id } = fixture(context)
  const before = await invoke(route, { method: 'GET', query: `?id=${encodeURIComponent(id)}` })
  const updatedAt = before.json.updatedAt as number

  const edited = await invoke(route, {
    method: 'PUT',
    body: {
      format: 0,
      id,
      expectedUpdatedAt: updatedAt,
      request: { operation: 'toggle', revision: 0, identifier: 'style', enabled: true },
    },
  })
  assert.equal(edited.status, 200)
  assert.equal((edited.json.view as View).enabledCount, 2)

  // The change is on disk, not only in the response.
  assert.deepEqual(library.get(id).preset.order.map(entry => ({ ...entry })), [
    { identifier: 'main', enabled: true },
    { identifier: 'style', enabled: true },
  ])
  assert.equal(library.get(id).enabledCount, 2)
})

test('refuses an edit built against a stale read', async context => {
  const { route, library, id } = fixture(context)
  const before = await invoke(route, { method: 'GET', query: `?id=${encodeURIComponent(id)}` })
  const stale = before.json.updatedAt as number

  await invoke(route, {
    method: 'PUT',
    body: { format: 0, id, expectedUpdatedAt: stale, request: { operation: 'toggle', revision: 0, identifier: 'style', enabled: true } },
  })
  // The library keeps no overlay, so a second editor working from the first
  // read would silently overwrite it without this check.
  const conflict = await invoke(route, {
    method: 'PUT',
    body: { format: 0, id, expectedUpdatedAt: stale, request: { operation: 'toggle', revision: 0, identifier: 'main', enabled: false } },
  })
  assert.equal(conflict.status, 400)
  assert.match(String(conflict.json.error), /已在别处改变/u)
  assert.equal(library.get(id).preset.order.find(entry => entry.identifier === 'main')?.enabled, true)
})

test('refuses a malformed edit and a cross-origin request', async context => {
  const { route, library, id } = fixture(context)
  const read = await invoke(route, { method: 'GET', query: `?id=${encodeURIComponent(id)}` })
  const updatedAt = read.json.updatedAt as number
  const good = { operation: 'toggle', revision: 0, identifier: 'style', enabled: true }

  for (const body of [
    { format: 1, id, expectedUpdatedAt: updatedAt, request: good },
    { format: 0, id: '', expectedUpdatedAt: updatedAt, request: good },
    { format: 0, id, request: good },
    { format: 0, id, expectedUpdatedAt: updatedAt, request: { operation: 'nope' } },
    { format: 0, id, expectedUpdatedAt: updatedAt, request: good, extra: 1 },
  ]) {
    assert.equal((await invoke(route, { method: 'PUT', body })).status, 400, JSON.stringify(body))
  }

  const foreign = await invoke(route, {
    method: 'PUT',
    body: { format: 0, id, expectedUpdatedAt: updatedAt, request: good },
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(library.get(id).enabledCount, 1, 'nothing was written')
})
