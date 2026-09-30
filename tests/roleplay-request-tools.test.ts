import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { decideRoleplayRequestTools } from '../src/roleplay-request-tools.ts'
import {
  DEFAULT_TOOL_GUIDANCE,
  prepareRoleplayToolPolicy,
  type ResolvedToolGuidanceConfig,
} from '../src/roleplay-tool-guidance.ts'

/** The tools a character-mode roleplay request carried in a real 2026-09-23 Session log. */
const ROLEPLAY_TOOLS = [
  'generate_roleplay_image', 'import_character_card', 'import_sillytavern_preset', 'import_world_info',
  'inspect_actor', 'publish_roleplay_image', 'revise_actor', 'stage_roleplay_artifact', 'web_search',
]

function policy(overrides: Partial<ResolvedToolGuidanceConfig> = {}) {
  return prepareRoleplayToolPolicy({ ...DEFAULT_TOOL_GUIDANCE, imageMode: 'requested', ...overrides })
}

function player(text: string, extra: Message['content'] = []): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, ...extra] })
}

function reply(text: string): Message {
  return createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'reasoning', text: '上一轮的草稿' }, { type: 'text', text }],
  })
}

function decide(messages: readonly Message[], toolNames = ROLEPLAY_TOOLS, overrides: Partial<ResolvedToolGuidanceConfig> = {}) {
  return decideRoleplayRequestTools({ toolNames, messages, policy: policy(overrides) })
}

test('leaves the tool schemas off an ordinary roleplay turn', () => {
  const decision = decide([player('你知道他去哪了吗？'), reply('……自己去问他。'), player('我们走吧')])
  assert.deepEqual(decision, { send: false, reasons: [] })
})

test('keeps the schemas for every turn when the player chose always', () => {
  assert.deepEqual(decide([player('我们走吧')], ROLEPLAY_TOOLS, { requestTools: 'always' }), {
    send: true, reasons: ['always'],
  })
})

test('reads intent only from the latest player line', () => {
  assert.deepEqual(decide([player('帮我查一下今天的新闻')]).reasons, ['search'])
  assert.deepEqual(decide([player('帮我画一张她的插图')]).reasons, ['image'])
  assert.deepEqual(decide([player('把角色设定里的年龄改成二十')]).reasons, ['actor'])
  // An earlier request does not keep a later ordinary turn tool-bearing.
  assert.deepEqual(decide([player('帮我搜索一下'), reply('好。'), player('我们走吧')]).reasons, [])
})

test('keeps the schemas when the player attached a file for an import tool', () => {
  // Only the block type matters here; the attachment reference is opaque to the decision.
  const file = { type: 'file', attachment: { attachmentId: AttachmentId('sha256:card') } } as unknown as Message['content'][number]
  assert.deepEqual(decide([player('导入这张卡', [file])]).reasons, ['attachment'])
})

test('treats an offered remember tool as the player having asked', () => {
  assert.deepEqual(decide([player('记住我喜欢猫')], [...ROLEPLAY_TOOLS, 'remember']).reasons, ['memory'])
})

test('image policy decides whether an image-capable turn needs the schemas', () => {
  assert.deepEqual(decide([player('我们走吧')], ROLEPLAY_TOOLS, { imageMode: 'auto' }).reasons, ['image'])
  assert.deepEqual(decide([player('我们走吧')], ROLEPLAY_TOOLS, { imageMode: 'always' }).reasons, ['image'])
  assert.deepEqual(decide([player('我们走吧')], ROLEPLAY_TOOLS, { imageMode: 'requested' }).reasons, [])
})

test('keeps the schemas for the rest of a turn that already called a tool', () => {
  const callId = ToolCallId('call-search')
  const messages = [
    player('查查天气'),
    createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' },
      content: [
        { type: 'reasoning', text: '先查天气' },
        { type: 'tool-call', id: callId, name: 'web_search', arguments: '{}' },
      ],
    }),
    createToolResultMessage({ callId, content: [{ type: 'text', text: '多云' }], isError: false }),
  ]
  assert.deepEqual(decide(messages, ['inspect_actor']).reasons, ['turn-in-progress'])
})

test('never drops a tool it cannot judge', () => {
  assert.deepEqual(decide([player('我们走吧')], [...ROLEPLAY_TOOLS, 'comfyui_generate']).reasons, ['unrecognized-tool'])
})

test('a request that offers no tools has nothing to decide', () => {
  assert.deepEqual(decide([player('帮我搜索')], []), { send: false, reasons: [] })
})
