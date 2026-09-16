import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ImportedSillyTavernPreset } from '../src/import/sillytavern-preset.ts'
import type { ImportedCharacterCard } from '../src/import/types.ts'
import {
  assembleSillyTavernPreset,
  prepareAttributedProviderMessages,
  prepareSillyTavernProviderMessages,
  type RoleplayProviderPromptPlan,
} from '../src/preset-prompt.ts'
import { worldInfoOrigin } from '../src/prompt-origin.ts'
import {
  capturePromptPreview,
  forgetPromptPreview,
  promptPreviewBody,
  promptPreviewSummary,
} from '../src/prompt-preview.ts'

const card: ImportedCharacterCard = {
  format: 0,
  version: 2,
  specVersion: '2.0',
  name: '白露',
  description: '{{char}}在修表。',
  personality: '安静但敏锐。',
  scenario: '{{user}}推门进来。',
  firstMessage: '门还没锁。',
  messageExample: '',
  alternateGreetings: [],
  systemPrompt: '',
  postHistoryInstructions: '',
  frontend: { regexScripts: [], tavernHelperScriptNames: [], tavernHelperScripts: [], tavernHelperVariables: {} },
  degradations: [],
  raw: {},
}

const history = [
  createUserMessage({ content: [{ type: 'text', text: '表为什么停了？' }], source: { kind: 'user' } }),
  createAssistantMessage({
    content: [{ type: 'text', text: '游丝断了。' }],
    source: { provider: 'test', model: 'test' },
  }),
]

function worldPreset(): ImportedSillyTavernPreset {
  const prompts: ImportedSillyTavernPreset['prompts'] = [
    { identifier: 'worldInfoBefore', name: '世界书前', role: 'system', content: '', marker: true, systemPrompt: true, forbidOverrides: false },
    { identifier: 'chatHistory', name: '历史', role: 'system', content: '', marker: true, systemPrompt: true, forbidOverrides: false },
    { identifier: 'jailbreak', name: '越狱', role: 'system', content: '保持角色。', marker: false, systemPrompt: true, forbidOverrides: false },
  ]
  return {
    format: 0,
    name: '预设',
    prompts,
    order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })),
    generation: {},
    formats: { worldInfo: '{0}', scenario: '{{scenario}}', personality: '{{personality}}' },
    regexScripts: [],
    extensionSummary: { regexScriptCount: 0, hasSPreset: false, hasTavernHelper: false },
  }
}

const entries = [
  { bookName: '海城设定', entryId: 'e1', entryName: '气候', matchedKeys: ['雾'], constant: false },
  { bookName: '海城设定', entryId: 'e2', entryName: '钟表行', matchedKeys: [], constant: true },
  { bookName: '人物志', entryId: 'e3', entryName: '白露', matchedKeys: ['白露'], constant: false },
]

test('the previewed order is the order that was sent', () => {
  // The preview exists to be trusted, so the attributed assembly and the one the
  // provider seam calls must be the same assembly, not two that agree today.
  const assembled = assembleSillyTavernPreset(worldPreset(), {
    card,
    worldInfoBefore: ['多雾。', '钟表行在西街。', '白露守着铺子。'],
    worldInfoAfter: [],
    worldInfoBeforeOrigins: entries.map(worldInfoOrigin),
    session: Session.create(SessionId('preview-order')),
  })
  const plan: RoleplayProviderPromptPlan = {
    beforeHistory: assembled.beforeHistory,
    afterHistory: assembled.afterHistory,
    inChat: [
      { role: 'system', content: '深度提示甲', depth: 1, order: 100, origin: { kind: 'preset', label: '甲' } },
      { role: 'system', content: '深度提示乙', depth: 1, order: 100, origin: { kind: 'preset', label: '乙' } },
    ],
    includeHistory: assembled.includeHistory,
  }

  // Module messages are minted per call, so their ids differ between two runs;
  // everything that reaches the provider must not.
  const sent = ({ id: _id, ...rest }: { readonly id: unknown }): unknown => rest
  assert.deepEqual(
    prepareAttributedProviderMessages(history, plan).map(item => sent(item.message)),
    prepareSillyTavernProviderMessages(history, plan).map(sent),
  )
})

test('one row per World Info entry, named and with the key that activated it', () => {
  const assembled = assembleSillyTavernPreset(worldPreset(), {
    card,
    worldInfoBefore: ['多雾。', '钟表行在西街。', '白露守着铺子。'],
    worldInfoAfter: [],
    worldInfoBeforeOrigins: entries.map(worldInfoOrigin),
    session: Session.create(SessionId('preview-world')),
  })
  const plan: RoleplayProviderPromptPlan = {
    beforeHistory: assembled.beforeHistory,
    afterHistory: assembled.afterHistory,
    inChat: [],
    includeHistory: assembled.includeHistory,
  }

  capturePromptPreview({
    sessionId: 'world',
    messages: prepareAttributedProviderMessages(history, plan),
    system: '你是白露。',
  })
  const summary = promptPreviewSummary('world')!
  const worldRow = summary.messages.find(message => message.label === '世界书前')!

  // The marker is one module to the provider and three entries to a reader.
  assert.equal(worldRow.parts?.length, 3)
  assert.deepEqual(worldRow.parts?.map(part => [part.kind, part.label]), [
    ['world-info', '气候'], ['world-info', '钟表行'], ['world-info', '白露'],
  ])
  assert.deepEqual(worldRow.parts?.map(part => part.detail), [
    '海城设定 · 关键词 雾', '海城设定 · 常驻', '人物志 · 关键词 白露',
  ])
  assert.deepEqual(worldRow.parts?.map(part => part.snippet), ['多雾。', '钟表行在西街。', '白露守着铺子。'])

  // Opening the row yields each entry's own body, not just the merged block.
  const body = promptPreviewBody('world', worldRow.index)!
  assert.deepEqual(body.parts, ['多雾。', '钟表行在西街。', '白露守着铺子。'])
  assert.equal(body.text.includes('多雾。'), true)
  forgetPromptPreview('world')
})

test('one row per chat message, with tool results told apart from player lines', () => {
  const call = createAssistantMessage({
    content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'lookup', arguments: '{"q":"雾"}' }],
    source: { provider: 'test', model: 'test' },
  })
  const result = createToolResultMessage({
    callId: ToolCallId('c1'),
    content: [{ type: 'text', text: '海城年均雾日 120 天。' }],
    isError: false,
  })
  capturePromptPreview({
    sessionId: 'chat',
    messages: prepareAttributedProviderMessages([...history, call, result], {
      beforeHistory: [], afterHistory: [], inChat: [], includeHistory: true,
    }),
  })
  const summary = promptPreviewSummary('chat')!

  assert.deepEqual(summary.messages.map(message => message.label),
    ['玩家消息', '角色消息', '角色消息', '工具结果'])
  assert.equal(summary.messages.every(message => message.kind === 'history'), true)
  assert.equal(summary.messages[2]?.detail, '工具调用 lookup')
  // A tool result nests its text, so a preview that only read text blocks would
  // report the row as empty — which is exactly the row a long turn is made of.
  assert.equal(summary.messages[3]?.snippet, '海城年均雾日 120 天。')
  forgetPromptPreview('chat')
})

test('merged in-chat modules split back into the modules that were joined', () => {
  capturePromptPreview({
    sessionId: 'merged',
    messages: prepareAttributedProviderMessages(history, {
      beforeHistory: [],
      afterHistory: [],
      inChat: [
        { role: 'system', content: '甲提示', depth: 1, order: 100, origin: { kind: 'preset', label: '甲' } },
        { role: 'system', content: '乙提示', depth: 1, order: 100, origin: { kind: 'tavern-helper', label: '乙' } },
      ],
      includeHistory: true,
    }),
  })
  const summary = promptPreviewSummary('merged')!
  const merged = summary.messages.find(message => message.parts !== undefined)!

  assert.equal(merged.label, '合并注入')
  assert.deepEqual(merged.parts?.map(part => [part.kind, part.label, part.snippet]), [
    ['preset', '甲', '甲提示'],
    ['tavern-helper', '乙', '乙提示'],
  ])
  forgetPromptPreview('merged')
})

test('the system field is readable on its own and counted in the total', () => {
  capturePromptPreview({
    sessionId: 'sys',
    messages: prepareAttributedProviderMessages(history, {
      beforeHistory: [], afterHistory: [], inChat: [], includeHistory: true,
    }),
    system: '你是白露。',
    model: 'test-model',
  })
  const summary = promptPreviewSummary('sys')!

  assert.equal(summary.system.snippet, '你是白露。')
  assert.equal(summary.model, 'test-model')
  assert.equal(summary.totals.messages, 2)
  assert.equal(
    summary.totals.approximateTokens > summary.messages.reduce((sum, m) => sum + m.approximateTokens, 0),
    true,
    'the provider system field is part of what the request costs',
  )
  assert.equal(promptPreviewBody('sys', -1)?.text, '你是白露。')
  forgetPromptPreview('sys')
})

test('a Session with no dispatched request reads as absent, not as empty', () => {
  assert.equal(promptPreviewSummary('never-sent'), undefined)
  assert.equal(promptPreviewBody('never-sent', 0), undefined)
})
