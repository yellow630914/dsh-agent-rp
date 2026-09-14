import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CharacterCardAttachmentRef, FileAttachmentRef } from '../src/import/session-character.ts'
import { readActiveSessionCharacter } from '../src/import/session-character.ts'
import { isAgentRpCapabilityComposition } from '../src/agent-capability-preset.ts'
import { resolveConfig } from '../src/config.ts'
import {
  installAgentRp,
  isCharacterCardSessionOffer,
  parseCharacterCardSessionRequest,
  isSillyTavernChatOffer,
  isSillyTavernPresetOffer,
} from '../src/index.ts'
import { parseSillyTavernPresetJson } from '../src/import/sillytavern-preset.ts'
import { createPresetSessionSeed, readActiveSessionPreset } from '../src/import/session-preset.ts'
import { installBundledAgentRpPreset } from '../src/preset.ts'

const SOURCE = resolve('preset')

test('profile bundle keeps its managed Agent preset discoverable', () => {
  const patch = readFileSync('cordis.patch.yml', 'utf8')
  assert.match(patch, /- id: agent-presets\s+config:\s+[^]*?default: standard\s+includeUserRoot: true/u)
})

test('roleplay preset exposes search without inheriting coding authority', () => {
  const composition = readFileSync('preset/agent.cordis.yml', 'utf8')
  assert.match(composition, /name: cordis:group\s+isolate:\s+agentRp\.actorRevisions: true/u)
  assert.match(composition, /name: '@deepseek-ai\/dsh-tool-web'/u)
  assert.doesNotMatch(composition, /dsh-tool-(?:bash|fs|skill|subagent)/u)
  assert.match(readFileSync('preset/preset.yml', 'utf8'), /受控联网搜索/u)
})

test('discovers the managed Agent preset with Windows line endings', () => {
  const composition = readFileSync('preset/agent.cordis.yml', 'utf8')
  assert.equal(isAgentRpCapabilityComposition(composition.replaceAll('\n', '\r\n')), true)
})

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-agent-rp-preset-'))
}

test('installs one idempotent managed preset', (context) => {
  const root = temporaryRoot()
  context.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }), 'created')
  assert.equal(installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }), 'unchanged')
  assert.match(readFileSync(join(root, 'agent-rp', 'agent.cordis.yml'), 'utf8'), /mode: character/u)
  assert.match(readFileSync(join(root, 'agent-rp', 'preset.yml'), 'utf8'), /角色会话/u)
})

test('migrates the managed preset owner without replacing local content', (context) => {
  const root = temporaryRoot()
  context.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }), 'created')
  const manifestPath = join(root, 'agent-rp', '.dsh-agent-rp-owner.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    owner: '@dsh-external/dsh-agent-rp',
  }, null, 2)}\n`, 'utf8')

  assert.equal(installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }), 'updated')
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).owner, '@hewzhew/dsh-agent-rp')
})

test('refuses to replace a locally edited managed preset', (context) => {
  const root = temporaryRoot()
  context.after(() => rmSync(root, { recursive: true, force: true }))
  installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE })
  writeFileSync(join(root, 'agent-rp', 'preset.yml'), 'name: 我的角色\n', 'utf8')

  assert.throws(
    () => installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }),
    /edited locally/u,
  )
})

test('refuses to claim an existing user preset with the reserved id', (context) => {
  const root = temporaryRoot()
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'agent-rp')
  mkdirSync(target)
  writeFileSync(join(target, 'agent.cordis.yml'), '[]\n', 'utf8')
  assert.throws(
    () => installBundledAgentRpPreset({ presetRoot: root, sourceDir: SOURCE }),
    /not managed/u,
  )
})

test('claims character-card images for every Agent joined to the preset, including Agents joined after publication', async (context) => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin(AgentRegistry)
  const presetKey = {}
  const preset = createScope(root, presetKey)
  const claims = new Map<string, (offer: {
    agent: Agent
    content: ReadonlyArray<
      | { type: 'text'; text: string }
      | { type: 'image'; mediaType: string; name?: string }
      | { type: 'file'; name: string; mediaType?: string }
    >
  }) => { text: string } | undefined>()
  const importers = new Map<string, {
    recognize(offer: {
      agent: Agent
      content: ReadonlyArray<
        | { type: 'text'; text: string }
        | { type: 'image'; mediaType: string; name?: string }
        | { type: 'file'; name: string; mediaType?: string }
      >
    }): boolean
    import(input: {
      source: Agent
      text: string
      attachments: readonly CharacterCardAttachmentRef[]
      readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<Uint8Array>
    }, signal?: AbortSignal): Promise<{ seed: readonly SessionEvent[]; title?: string }>
  }>()
  root.provide('apiProxy' as never, {
    registerPromptAttachmentConsumer(name: string, consumer: (typeof claims extends Map<string, infer T> ? T : never)) {
      claims.set(name, consumer)
      return () => { claims.delete(name) }
    },
    registerPromptSessionImporter(name: string, importer: (typeof importers extends Map<string, infer T> ? T : never)) {
      importers.set(name, importer)
      return () => { importers.delete(name) }
    },
  } as never)
  root.provide('systemPrompt' as never, {
    section: () => () => {},
    context: () => () => {},
  } as never)
  root.provide('tools' as never, {
    register: () => () => {},
    restrict: () => () => {},
  } as never)
  root.provide('commands' as never, { register: () => () => {} } as never)
  root.provide('attachments' as never, {} as never)
  root.provide('credentials' as never, {} as never)
  const characterLibraryRoot = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-runtime-library-'))
  context.after(() => { rmSync(characterLibraryRoot, { recursive: true, force: true }) })
  let agentParentCtx: Context | undefined
  await preset.ctx.plugin({
    inject: ['llm', 'systemPrompt', 'tools'],
    apply(pluginCtx: Context) {
      installAgentRp(pluginCtx, resolveConfig({ mode: 'character' }), { characterLibraryRoot })
      agentParentCtx = pluginCtx
    },
  })
  assert.ok(agentParentCtx)
  const consumer = claims.get('dsh-agent-rp')
  const chatImporter = importers.get('dsh-agent-rp:sillytavern-chat')
  const cardImporter = importers.get('dsh-agent-rp:character-card')
  assert.ok(consumer)
  assert.ok(chatImporter)
  assert.ok(cardImporter)

  const joinedAgent = {
    id: SessionId('joined-character'),
    session: Session.create(SessionId('joined-character')),
  } as Agent
  const siblingAgent = {
    id: SessionId('sibling-agent'),
    session: Session.create(SessionId('sibling-agent')),
  } as Agent
  const laterJoinedAgent = {
    id: SessionId('later-joined-character'),
    session: Session.create(SessionId('later-joined-character')),
  } as Agent
  const joined = createScope(agentParentCtx, joinedAgent, { parent: presetKey })
  const laterJoined = createScope(agentParentCtx, laterJoinedAgent, { parent: presetKey })
  const sibling = createScope(root, siblingAgent)
  Object.assign(joinedAgent, { ctx: joined.ctx })
  Object.assign(laterJoinedAgent, { ctx: laterJoined.ctx })
  Object.assign(siblingAgent, { ctx: sibling.ctx })
  const disposeJoined = root.agents.register(joinedAgent)
  const disposeLaterJoined = root.agents.register(laterJoinedAgent)
  const disposeSibling = root.agents.register(siblingAgent)
  const content = [
    { type: 'text' as const, text: '导入这张角色卡' },
    { type: 'image' as const, mediaType: 'image/png', name: 'card.png' },
  ]
  assert.deepEqual(consumer({ agent: joinedAgent, content }), { text: '导入这张角色卡' })
  assert.equal(consumer({ agent: siblingAgent, content }), undefined)
  assert.deepEqual(consumer({ agent: joinedAgent, content: [
    { type: 'text', text: '导入这张角色卡' },
    { type: 'file', name: 'card.json', mediaType: 'application/json' },
  ] }), { text: '导入这张角色卡' })
  assert.equal(chatImporter.recognize({
    agent: joinedAgent,
    content: [{ type: 'file', name: 'history.jsonl', mediaType: 'application/jsonl' }],
  }), true)
  assert.equal(chatImporter.recognize({
    agent: siblingAgent,
    content: [{ type: 'file', name: 'history.jsonl' }],
  }), false)
  assert.equal(chatImporter.recognize({
    agent: laterJoinedAgent,
    content: [{ type: 'file', name: 'history.jsonl' }],
  }), true)
  const chatBytes = readFileSync('tests/fixtures/manual-sillytavern-chat.jsonl')
  const chatRef = {
    kind: 'file' as const,
    attachmentId: 'sha256:chat' as never,
    bytes: chatBytes.byteLength,
    name: 'history.jsonl',
    mediaType: 'application/x-ndjson',
  }
  const imported = await chatImporter.import({
    source: joinedAgent,
    text: '',
    attachments: [chatRef],
    readFile: async (ref) => {
      assert.equal(ref, chatRef)
      return chatBytes
    },
  })
  assert.equal(imported.title, '白露')
  assert.deepEqual(Session.create(SessionId('imported-chat'), imported.seed).deriveMessages()
    .map(message => message.content[0]?.type === 'text' ? message.content[0].text : undefined), [
      '门还没锁。',
      '那我进来啦。',
      '窗外响起整点钟声。',
    ])
  const cardBytes = readFileSync('tests/fixtures/manual-character-card.json')
  const cardRef = {
    kind: 'file' as const,
    attachmentId: 'sha256:card' as never,
    bytes: cardBytes.byteLength,
    name: '白露.json',
    mediaType: 'application/json',
  }
  const importedCard = await cardImporter.import({
    source: joinedAgent,
    text: '请导入这张角色卡',
    attachments: [cardRef],
    readFile: async () => cardBytes,
  })
  assert.equal(importedCard.title, '白露')
  assert.equal(readActiveSessionCharacter(importedCard.seed)?.result.name, '白露')

  context.after(async () => {
    disposeSibling()
    disposeLaterJoined()
    disposeJoined()
    await joined.dispose()
    await laterJoined.dispose()
    await sibling.dispose()
    await preset.dispose()
    await root.fiber.dispose()
  })
})

test('mounts commands when public DSH omits prompt extension gateways', async (context) => {
  const root = new Context()
  await root.plugin(AgentRegistry)
  const preset = createScope(root, {})
  const commands: string[] = []
  const commandInputs = new Map<string, { readonly hint: string } | undefined>()
  root.provide('systemPrompt' as never, { section: () => () => {}, context: () => () => {} } as never)
  root.provide('tools' as never, { register: () => () => {} } as never)
  root.provide('commands' as never, {
    register(definition: { readonly name: string; readonly input?: { readonly hint: string } }) {
      if (definition.input !== undefined) assert.notEqual(definition.input.hint.trim(), '')
      commands.push(definition.name)
      commandInputs.set(definition.name, definition.input)
      return () => {}
    },
  } as never)
  root.provide('attachments' as never, {} as never)
  root.provide('credentials' as never, {} as never)
  const characterLibraryRoot = mkdtempSync(join(tmpdir(), 'dsh-agent-rp-public-gateway-'))
  context.after(() => { rmSync(characterLibraryRoot, { recursive: true, force: true }) })

  installAgentRp(preset.ctx, resolveConfig({ mode: 'character' }), { characterLibraryRoot })
  assert.deepEqual(commands, [
    'rp-tavern-variables',
    'rp-tavern-trigger',
    'rp-character-library',
    'rp-chat-import',
    'rp-persona',
    'rp-story-workspace',
    'rp-memory',
    'rp-state',
    'rp-turn-mode',
    'rp-preset-configure',
    'rp-preset-library',
    'rp-generation',
    'rp-draw',
    'rp-world-info',
    'rp-regex',
    'rp-world-info-import',
  ])
  assert.equal(commandInputs.get('rp-tavern-trigger'), undefined)

  context.after(async () => {
    await preset.dispose()
    await root.fiber.dispose()
  })
})

test('recognizes one explicitly selected Character Card JSON import', () => {
  const selected = [
    { type: 'text' as const, text: '请导入这张角色卡' },
    { type: 'file' as const, name: '白露.json', mediaType: 'application/json' },
  ]
  assert.equal(isCharacterCardSessionOffer(true, selected), true)
  assert.equal(isCharacterCardSessionOffer(false, selected), false)
  assert.equal(isCharacterCardSessionOffer(true, [
    { type: 'text', text: '请导入这本世界书' },
    { type: 'file', name: '白露.json' },
  ]), false)
})

test('accepts only bounded explicit character-library launch controls', () => {
  assert.deepEqual(parseCharacterCardSessionRequest('请从角色库开始新会话\n{"format":0,"greetingIndex":1,"userName":" 小满 "}'), {
    format: 0,
    greetingIndex: 1,
    userName: '小满',
  })
  assert.equal(parseCharacterCardSessionRequest('请从角色库开始新会话\n{"format":0,"greetingIndex":-1}'), undefined)
  assert.equal(parseCharacterCardSessionRequest('请从角色库开始新会话\n{"format":0,"greetingIndex":0,"path":"D:/secret"}'), undefined)
})

test('recognizes exactly one JSONL attachment without requiring command text', () => {
  assert.equal(isSillyTavernChatOffer(true, [{ type: 'file', name: 'history.jsonl' }]), true)
  assert.equal(isSillyTavernChatOffer(true, [
    { type: 'text', text: '' },
    { type: 'file', name: 'HISTORY.JSONL' },
  ]), true)
  assert.equal(isSillyTavernChatOffer(true, [
    { type: 'file', name: 'one.jsonl' },
    { type: 'file', name: 'two.jsonl' },
  ]), false)
  assert.equal(isSillyTavernChatOffer(true, [{ type: 'file', name: 'history.json' }]), false)
  assert.equal(isSillyTavernChatOffer(false, [{ type: 'file', name: 'history.jsonl' }]), false)
})

test('imports a preset by forking the current roleplay Session before a model turn', () => {
  const offer = [
    { type: 'text' as const, text: '请导入这份预设' },
    { type: 'file' as const, name: 'V18.json', mediaType: 'application/json' },
  ]
  assert.equal(isSillyTavernPresetOffer(true, offer), true)
  assert.equal(isSillyTavernPresetOffer(false, offer), false)

  const preset = parseSillyTavernPresetJson(JSON.stringify({
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: '角色规则' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  }), 'V18.json')
  const source = Session.create(SessionId('preset-source'))
  const attachment = {
    kind: 'file' as const,
    attachmentId: 'sha256:preset' as never,
    bytes: 100,
    name: 'V18.json',
    mediaType: 'application/json',
  }
  const imported = Session.create(SessionId('preset-imported'), createPresetSessionSeed(source.snapshotEvents(), preset, attachment))

  assert.equal(readActiveSessionPreset(imported.snapshotEvents())?.preset.name, 'V18')
  assert.equal(readActiveSessionPreset(imported.snapshotEvents())?.result.enabledCount, 1)
  assert.equal(imported.deriveMessages().length, 0)
})
