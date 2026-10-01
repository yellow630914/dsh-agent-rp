/** Build complete Session seeds from Host-owned roleplay libraries. */

import { randomUUID } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CharacterLibrary } from './character-library.ts'
import { roleplayChatFloors, type RoleplayChatFloor } from './roleplay-chat-floors.ts'
import { encodeRegexConfiguration, readRegexConfiguration } from './regex-configuration-core.ts'
import { encodeWorldInfoConfiguration, readWorldInfoConfiguration } from './world-info-configuration-core.ts'
import { encodeTavernHelperState, readTavernHelperState } from './tavern-helper.ts'
import { readRoleplayStates } from './roleplay-state.ts'
import { appendAgentRpMemorySeed, readAgentRpMemoryHistory } from './memory.ts'
import { createCharacterCardSessionSeed } from './import/character-card-seed.ts'
import { createPresetSessionSeed } from './import/session-preset.ts'
import { protectedSystemHeadMessage } from './import/protected-system-head.ts'
import { createSillyTavernChatSeed, resolveSillyTavernChatIdentity } from './import/sillytavern-chat-seed.ts'
import { createSillyTavernMigrationSeed } from './import/sillytavern-migration-seed.ts'
import {
  appendCharacterWorldSessionSeed,
  appendWorldInfoLibrarySessionSeed,
  characterWorldInfoIds,
  createWorldInfoLibrarySessionSeed,
} from './import/world-info-seed.ts'
import { readActiveSessionCharacter, type FileAttachmentRef } from './import/session-character.ts'
import type { PresetLibrary, PresetLibraryEntry } from './preset-library.ts'
import { substituteCardMacros } from './prompt.ts'
import { parseSessionPersona } from './session-persona.ts'
import type { AgentRpSessionLaunchRequest, LibrarySessionLaunchRequest } from './session-launch-protocol.ts'
import type {
  RoleplayResourceKind,
  RoleplayResourceSelection,
} from './roleplay-resource-catalog-protocol.ts'
import type { RoleplayResourceCatalog } from './roleplay-resource-catalog.ts'
import { prepareRoleplayExperienceSession } from './roleplay-experience-materialization.ts'
import { isAgentRpCapabilityPresetId } from './agent-capability-preset-protocol.ts'
import { SillyTavernChatLibrary } from './sillytavern-chat-library.ts'
import { WorldInfoLibrary } from './world-info-library.ts'

/** Complete seed and display metadata used to create one Agent. */
export interface PreparedAgentRpSession {
  readonly seed: readonly SessionEvent[]
  readonly title: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}不是对象`)
  return value as Record<string, unknown>
}

const worldInfoLibraryIdPattern = /^world-info-[a-f0-9]{32}$/u

function parseAdditionalWorldInfoIds(value: unknown, primaryId?: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16
    || value.some(id => typeof id !== 'string' || !worldInfoLibraryIdPattern.test(id))) {
    throw new Error('附加世界书字段无效')
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length || (primaryId !== undefined && ids.includes(primaryId))) {
    throw new Error('附加世界书不能重复')
  }
  return [...ids]
}

function parseResourceSelection(
  value: unknown,
  expectedKind: RoleplayResourceKind,
  label: string,
): RoleplayResourceSelection {
  const record = object(value, label)
  const keys = Object.keys(record)
  if (record.kind !== expectedKind
    || typeof record.id !== 'string' || record.id.length > 512
    || record.id.trim() !== record.id || record.id === '' || /\s/u.test(record.id)
    || (record.variant !== undefined
      && (typeof record.variant !== 'string' || record.variant.length > 256
        || record.variant.trim() !== record.variant || record.variant === '' || /\s/u.test(record.variant)))
    || keys.some(key => key !== 'kind' && key !== 'id' && key !== 'variant')) {
    throw new Error(`${label}字段无效`)
  }
  return {
    kind: expectedKind,
    id: record.id,
    ...(typeof record.variant === 'string' ? { variant: record.variant } : {}),
  }
}

function parseAgentPresetId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isAgentRpCapabilityPresetId(value) || value.length > 80) {
    throw new Error('Agent 能力预设字段无效')
  }
  return value
}

/** Validate one same-origin browser request without accepting filesystem paths. */
export function parseAgentRpSessionLaunchRequest(value: unknown): AgentRpSessionLaunchRequest {
  const record = object(value, '角色会话启动请求')
  const common = record.format === 0 && typeof record.sourceSessionId === 'string'
    && record.sourceSessionId.trim() !== '' && record.sourceSessionId.length <= 512
  if (!common) throw new Error('角色会话启动请求字段无效')
  if (record.kind === 'character') {
    if (typeof record.characterId !== 'string' || !/^card-[a-f0-9]{32}$/u.test(record.characterId)
      || typeof record.greetingIndex !== 'number' || !Number.isSafeInteger(record.greetingIndex)
      || record.greetingIndex < 0
      || (record.presetId !== undefined
        && (typeof record.presetId !== 'string' || !/^[a-z0-9-]{8,80}$/u.test(record.presetId)))
      || (record.memory !== undefined && record.memory !== 'copy-active')
      || Object.keys(record).some(key => !['format', 'sourceSessionId', 'kind', 'characterId', 'greetingIndex', 'persona', 'presetId', 'agentPresetId', 'worldInfoIds', 'memory'].includes(key))) {
      throw new Error('角色会话启动请求字段无效')
    }
    const persona = record.persona === undefined ? undefined : parseSessionPersona(record.persona)
    const worldInfoIds = parseAdditionalWorldInfoIds(record.worldInfoIds)
    const agentPresetId = parseAgentPresetId(record.agentPresetId)
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'character',
      characterId: record.characterId,
      greetingIndex: record.greetingIndex,
      ...(persona === undefined ? {} : { persona }),
      ...(typeof record.presetId === 'string' ? { presetId: record.presetId } : {}),
      ...(agentPresetId === undefined ? {} : { agentPresetId }),
      ...(worldInfoIds === undefined ? {} : { worldInfoIds }),
      ...(record.memory === 'copy-active' ? { memory: 'copy-active' as const } : {}),
    }
  }
  if (record.kind === 'world-info') {
    if (typeof record.importId !== 'string' || !worldInfoLibraryIdPattern.test(record.importId)
      || (record.presetId !== undefined
        && (typeof record.presetId !== 'string' || !/^[a-z0-9-]{8,80}$/u.test(record.presetId)))
      || Object.keys(record).some(key => !['format', 'sourceSessionId', 'kind', 'importId', 'persona', 'presetId', 'agentPresetId', 'worldInfoIds'].includes(key))) {
      throw new Error('世界书会话启动请求字段无效')
    }
    const persona = record.persona === undefined ? undefined : parseSessionPersona(record.persona)
    const worldInfoIds = parseAdditionalWorldInfoIds(record.worldInfoIds, record.importId)
    const agentPresetId = parseAgentPresetId(record.agentPresetId)
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'world-info',
      importId: record.importId,
      ...(persona === undefined ? {} : { persona }),
      ...(typeof record.presetId === 'string' ? { presetId: record.presetId } : {}),
      ...(agentPresetId === undefined ? {} : { agentPresetId }),
      ...(worldInfoIds === undefined ? {} : { worldInfoIds }),
    }
  }
  if (record.kind === 'chat') {
    if (typeof record.importId !== 'string' || !/^chat-[a-f0-9]{32}$/u.test(record.importId)
      || (record.characterId !== undefined
        && (typeof record.characterId !== 'string' || !/^card-[a-f0-9]{32}$/u.test(record.characterId)))
      || (record.presetId !== undefined
        && (typeof record.presetId !== 'string' || !/^[a-z0-9-]{8,80}$/u.test(record.presetId)))
      || Object.keys(record).some(key => !['format', 'sourceSessionId', 'kind', 'importId', 'characterId', 'presetId', 'agentPresetId'].includes(key))) {
      throw new Error('聊天迁移启动请求字段无效')
    }
    const agentPresetId = parseAgentPresetId(record.agentPresetId)
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'chat',
      importId: record.importId,
      ...(typeof record.characterId === 'string' ? { characterId: record.characterId } : {}),
      ...(typeof record.presetId === 'string' ? { presetId: record.presetId } : {}),
      ...(agentPresetId === undefined ? {} : { agentPresetId }),
    }
  }
  if (record.kind === 'experience') {
    if ((record.mode !== 'character' && record.mode !== 'scene')
      || (record.actor !== undefined && record.mode !== 'character')
      || (record.mode === 'character' && record.actor === undefined)
      || !Array.isArray(record.worlds) || record.worlds.length > 16
      || (record.regexPacks !== undefined && (!Array.isArray(record.regexPacks) || record.regexPacks.length > 16))
      || (record.mode === 'scene' && record.worlds.length === 0)
      || Object.keys(record).some(key => ![
        'format', 'sourceSessionId', 'kind', 'mode', 'actor', 'participant', 'worlds', 'promptPolicy', 'regexPacks',
        'stateScheme', 'agentPresetId',
      ].includes(key))) {
      throw new Error('原生角色体验启动请求字段无效')
    }
    const actor = record.actor === undefined
      ? undefined
      : parseResourceSelection(record.actor, 'actor', '角色资源')
    const participant = record.participant === undefined
      ? undefined
      : parseResourceSelection(record.participant, 'persona', '玩家身份资源')
    const worlds = record.worlds.map(value => parseResourceSelection(value, 'world', '世界资源'))
    if (new Set(worlds.map(world => world.id)).size !== worlds.length) throw new Error('世界资源不能重复')
    const promptPolicy = record.promptPolicy === undefined
      ? undefined
      : parseResourceSelection(record.promptPolicy, 'prompt-policy', '提示策略资源')
    const regexPacks = (record.regexPacks ?? []).map(value => parseResourceSelection(value, 'regex', '正则包资源'))
    if (new Set(regexPacks.map(pack => pack.id)).size !== regexPacks.length) throw new Error('正则包资源不能重复')
    const stateScheme = record.stateScheme === undefined
      ? undefined
      : parseResourceSelection(record.stateScheme, 'state-scheme', '状态方案资源')
    const agentPresetId = parseAgentPresetId(record.agentPresetId)
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'experience',
      mode: record.mode,
      ...(actor === undefined ? {} : { actor }),
      ...(participant === undefined ? {} : { participant }),
      worlds,
      ...(promptPolicy === undefined ? {} : { promptPolicy }),
      regexPacks,
      ...(stateScheme === undefined ? {} : { stateScheme }),
      ...(agentPresetId === undefined ? {} : { agentPresetId }),
    }
  }
  if (record.kind === 'rewrite') {
    if (typeof record.turn !== 'number' || !Number.isSafeInteger(record.turn) || record.turn < 1
      || typeof record.text !== 'string' || record.text.trim() === '' || record.text.length > 8_000
      || Object.keys(record).some(key => !['format', 'sourceSessionId', 'kind', 'turn', 'text'].includes(key))) {
      throw new Error('改写会话请求字段无效')
    }
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'rewrite',
      turn: record.turn,
      text: record.text,
    }
  }
  if (record.kind === 'branch') {
    if (typeof record.fromFloor !== 'number' || !Number.isSafeInteger(record.fromFloor) || record.fromFloor < 0
      || Object.keys(record).some(key => !['format', 'sourceSessionId', 'kind', 'fromFloor'].includes(key))) {
      throw new Error('分支会话请求字段无效')
    }
    return {
      format: 0,
      sourceSessionId: record.sourceSessionId as string,
      kind: 'branch',
      fromFloor: record.fromFloor,
    }
  }
  throw new Error('角色会话启动类型无效')
}

function presetAttachment(entry: PresetLibraryEntry): FileAttachmentRef {
  return {
    kind: 'file',
    attachmentId: AttachmentId(`library:${entry.id}`),
    bytes: Buffer.byteLength(JSON.stringify(entry.preset), 'utf8'),
    name: 'preset.json',
    mediaType: 'application/json',
  }
}

function seedWithPreset(
  seed: readonly SessionEvent[],
  presets: PresetLibrary,
  presetId: string | undefined,
): readonly SessionEvent[] {
  if (presetId === undefined) return seed
  const entry = presets.get(presetId)
  return createPresetSessionSeed(seed, entry.preset, presetAttachment(entry), entry.id)
}

function seedWithWorldInfos(
  seed: readonly SessionEvent[],
  worldInfos: WorldInfoLibrary,
  worldInfoIds: readonly string[] | undefined,
  excludedIds: readonly string[] = [],
): readonly SessionEvent[] {
  const excluded = new Set(excludedIds)
  const selected = (worldInfoIds ?? worldInfos.defaultIds()).filter(id => !excluded.has(id))
  return selected.reduce(
    (events, id) => appendWorldInfoLibrarySessionSeed(events, worldInfos.asset(id)),
    seed,
  )
}

function libraryAttachment(
  characterId: string,
  transport: 'png' | 'json' | 'charx',
  bytes: number,
  originalFilename: string,
  mediaType: string,
): FileAttachmentRef {
  const extension = transport === 'png' ? 'png' : transport === 'charx' ? 'charx' : 'json'
  const name = new RegExp(`\\.${extension}$`, 'iu').test(originalFilename)
    ? originalFilename
    : `character.${extension}`
  return {
    kind: 'file',
    attachmentId: AttachmentId(`library:${characterId}`),
    bytes,
    name,
    mediaType,
  }
}

/** Resolve one validated launch into a balanced seed before any Agent exists. */
export function prepareAgentRpSession(
  characters: CharacterLibrary,
  chats: SillyTavernChatLibrary,
  presets: PresetLibrary,
  worldInfos: WorldInfoLibrary,
  request: LibrarySessionLaunchRequest,
  resources?: RoleplayResourceCatalog,
): PreparedAgentRpSession {
  if (request.kind === 'experience') {
    if (resources === undefined) throw new Error('当前 Host 没有可用的原生角色资源目录')
    return prepareRoleplayExperienceSession(resources, request)
  }
  if (request.kind === 'character') {
    const resolved = characters.resolve(request.characterId)
    if (resolved.detail.archived) throw new Error('请先恢复这个角色，再开始对话')
    const selectedGreeting = resolved.detail.greetings[request.greetingIndex]
    if (selectedGreeting === undefined) throw new Error(`角色卡没有第 ${request.greetingIndex + 1} 条开场白`)
    const source = libraryAttachment(
      request.characterId,
      resolved.transport.transport,
      resolved.source.bytes,
      resolved.source.originalFilename,
      resolved.source.mediaType,
    )
    const userName = request.persona?.name
    const characterSeed = createCharacterCardSessionSeed(
        resolved.card,
        source,
        request.greetingIndex,
        substituteCardMacros(selectedGreeting, resolved.card, userName).trim(),
        resolved.transport,
        userName,
        request.persona,
        request.characterId,
      )
    const characterWorldIds = characterWorldInfoIds(resolved.worldBinding)
    const characterWorldSeed = appendCharacterWorldSessionSeed(
      characterSeed,
      resolved.worldBinding,
      worldInfos,
    )
    return {
      seed: identityFirstSeed(seedWithPreset(
        seedWithWorldInfos(
          characterWorldSeed,
          worldInfos,
          request.worldInfoIds,
          characterWorldIds,
        ),
        presets,
        request.presetId,
      )),
      title: resolved.detail.displayName,
    }
  }

  if (request.kind === 'world-info') {
    const asset = worldInfos.asset(request.importId)
    return {
      seed: identityFirstSeed(seedWithPreset(
        seedWithWorldInfos(
          createWorldInfoLibrarySessionSeed(asset, request.persona),
          worldInfos,
          request.worldInfoIds,
          [request.importId],
        ),
        presets,
        request.presetId,
      )),
      title: asset.upload.name,
    }
  }

  const chat = chats.resolve(request.importId)
  if (request.characterId === undefined) {
    const identity = resolveSillyTavernChatIdentity(chat.chat)
    return {
      seed: identityFirstSeed(seedWithPreset(createSillyTavernChatSeed(chat.chat, chat.attachment), presets, request.presetId)),
      title: identity.characterName?.trim() || chat.upload.name.replace(/\.jsonl$/iu, ''),
    }
  }
  const character = characters.resolve(request.characterId)
  if (character.detail.archived) throw new Error('请先恢复这个角色，再迁移聊天记录')
  const source = libraryAttachment(
    request.characterId,
    character.transport.transport,
    character.source.bytes,
    character.source.originalFilename,
    character.source.mediaType,
  )
  const migrationSeed = createSillyTavernMigrationSeed(
      character.card,
      source,
      character.transport,
      chat.chat,
      chat.attachment,
      request.characterId,
    )
  // A migrated chat activates the same reusable worlds a fresh character
  // Session would. Without these actor snapshots the Session falls back to the
  // card's embedded `character_book`, so worlds the player bound in the
  // resource center — and edits made to a split embedded book — are lost.
  return {
    seed: seedWithPreset(
      appendCharacterWorldSessionSeed(migrationSeed, character.worldBinding, worldInfos),
      presets,
      request.presetId,
    ),
    title: character.detail.displayName,
  }
}

/**
 * One synthesized carry event, before it is given a seq.
 *
 * Seeds are validated by `Session.create`, not by this type: the event union's
 * surface metadata is conditional on the event type, which a generic builder
 * cannot express while still pushing several event types into one array.
 */
type CarriedEvent = Omit<SessionEvent, 'seq'> | {
  readonly type: string
  readonly time?: number
  readonly data: unknown
  readonly surfaceOp?: 'append'
  readonly ignorable?: true
}

/**
 * Keep the events that do not belong to any turn, renumbered contiguously.
 *
 * The launch seeds are not simply "everything before the first turn": a character
 * launch seeds its greeting as a complete turn and then appends the preset and
 * world-info seeds *after* it, so a prefix cut at the first `turn/start` silently
 * drops them. What actually separates identity from transcript is turn
 * membership, so that is the rule — every turn's contents are re-stated or
 * carried explicitly, and everything outside a turn is identity.
 * @param events - complete source events.
 * @returns the out-of-turn events with fresh contiguous seqs.
 */
/**
 * Move every identity seed ahead of the transcript it was appended behind.
 *
 * A seed is assembled by appending: the imported chat or the card's greeting
 * lands first, then the preset, world books and persona go on the end. That
 * reads fine until something takes a *prefix* of the log — DSH's own "branch in
 * a new conversation" copies events up to the message it forks at — and a fork
 * anywhere inside the transcript then predates the identity, so the child
 * Session comes up with no character, no world books and no preset.
 *
 * Turn membership is what separates the two: everything inside a `turn/start` …
 * `turn/end` span is transcript, everything else is identity. Reordering is safe
 * because a seed's identity events are independent records; the one seq-bearing
 * reference (the card's own `sourceEventSeq`) is remapped here.
 * @param events - a finished seed, in append order.
 * @returns the same events with identity first, renumbered contiguously.
 */
function identityFirstSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const identity: SessionEvent[] = []
  const transcript: SessionEvent[] = []
  let depth = 0
  for (const event of events) {
    if (event.type === 'turn/start') depth += 1
    ;(depth > 0 ? transcript : identity).push(event)
    if (event.type === 'turn/end') depth = Math.max(0, depth - 1)
  }
  if (transcript.length === 0 || identity.length === 0) return events
  const moved = new Map<number, number>()
  const ordered = [...identity, ...transcript].map((event, index) => {
    moved.set(Number(event.seq), index)
    return { ...event, seq: SessionSeq(index) } as SessionEvent
  })
  // Seed records cite the event that established them, which for a library seed
  // is the record itself; both readers verify that, so the citation moves too.
  const cites = new Set(['agent-rp/character-card-seed', 'agent-rp/world-info-library-seed',
    'agent-rp/sillytavern-preset-seed'])
  return ordered.map((event) => {
    if (!cites.has(event.type)) return event
    const data = event.data as { readonly meta?: { readonly result?: { readonly sourceEventSeq?: number } } }
    const source = data.meta?.result?.sourceEventSeq
    if (source === undefined) return event
    return {
      ...event,
      data: {
        ...data,
        meta: { ...data.meta, result: { ...data.meta?.result, sourceEventSeq: moved.get(source) ?? source } },
      },
    } as SessionEvent
  })
}

function outOfTurnSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const kept: SessionEvent[] = []
  let depth = 0
  for (const event of events) {
    if (event.type === 'turn/start') { depth += 1; continue }
    if (event.type === 'turn/end') { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue
    kept.push({ ...event, seq: SessionSeq(kept.length) } as SessionEvent)
  }
  return kept
}

/** Give a run of synthesized events contiguous seqs after an existing seed. */
function appendCarried(seed: readonly SessionEvent[], carried: readonly CarriedEvent[]): readonly SessionEvent[] {
  if (carried.length === 0) return seed
  let time = Math.max(Date.now(), (seed.at(-1)?.time ?? 0) + 1)
  const events = [...seed]
  for (const event of carried) {
    events.push({ ...event, seq: SessionSeq(events.length), time: time += 1 } as SessionEvent)
  }
  return events
}

/**
 * Re-state only the configuration the kept events do not already establish.
 *
 * Out-of-turn events survive into the branch verbatim, so the folds they feed
 * need no help. What needs carrying is whatever the player changed *inside* a
 * turn, because those events are dropped with the transcript. Emitting a carry
 * unconditionally would double-apply the rest — and for state data that is not
 * merely redundant but invalid, since revisions must stay contiguous.
 *
 * The regex, world-info and Tavern overlays fold from any successful
 * `command/done`, which is why one lone done event carries them: the matching
 * `command/run` only mattered to the Host that ran it.
 * @param events - complete source events.
 * @param kept - the out-of-turn events the branch keeps verbatim.
 * @returns the carry events, in the order they must be replayed.
 */
function carriedRoleplayConfiguration(
  events: readonly SessionEvent[],
  kept: readonly SessionEvent[],
): readonly CarriedEvent[] {
  const carried: CarriedEvent[] = []
  const carryCommand = (label: string, current: string, previous: string): void => {
    if (current === previous) return
    carried.push({
      type: 'command/done',
      data: { commandId: CommandId(`branch-${label}-${randomUUID()}`), kind: 'success', text: current },
    })
  }
  carryCommand('regex',
    encodeRegexConfiguration(readRegexConfiguration(events)),
    encodeRegexConfiguration(readRegexConfiguration(kept)))
  carryCommand('world-info',
    encodeWorldInfoConfiguration(readWorldInfoConfiguration(events)),
    encodeWorldInfoConfiguration(readWorldInfoConfiguration(kept)))
  const tavern = readTavernHelperState(events)
  const keptTavern = readTavernHelperState(kept)
  if (tavern !== undefined) {
    carryCommand('tavern',
      encodeTavernHelperState(tavern),
      keptTavern === undefined ? '' : encodeTavernHelperState(keptTavern))
  }
  // A carried state is written by the owning module, not by the player: a player
  // write must cite the exact `rp-state` command event that made it, and that
  // event may be one of the dropped ones. The value is identical either way;
  // only the attribution changes, from "the player edited this" to "the module
  // that owns it established it".
  const keptStates = readRoleplayStates(kept)
  for (const state of readRoleplayStates(events)) {
    const previous = keptStates.find(candidate => candidate.id === state.id)
    if (previous !== undefined && JSON.stringify(previous.value) === JSON.stringify(state.value)) continue
    carried.push({
      type: 'agent-rp/state',
      data: {
        format: 0,
        id: state.id,
        // Continue whatever the kept events already established, or open the
        // namespace at one.
        revision: (previous?.revision ?? 0) + 1,
        ownerModuleId: previous?.ownerModuleId ?? state.ownerModuleId,
        writerModuleId: previous?.ownerModuleId ?? state.ownerModuleId,
        value: state.value,
      },
      ignorable: true,
    } as CarriedEvent)
  }
  return carried
}

/** Replay one floor as its own completed turn, the shape an imported chat uses. */
function appendFloorTurn(
  carried: CarriedEvent[],
  floor: RoleplayChatFloor,
  turn: number,
  systemHead: boolean,
): void {
  carried.push({ type: 'turn/start', data: { turn } } as CarriedEvent)
  carried.push({ type: 'step/start', data: { turn, step: 1 } } as CarriedEvent)
  if (systemHead) {
    carried.push({
      type: 'system/message',
      data: { turn, step: 1, message: protectedSystemHeadMessage() },
      surfaceOp: 'append',
    } as CarriedEvent)
  }
  if (floor.role === 'assistant') {
    carried.push({
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: floor.text }],
          source: { provider: 'agent-rp-branch', model: 'history' },
        }),
        // Re-stated history never streamed from a model, so the embedded stream is empty.
        stream: [],
      },
      surfaceOp: 'append',
    } as CarriedEvent)
  } else {
    carried.push({
      type: 'user/message',
      data: createUserMessage({
        content: [{ type: 'text', text: floor.text }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    } as CarriedEvent)
  }
  carried.push({ type: 'step/end', data: { turn, step: 1 } } as CarriedEvent)
  carried.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } as CarriedEvent)
}

/**
 * Branch an Agent RP Session, keeping the transcript from one floor onward.
 *
 * This is an ordinary branch: the card, persona, world books, memory, regex
 * overlay and state data all carry over, and the source Session is untouched.
 * The transcript is the one thing that cannot carry over as events — an event
 * log's seqs start at zero with its seeds first, so "keep the later floors"
 * has to re-state them the way a chat import does, as one completed turn each.
 *
 * What that loses is deliberate and bounded: per-floor annotations, generated
 * artifacts, reply versions, and the turn plans, settlements and presentations
 * of the kept floors. The floors' text, roles and order survive, which is what
 * an export/import round trip preserves too.
 * @param session - live source session; only read.
 * @param fromFloor - first visible floor index to keep, as the floor panel numbers them.
 * @param sourceTitle - the source Session's display title, when it has one.
 * @returns the seed and title for the branch.
 */
export function prepareAgentRpBranchSession(
  session: Session,
  fromFloor: number,
  sourceTitle?: string,
): PreparedAgentRpSession {
  if (!Number.isSafeInteger(fromFloor) || fromFloor < 0) throw new Error('起始楼层无效')
  const events = session.snapshotEvents()
  const firstTurn = events.find(event => event.type === 'turn/start')
  if (firstTurn === undefined) throw new Error('来源会话还没有对话可以分支')
  const floors = roleplayChatFloors(session)
  if (fromFloor >= floors.length) throw new Error(`第 ${fromFloor} 楼不存在`)
  const kept = floors.slice(fromFloor)
  if (kept.length === 0) throw new Error('至少需要保留一条楼层')
  const outOfTurn = outOfTurnSeed(events)
  // Memory carries as one seed record, so the kept events' own memory is already
  // in the fold; passing the active set re-establishes exactly what is current.
  const base = appendAgentRpMemorySeed(outOfTurn, readAgentRpMemoryHistory(events).active, String(session.id))
  const carried: CarriedEvent[] = [...carriedRoleplayConfiguration(events, base)]
  kept.forEach((floor, index) => { appendFloorTurn(carried, floor, index + 1, index === 0) })
  const seed = appendCarried(base, carried)
  const validated = Session.create(SessionId('agent-rp-branch-validation'), seed)
  const characterName = readActiveSessionCharacter(seed)?.result.name
  const title = sourceTitle?.trim() || characterName?.trim() || '角色对话'
  return {
    seed: Object.freeze(validated.snapshotEvents().slice(0, seed.length)),
    title: `${title} · 分支`,
  }
}

/** Cut one completed user turn from an Agent RP transcript without changing its source. */
export function prepareAgentRpRewriteSession(
  session: Pick<Session, 'snapshotEvents'>,
  turn: number,
  sourceTitle?: string,
): PreparedAgentRpSession {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('改写轮次无效')
  const start = session.snapshotEvents().find(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start === undefined) throw new Error(`第 ${turn} 轮不存在`)
  const end = session.snapshotEvents().find(event => event.seq > start.seq && event.type === 'turn/end' && event.data.turn === turn)
  if (end === undefined) throw new Error(`第 ${turn} 轮尚未完成，请等待回复结束`)
  const userMessage = session.snapshotEvents().find(event => event.seq > start.seq && event.seq < end.seq && event.type === 'user/message')
  if (userMessage === undefined) throw new Error('这一轮没有可改写的用户消息')
  const seed = session.snapshotEvents().slice(0, start.seq)
  const characterName = readActiveSessionCharacter(seed)?.result.name
  const title = sourceTitle?.trim() || characterName?.trim() || '角色对话'
  return { seed, title: `${title} · 改写` }
}
