/** The route the transcript's edit-input control uses to redo the last turn. */

import assert from 'node:assert/strict'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentRpHttpServer } from '../src/host-http.ts'
import { protectedSystemHeadMessage } from '../src/import/protected-system-head.ts'
import { ROLEPLAY_TURN_REDO_PATH } from '../src/roleplay-turn-redo-protocol.ts'
import { installRoleplayTurnRedoHttp } from '../src/roleplay-turn-redo-http.ts'
import { roleplayModelHistory } from '../src/roleplay-surface-overlay.ts'
import { installIgnorableSessionEventFixture } from './session-event-fixture.ts'

installIgnorableSessionEventFixture()

type RegisteredRoute = Parameters<AgentRpHttpServer['register']>[0]

function fixture(options: { readonly status?: string } = {}): {
  readonly route: RegisteredRoute
  readonly session: Session
  readonly followups: UserMessage[]
} {
  const session = Session.create(SessionId('redo-http'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1, step: 1, message: protectedSystemHeadMessage(),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '开场白。' }], source: { provider: 'f', model: 'f' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '123' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 2, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '旧回复。' }], source: { provider: 'f', model: 'f' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  const followups: UserMessage[] = []
  const agent = {
    session,
    status: options.status ?? 'idle',
    followup(message: UserMessage) { followups.push(message) },
  } as unknown as Agent
  let route: RegisteredRoute | undefined
  const routeCtx = {
    effect(register: () => unknown) { register() },
    sessions: { flush: async () => true },
  } as unknown as Context
  const hostCtx = {
    get(name: string) {
      if (name === 'agents') return { get: (id: SessionId) => id === session.id ? agent : undefined }
      return undefined
    },
  } as unknown as Context
  const server: AgentRpHttpServer = { register(next) { route = next; return () => {} } }
  installRoleplayTurnRedoHttp(routeCtx, hostCtx, server)
  assert.ok(route)
  assert.equal(route.path, ROLEPLAY_TURN_REDO_PATH)
  return { route, session, followups }
}

async function invoke(route: RegisteredRoute, body: unknown, options: {
  readonly method?: string
  readonly headers?: IncomingHttpHeaders
} = {}): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const payload = body === undefined ? [] : [JSON.stringify(body)]
  const request = Object.assign(Readable.from(payload), {
    method: options.method ?? 'POST',
    url: ROLEPLAY_TURN_REDO_PATH,
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

const texts = (session: Session) => roleplayModelHistory(session)
  .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))

test('retires the last turn and re-sends the edited text', async () => {
  const { route, session, followups } = fixture()
  const result = await invoke(route, { format: 0, sessionId: String(session.id), text: '123456' })

  assert.equal(result.status, 200)
  assert.equal(result.json.turn, 2)
  assert.equal(result.json.retiredRows, 2)
  // The old turn is gone from the one list the UI and the request share, and
  // only the edited text goes back to the model.
  assert.deepEqual(texts(session), ['开场白。'])
  assert.deepEqual(followups.map(message => message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('')), ['123456'])
})

test('refuses while a reply is still running', async () => {
  const { route, session, followups } = fixture({ status: 'running' })
  const result = await invoke(route, { format: 0, sessionId: String(session.id), text: '123456' })

  assert.equal(result.status, 400)
  assert.match(String(result.json.error), /等待当前回复/u)
  assert.deepEqual(texts(session), ['开场白。', '123', '旧回复。'], 'nothing was retired')
  assert.deepEqual(followups, [])
})

test('refuses an unknown Session and a turn with no player input', async () => {
  const { route, session } = fixture()
  const unknown = await invoke(route, { format: 0, sessionId: 'not-open', text: '123456' })
  assert.equal(unknown.status, 400)
  assert.match(String(unknown.json.error), /会话当前不可用/u)

  // Redo the one redoable turn, leaving an opening with no player message.
  await invoke(route, { format: 0, sessionId: String(session.id), text: '123456' })
  const again = await invoke(route, { format: 0, sessionId: String(session.id), text: '789' })
  assert.equal(again.status, 400)
  assert.match(String(again.json.error), /没有可改写的玩家输入/u)
})

test('refuses a malformed body, a wrong method and a cross-origin request', async () => {
  const { route, session, followups } = fixture()
  const body = { format: 0, sessionId: String(session.id), text: '123456' }

  for (const invalid of [
    { ...body, format: 1 },
    { ...body, sessionId: '' },
    { ...body, text: '   ' },
    { format: 0, sessionId: String(session.id) },
    { ...body, extra: true },
  ]) {
    assert.equal((await invoke(route, invalid)).status, 400, JSON.stringify(invalid))
  }
  assert.equal((await invoke(route, body, { method: 'GET' })).status, 405)
  assert.equal((await invoke(route, body, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)

  assert.deepEqual(texts(session), ['开场白。', '123', '旧回复。'], 'nothing was retired')
  assert.deepEqual(followups, [])
})
