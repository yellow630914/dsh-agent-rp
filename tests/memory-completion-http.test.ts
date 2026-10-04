import assert from 'node:assert/strict'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { AgentRpHttpServer } from '../src/host-http.ts'
import { installAgentRpMemoryCompletionHttp } from '../src/memory-completion-http.ts'
import { AGENT_RP_MEMORY_COMPLETION_PATH } from '../src/memory-completion-protocol.ts'
import { agentRpPresetGateway } from './agent-preset-fixture.ts'
import { resolveModelInfoDouble } from './model-reasoning-double.ts'

type RegisteredRoute = Parameters<AgentRpHttpServer['register']>[0]

function roleplayAgent(id: string, status: Agent['status'] = 'idle'): Agent {
  const sessionId = SessionId(id)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, isSeeded: false, id: sessionId, createdAt: 1_800_000_000_000, agentPreset: 'agent-rp',
  }
  const session = Session.create(sessionId, [], header)
  for (const [index, [user, assistant]] of [['先去港口。', '好。'], ['改去钟楼。', '那就转向钟楼。']].entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: user as string }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: assistant as string }], source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { session, status, inbox: { nextTurn: [], nextStep: [] } } as unknown as Agent
}

function routeFor(agent: Agent | undefined, seen: { request?: Record<string, unknown> } = {}): RegisteredRoute {
  let route: RegisteredRoute | undefined
  const routeCtx = {
    effect(register: () => unknown) { register() },
    llm: {
      resolveModelInfo: resolveModelInfoDouble(),
      stream(options: Record<string, unknown>) {
        seen.request = options
        const text = '{"entries":[{"title":"第1天 上午 ~ 第1天 夜晚","events":[{"time":"上午","text":"两人去过港口。"}]}]}'
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  } as unknown as Context
  const hostCtx = {
    get(name: string) {
      if (name === 'agents') return { get: (id: SessionId) => id === agent?.session.id ? agent : undefined }
      if (name === 'agentPresets') return agentRpPresetGateway(agent === undefined ? {} : { active: agent })
      if (name === 'sessionController') {
        return { modelCatalog: async () => ({ default: { provider: 'fallback', model: 'fallback-model' } }) }
      }
      return undefined
    },
  } as unknown as Context
  const server: AgentRpHttpServer = { register(next) { route = next; return () => {} } }
  installAgentRpMemoryCompletionHttp(routeCtx, hostCtx, server)
  assert.ok(route)
  assert.equal(route.path, AGENT_RP_MEMORY_COMPLETION_PATH)
  return route
}

async function invoke(route: RegisteredRoute, body: unknown, options: {
  readonly method?: string
  readonly headers?: IncomingHttpHeaders
} = {}): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = Object.assign(Readable.from(payload), {
    method: options.method ?? 'POST',
    url: AGENT_RP_MEMORY_COMPLETION_PATH,
    headers: {
      host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'sec-fetch-site': 'same-origin',
      ...options.headers,
    } satisfies IncomingHttpHeaders,
  }) as unknown as IncomingMessage
  let status = 0
  let text = ''
  const response = {
    writableEnded: false,
    destroyed: false,
    once() { return response },
    setHeader() { return response },
    writeHead(value: number) { status = value; return response },
    end(value?: string | Uint8Array) {
      if (value !== undefined) text = Buffer.from(value).toString('utf8')
      response.writableEnded = true
      return response
    },
  }
  await route.handler(request, response as unknown as ServerResponse)
  return { status, json: JSON.parse(text) as Record<string, unknown> }
}

test('proposes memory for the whole transcript on the Session route', async () => {
  const agent = roleplayAgent('memory-completion-http')
  agent.session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'fixture', model: 'session-model', maxTokens: 512, stop: ['\n'] } },
  })
  const seen: { request?: Record<string, unknown> } = {}
  const before = agent.session.snapshotEvents().length

  const result = await invoke(routeFor(agent, seen), {
    format: 0, sessionId: 'memory-completion-http', instruction: ' 约定要记 ',
  })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, {
    format: 0,
    entries: [{ kind: 'event', subject: '【第1天 上午 ~ 第1天 夜晚】', text: '[上午] 两人去过港口。' }],
    floorCount: 4,
    activeCount: 0,
    rejectedCount: 0,
    provider: 'fixture',
    model: 'session-model',
  })
  // The model the player is playing with, but none of its prose settings.
  assert.equal(seen.request?.model, 'session-model')
  assert.equal(seen.request?.stop, undefined)
  assert.notEqual(seen.request?.maxTokens, 512)
  assert.match(JSON.stringify(seen.request?.messages), /约定要记/u)
  assert.equal(agent.session.snapshotEvents().length, before)
})

test('falls back to the deployment default for a Session that has not sent a request yet', async () => {
  const seen: { request?: Record<string, unknown> } = {}
  const result = await invoke(routeFor(roleplayAgent('memory-completion-fresh'), seen), {
    format: 0, sessionId: 'memory-completion-fresh',
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.provider, 'fallback')
  assert.equal(seen.request?.model, 'fallback-model')
})

test('refuses requests it cannot or should not run', async () => {
  const idle = roleplayAgent('memory-completion-guard')
  const route = routeFor(idle)
  const valid = { format: 0, sessionId: 'memory-completion-guard' }

  assert.equal((await invoke(route, valid, { method: 'GET' })).status, 405)
  assert.equal((await invoke(route, valid, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  // The branch point is not part of the request: memory is brought up to the
  // latest floor wherever the branch will cut.
  assert.match(String((await invoke(route, { ...valid, fromFloor: 2 })).json.error), /记忆补全请求无效/u)
  assert.match(String((await invoke(route, { ...valid, sessionId: 'someone-else' })).json.error), /当前不可用/u)
  assert.match(String((await invoke(route, { ...valid, instruction: 7 })).json.error), /补全要求无效/u)

  // A reply still streaming would be read as a finished floor.
  const busy = roleplayAgent('memory-completion-busy', 'running' as Agent['status'])
  const refused = await invoke(routeFor(busy), { format: 0, sessionId: 'memory-completion-busy' })
  assert.equal(refused.status, 400)
  assert.match(String(refused.json.error), /等待当前回复完成/u)
})
