import assert from 'node:assert/strict'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRpHttpServer } from '../src/host-http.ts'
import { WorldInfoLibrary } from '../src/world-info-library.ts'
import { installWorldInfoLibraryHttp } from '../src/world-info-library-http.ts'
import { WORLD_INFO_LIBRARY_PATH } from '../src/world-info-library-protocol.ts'
import type { WorldInfoEditableEntry } from '../src/world-info-configuration-types.ts'

type RegisteredRoute = Parameters<AgentRpHttpServer['register']>[0]

const headers = {
  host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'sec-fetch-site': 'same-origin',
} satisfies IncomingHttpHeaders

/**
 * A book carrying one field this runtime does not model (`probability`) and one
 * unknown extension, so a save that dropped either would fail loudly here.
 */
const source = Buffer.from(JSON.stringify({
  name: '海城',
  entries: {
    7: {
      uid: 7,
      key: ['旧钟楼'],
      keysecondary: [],
      content: '旧钟楼每天午夜停摆一分钟。',
      comment: '钟楼',
      probability: 75,
      extensions: { custom_flag: 'keep-me' },
      constant: false,
      selective: false,
      order: 10,
      position: 0,
      disable: false,
    },
    9: {
      uid: 9,
      key: ['盐雾'],
      keysecondary: [],
      content: '入夜后港口起盐雾。',
      constant: false,
      selective: false,
      order: 20,
      position: 0,
      disable: false,
    },
  },
}), 'utf8')

function routeFor(library: WorldInfoLibrary): RegisteredRoute {
  let route: RegisteredRoute | undefined
  const ctx = { effect(register: () => unknown) { register() } } as unknown as Context
  installWorldInfoLibraryHttp(ctx, library, { register(next) { route = next; return () => {} } })
  assert.ok(route)
  return route
}

async function call(
  route: RegisteredRoute,
  method: string,
  url: string,
  body?: unknown,
): Promise<{
  readonly status: number
  readonly json: Record<string, unknown>
  readonly headers: Record<string, string>
}> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = Object.assign(Readable.from(payload), { method, headers, url }) as unknown as IncomingMessage
  let status: number | undefined
  let received = Buffer.alloc(0)
  const sent: Record<string, string> = {}
  const response = {
    setHeader(name: string, value: string) { sent[name] = value; return response },
    writeHead(value: number) { status = value; return response },
    end(value?: string | Uint8Array) { if (value !== undefined) received = Buffer.from(value); return response },
  } as unknown as ServerResponse
  await route.handler(request, response)
  assert.notEqual(status, undefined)
  return { status: status!, json: JSON.parse(received.toString('utf8')) as Record<string, unknown>, headers: sent }
}

function library(context: { after(fn: () => void): void }): WorldInfoLibrary {
  const root = mkdtempSync(join(tmpdir(), 'agent-rp-world-info-editor-'))
  context.after(() => { rmSync(root, { recursive: true, force: true }) })
  return new WorldInfoLibrary({ root })
}

test('the resource center loads one stored book as editable entries', async context => {
  const store = library(context)
  const { id } = store.importFile({ data: source, filename: '海城.json' })
  const route = routeFor(store)

  const listed = await call(route, 'GET', WORLD_INFO_LIBRARY_PATH)
  assert.equal(listed.status, 200)
  assert.equal((listed.json.entries as readonly unknown[]).length, 1, 'no id still lists the library')

  const detail = await call(route, 'GET', `${WORLD_INFO_LIBRARY_PATH}?id=${encodeURIComponent(id)}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.name, '海城')
  const entries = detail.json.entries as readonly WorldInfoEditableEntry[]
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.content, '旧钟楼每天午夜停摆一分钟。')
  assert.deepEqual(entries[0]?.keys, ['旧钟楼'])
  assert.equal(entries[1]?.content, '入夜后港口起盐雾。')

  const missing = await call(route, 'GET', `${WORLD_INFO_LIBRARY_PATH}?id=world-info-${'0'.repeat(32)}`)
  assert.equal(missing.status, 400)
})

test('saving an edit rewrites, adds and deletes entries without dropping unmodeled fields', async context => {
  const store = library(context)
  const original = store.importFile({ data: source, filename: '海城.json' })
  const route = routeFor(store)
  const loaded = await call(route, 'GET', `${WORLD_INFO_LIBRARY_PATH}?id=${encodeURIComponent(original.id)}`)
  const entries = loaded.json.entries as readonly WorldInfoEditableEntry[]

  // Keep entry 0 with new text, drop entry 1, append a brand-new entry.
  const saved = await call(route, 'PUT', WORLD_INFO_LIBRARY_PATH, {
    format: 0,
    id: original.id,
    entries: [
      { sourceIndex: 0, entry: { ...entries[0]!, content: '旧钟楼午夜停摆三分钟。' } },
      { entry: { ...entries[0]!, keys: ['灯塔'], comment: '灯塔', content: '灯塔守夜人不认生人。' } },
    ],
  })
  assert.equal(saved.status, 200)
  const upload = saved.json.upload as { readonly id: string; readonly name: string; readonly entryCount: number }
  assert.notEqual(upload.id, original.id, 'content-addressed id follows the content')
  assert.equal(upload.name, '海城', 'the display name survives the edit')
  assert.equal(upload.entryCount, 2)

  const asset = store.asset(upload.id)
  assert.equal(asset.worldInfo.name, '海城')
  assert.deepEqual(asset.worldInfo.lorebook.entries.map(entry => entry.content), [
    '旧钟楼午夜停摆三分钟。',
    '灯塔守夜人不认生人。',
  ])
  const raw = asset.worldInfo.raw as unknown as { readonly entries: readonly Record<string, unknown>[] }
  assert.equal(raw.entries[0]?.probability, 75, 'a field this runtime does not model survives the round trip')
  assert.deepEqual(raw.entries[0]?.extensions, { custom_flag: 'keep-me' })
  assert.equal(raw.entries[0]?.uid, 7, 'a kept entry keeps its own uid')
  assert.equal(raw.entries[1]?.uid, 10, 'an added entry continues the book\'s uid sequence')
  assert.equal(raw.entries[1]?.probability, undefined, 'an added entry does not inherit the source entry raw')

  assert.equal(store.list().length, 1, 'the edited book replaces the one it came from')
  assert.throws(() => store.asset(original.id), /世界书|not found|ENOENT/u)
})

test('saving an unchanged book again does not churn its identity', async context => {
  const store = library(context)
  const original = store.importFile({ data: source, filename: '海城.json' })
  const route = routeFor(store)

  // The first save also normalizes the stored bytes, so identity is only stable
  // from the second save on — that is the case the editor actually produces
  // when someone opens a book, changes their mind and saves anyway.
  const load = async (id: string): Promise<readonly WorldInfoEditableEntry[]> => {
    const loaded = await call(route, 'GET', `${WORLD_INFO_LIBRARY_PATH}?id=${encodeURIComponent(id)}`)
    assert.equal(loaded.status, 200)
    return loaded.json.entries as readonly WorldInfoEditableEntry[]
  }
  const save = async (id: string, entries: readonly WorldInfoEditableEntry[]): Promise<string> => {
    const saved = await call(route, 'PUT', WORLD_INFO_LIBRARY_PATH, {
      format: 0,
      id,
      entries: entries.map((entry, sourceIndex) => ({ sourceIndex, entry })),
    })
    assert.equal(saved.status, 200)
    return (saved.json.upload as { readonly id: string }).id
  }

  const normalized = await save(original.id, await load(original.id))
  const again = await save(normalized, await load(normalized))
  assert.equal(again, normalized, 'a save with nothing changed keeps the same id')
  assert.equal(store.list().length, 1)
})

test('a malformed edit is refused and leaves the stored book alone', async context => {
  const store = library(context)
  const original = store.importFile({ data: source, filename: '海城.json' })
  const route = routeFor(store)
  const loaded = await call(route, 'GET', `${WORLD_INFO_LIBRARY_PATH}?id=${encodeURIComponent(original.id)}`)
  const entries = loaded.json.entries as readonly WorldInfoEditableEntry[]

  for (const body of [
    { format: 0, id: original.id, entries: [{ sourceIndex: 9, entry: entries[0]! }] },
    { format: 0, id: original.id, entries: [{ sourceIndex: -1, entry: entries[0]! }] },
    { format: 0, id: original.id, entries: [{ entry: { ...entries[0]!, insertionOrder: 'soon' } }] },
    { format: 1, id: original.id, entries: [] },
  ]) {
    const refused = await call(route, 'PUT', WORLD_INFO_LIBRARY_PATH, body)
    assert.equal(refused.status, 400, JSON.stringify(body))
    assert.equal(typeof refused.json.error, 'string')
  }

  assert.equal(store.asset(original.id).worldInfo.lorebook.entries.length, 2, 'nothing was written')

  const rejected = await call(route, 'OPTIONS', WORLD_INFO_LIBRARY_PATH)
  assert.equal(rejected.status, 405)
  assert.match(rejected.headers.allow ?? '', /PUT/u)
})
