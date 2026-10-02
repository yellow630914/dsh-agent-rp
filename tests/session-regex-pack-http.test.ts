/** The route the regex manager uses to take one library pack into a Session. */

import assert from 'node:assert/strict'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentRpHttpServer } from '../src/host-http.ts'
import { RegexPackLibrary } from '../src/regex-pack-library.ts'
import { installSessionRegexPackHttp } from '../src/session-regex-pack-http.ts'
import { SESSION_REGEX_PACK_PATH } from '../src/session-regex-pack-protocol.ts'
import { readSessionRegexPacks } from '../src/session-regex-pack.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

type RegisteredRoute = Parameters<AgentRpHttpServer['register']>[0]

const packFile = JSON.stringify([{
  scriptName: '钟楼着色',
  findRegex: '/钟楼/g',
  replaceString: '<b>钟楼</b>',
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
}])

function fixture(context: { after: (fn: () => void) => void }): {
  readonly route: RegisteredRoute
  readonly agent: Agent
  readonly packId: string
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-rp-session-regex-pack-'))
  context.after(() => { rmSync(root, { force: true, recursive: true }) })
  writeFileSync(join(root, 'ignored.txt'), '', 'utf8')
  const library = new RegexPackLibrary({ root })
  const entry = library.importFile({ data: new TextEncoder().encode(packFile), filename: '文风.json' })

  const agent = { session: Session.create(SessionId('regex-pack-http')) } as Agent
  let route: RegisteredRoute | undefined
  const routeCtx = {
    effect(register: () => unknown) { register() },
    sessions: { flush: async () => true },
  } as unknown as Context
  const hostCtx = {
    get(name: string) {
      if (name === 'agents') return { get: (id: SessionId) => id === agent.session.id ? agent : undefined }
      return undefined
    },
  } as unknown as Context
  const server: AgentRpHttpServer = { register(next) { route = next; return () => {} } }
  installSessionRegexPackHttp(routeCtx, hostCtx, server, library)
  assert.ok(route)
  assert.equal(route.path, SESSION_REGEX_PACK_PATH)
  return { route, agent, packId: entry.id }
}

async function invoke(route: RegisteredRoute, body: unknown, options: {
  readonly method?: string
  readonly headers?: IncomingHttpHeaders
} = {}): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const payload = body === undefined ? [] : [JSON.stringify(body)]
  const request = Object.assign(Readable.from(payload), {
    method: options.method ?? 'POST',
    url: SESSION_REGEX_PACK_PATH,
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

test('takes one library pack into the open Session', async context => {
  const { route, agent, packId } = fixture(context)
  const result = await invoke(route, { format: 0, sessionId: String(agent.session.id), packId })

  assert.equal(result.status, 200)
  assert.equal(result.json.id, packId)
  assert.equal(result.json.name, '文风')
  assert.equal(result.json.scriptCount, 1)
  assert.deepEqual(readSessionRegexPacks(agent.session.snapshotEvents()).map(entry => entry.id), [packId])
})

test('refuses the same pack twice, and an unknown Session or pack', async context => {
  const { route, agent, packId } = fixture(context)
  await invoke(route, { format: 0, sessionId: String(agent.session.id), packId })

  const again = await invoke(route, { format: 0, sessionId: String(agent.session.id), packId })
  assert.equal(again.status, 400)
  assert.match(String(again.json.error), /已经在本会话里了/u)
  assert.equal(readSessionRegexPacks(agent.session.snapshotEvents()).length, 1)

  const noSession = await invoke(route, { format: 0, sessionId: 'not-open', packId })
  assert.equal(noSession.status, 400)
  assert.match(String(noSession.json.error), /会话当前不可用/u)

  const noPack = await invoke(route, {
    format: 0, sessionId: String(agent.session.id), packId: `regex-${'0'.repeat(32)}`,
  })
  assert.equal(noPack.status, 400)
})

test('refuses a cross-origin request and a wrong method', async context => {
  const { route, agent, packId } = fixture(context)
  const body = { format: 0, sessionId: String(agent.session.id), packId }

  const foreign = await invoke(route, body, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(foreign.status, 403)

  const read = await invoke(route, body, { method: 'GET' })
  assert.equal(read.status, 405)
  assert.deepEqual(readSessionRegexPacks(agent.session.snapshotEvents()), [])
})

test('refuses a malformed body rather than writing a partial decision', async context => {
  const { route, agent, packId } = fixture(context)
  for (const body of [
    { format: 1, sessionId: String(agent.session.id), packId },
    { format: 0, sessionId: '', packId },
    { format: 0, sessionId: String(agent.session.id) },
    { format: 0, sessionId: String(agent.session.id), packId, extra: true },
  ]) {
    const result = await invoke(route, body)
    assert.equal(result.status, 400, JSON.stringify(body))
  }
  assert.deepEqual(readSessionRegexPacks(agent.session.snapshotEvents()), [])
})
