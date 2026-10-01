/** Incremental browser projection of the active Roleplay identity. */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseCharacterCardValue } from './import/character-card.ts'
import { decodeCharacterLibraryLaunch, type CharacterImportMeta, type CharacterLibraryLaunchRecord } from './import/session-character.ts'
import { readSillyTavernChatIdentity } from './import/sillytavern-chat-seed.ts'
import {
  parseWorldInfoImportMeta,
  worldInfoLibrarySeedSemantics,
  type WorldInfoImportMeta,
} from './import/session-world-info.ts'
import { parseWorldInfoJson } from './import/world-info.ts'
import type { ActiveSessionPreset, PresetImportMeta } from './import/session-preset.ts'
import {
  presetRegexScripts,
  presetTavernHelperScripts,
  type ImportedSillyTavernPreset,
} from './import/sillytavern-preset.ts'
import { DEFAULT_AGENT_RP_CHARACTER_NAME, type AgentRpProjection } from './projection-types.ts'
import { applyMvuReply, readCurrentMvuState, readCurrentMvuStateFromLorebooks, substituteMvuMacros } from './mvu.ts'
import {
  parseRoleplayStateScheme,
  roleplayStateSchemeLibraryId,
  type RoleplayStateSchemeSnapshot,
} from './roleplay-state-scheme.ts'
import { canEditPresetPrompt, canTogglePresetPrompt } from './preset-configuration.ts'
import { configurePreset, parsePresetConfigurationRequest } from './preset-configuration-core.ts'
import { parsePresetLibraryResult } from './preset-library-protocol.ts'
import { parseSessionPersona } from './session-persona.ts'
import { decodeGenerationState, type GenerationStateRecord } from './generation.ts'
import { createNativeWorldEngine } from './world-engine.ts'
import { summarizeWorldEngineFailures } from './world-engine-diagnostic.ts'
import { createEjsWorldInfoBooks, EjsTemplateEngine } from './ejs-template.ts'
import type { ImportedCharacterCard, ImportedWorldInfo } from './import/types.ts'
import {
  characterWorldInfoBookName,
  configuredLorebook,
  decodeWorldInfoConfiguration,
  editableWorldInfoEntry,
  worldInfoBookOverride,
  worldInfoTokenBudget,
  withTavernWorldbooks,
  type SessionLorebookSource,
} from './world-info-configuration-core.ts'
import type { WorldInfoConfigurationState } from './world-info-configuration-types.ts'
import { decodeSillyTavernChatCommandRecord, type SillyTavernChatCommandRecord } from './sillytavern-chat-protocol.ts'
import { decodeWorldInfoLibraryImport } from './world-info-library-protocol.ts'
import { decodePersonaCommandRecord } from './persona-command-protocol.ts'
import {
  decodeActiveTavernHelperState,
  initializeTavernHelperPresetState,
  initializeTavernHelperState,
  type TavernHelperState,
} from './tavern-helper.ts'
import { PROMPT_REGEX_SOURCE_MARKER, readPromptRegexSourceMarker } from './frontend-regex.ts'
import {
  applyTavernAuxiliaryGenerationEvent,
  EMPTY_TAVERN_AUXILIARY_GENERATION_REPLAY,
  summarizeTavernAuxiliaryGenerationReplay,
  type TavernAuxiliaryGenerationReplay,
} from './tavern-generation-log.ts'
import {
  normalizeRoleplayTurnPresentation,
} from './roleplay-turn-presentation-state.ts'
import type {
  RoleplayTurnPresentation,
} from './roleplay-turn-presentation-types.ts'
import {
  applyRoleplayStateEvent,
  type RoleplayStateSnapshot,
} from './roleplay-state.ts'
import { parseRoleplayTurnModeRecord, type RoleplayTurnMode } from './roleplay-turn-mode.ts'
import { hostSupportsAgentRpSessionEvents } from './session-event-compat.ts'
import {
  applyTavernMessageAnnotationEvent,
  indexTavernMessageAnnotations,
  type TavernMessageAnnotationState,
} from './tavern-message-annotation.ts'
import { substituteSillyTavernIdentityMacros } from './sillytavern-identity-macro.ts'
import { summarizeRegexPackScripts } from './regex-pack.ts'
import { configuredRegexScripts, decodeRegexConfiguration } from './regex-configuration-core.ts'
import type { RegexConfigurationState } from './regex-configuration-types.ts'
import { parseSessionRegexPack, type SessionRegexPackSnapshot } from './session-regex-pack.ts'

export type { AgentRpProjection } from './projection-types.ts'

const projectionSchema = {
  parse(value: unknown): AgentRpProjection {
    const record = value as Partial<Record<keyof AgentRpProjection, unknown>> | null
    const validCardVersion = record?.cardVersion === undefined
      || record.cardVersion === 1 || record.cardVersion === 2 || record.cardVersion === 3
    const validSource = record?.source === 'character-card'
      || record?.source === 'sillytavern-chat' || record?.source === 'preset'
    if (record === null || typeof record !== 'object'
      || (record.hostCapabilities !== undefined && (typeof record.hostCapabilities !== 'object'
        || record.hostCapabilities === null || Array.isArray(record.hostCapabilities)
        || typeof (record.hostCapabilities as Record<string, unknown>).sessionEvents !== 'boolean'))
      || typeof record.characterName !== 'string'
      || (record.turnMode !== 'conversation' && record.turnMode !== 'agent')
      || (record.originalCharacterName !== undefined && typeof record.originalCharacterName !== 'string')
      || typeof record.description !== 'string'
      || typeof record.personality !== 'string'
      || typeof record.scenario !== 'string'
      || (record.userName !== undefined && typeof record.userName !== 'string')
      || (record.persona !== undefined && (typeof record.persona !== 'object' || record.persona === null))
      || !Array.isArray(record.generations)
      || !Array.isArray(record.floors)
      || record.floors.some(floor => typeof floor !== 'object' || floor === null
        || typeof (floor as Record<string, unknown>).seq !== 'number'
        || typeof (floor as Record<string, unknown>).preview !== 'string'
        || typeof (floor as Record<string, unknown>).hidden !== 'boolean')
      || (record.currentReplySeq !== undefined && (typeof record.currentReplySeq !== 'number'
        || !Number.isSafeInteger(record.currentReplySeq) || record.currentReplySeq < 0))
      || (record.presentation !== undefined && (typeof record.presentation !== 'object'
        || record.presentation === null || Array.isArray(record.presentation)))
      || !validCardVersion
      || (record.characterCardRaw !== undefined && (typeof record.characterCardRaw !== 'object'
        || record.characterCardRaw === null || Array.isArray(record.characterCardRaw)))
      || (record.avatarAttachmentId !== undefined && typeof record.avatarAttachmentId !== 'string')
      || (record.avatarLibraryId !== undefined && typeof record.avatarLibraryId !== 'string')
      || typeof record.importedMessageCount !== 'number' || !Number.isSafeInteger(record.importedMessageCount)
      || record.importedMessageCount < 0
      || !Array.isArray(record.nativeStates)
      || !validNativeStates(record.nativeStates)
      || (record.auxiliaryGenerations !== undefined && !validAuxiliaryGenerationSummary(record.auxiliaryGenerations))
      || typeof record.worldInfoCount !== 'number' || !Number.isSafeInteger(record.worldInfoCount)
      || record.worldInfoCount < 0
      || typeof record.worldInfo !== 'object' || record.worldInfo === null
      || (record.frontend !== undefined && (typeof record.frontend !== 'object' || record.frontend === null))
      || !Array.isArray(record.regexPacks)
      || (record.tavern !== undefined && (typeof record.tavern !== 'object' || record.tavern === null))
      || (record.preset !== undefined && (typeof record.preset !== 'object' || record.preset === null))
      || !Array.isArray(record.presetLibrary)
      || (record.lastRequest !== undefined && (typeof record.lastRequest !== 'object' || record.lastRequest === null))
      || (record.promptRegex !== undefined && (typeof record.promptRegex !== 'object' || record.promptRegex === null))
      || (record.stateScheme !== undefined && !validStateScheme(record.stateScheme))
      || (record.stateSettlement !== undefined && !validStateSettlement(record.stateSettlement))
      || !validSource) throw new Error('invalid agentRp projection')
    return value as AgentRpProjection
  },
}

function validStateScheme(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.name === 'string'
    && typeof record.stateId === 'string' && record.stateId !== ''
    && typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision >= 0
    && typeof record.rules === 'string'
    && (record.libraryId === undefined || typeof record.libraryId === 'string')
    && Object.prototype.hasOwnProperty.call(record, 'value')
}

function validStateSettlement(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.turn) || !Array.isArray(record.stages)) return false
  if (typeof record.settling !== 'boolean') return false
  if (record.outcome !== undefined && typeof record.outcome !== 'string') return false
  return record.stages.every((stage) => {
    if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) return false
    const entry = stage as Record<string, unknown>
    return (entry.stage === 'proposal' || entry.stage === 'verification')
      && (entry.outcome === 'success' || entry.outcome === 'failure')
      && (entry.operations === undefined || Array.isArray(entry.operations))
      && (entry.error === undefined || typeof entry.error === 'string')
  })
}

function validNativeStates(value: readonly unknown[]): boolean {
  return value.every((state) => {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return false
    const record = state as Record<string, unknown>
    return typeof record.id === 'string'
      && typeof record.ownerModuleId === 'string'
      && typeof record.writerModuleId === 'string'
      && typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision > 0
      && typeof record.eventSeq === 'number' && Number.isSafeInteger(record.eventSeq) && record.eventSeq >= 0
      && Object.prototype.hasOwnProperty.call(record, 'value')
  })
}

function validAuxiliaryGenerationSummary(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!['requests', 'succeeded', 'failed', 'pending', 'malformed'].every(key =>
    typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0)
  ) return false
  return record.requests === Number(record.succeeded) + Number(record.failed) + Number(record.pending)
}

type ImportCall = 'character-card' | 'world-info' | 'preset'

interface AgentRpProjectionState {
  readonly character: Omit<AgentRpProjection, 'worldInfoCount' | 'worldInfo' | 'presetLibrary' | 'lastRequest'
  | 'generations' | 'auxiliaryGenerations' | 'presentation' | 'nativeStates' | 'turnMode' | 'hostCapabilities'
  | 'regexPacks' | 'regex' | 'floors'>
  readonly turnMode: RoleplayTurnMode
  readonly cardWorldInfoCount: number
  readonly cardLorebook?: SessionLorebookSource
  readonly standaloneWorldInfos: Readonly<Record<string, SessionLorebookSource>>
  readonly worldInfoConfiguration: WorldInfoConfigurationState
  readonly replayTime: number
  /**
   * The rendered system prompt currently in effect.
   *
   * DSH 0.2.0 took `system` off the request header and made the prompt a
   * `system/message` surface node instead, so the compatibility inspector folds
   * it from the log rather than reading it off each header. Later nonempty
   * system nodes supersede earlier ones; an empty one records "no system prompt".
   */
  readonly systemPrompt: string
  readonly surface: readonly {
    readonly seq: number
    readonly text?: string
    readonly reasoning?: string
    readonly role?: 'user' | 'assistant'
  }[]
  readonly calls: Readonly<Record<string, ImportCall>>
  readonly personaCommands: Readonly<Record<string, number>>
  readonly nativeStates: readonly RoleplayStateSnapshot[]
  readonly stateScheme?: RoleplayStateSchemeSnapshot
  readonly stateSettlementTrail: readonly {
    readonly seq: number
    readonly kind: 'request' | 'result' | 'worker'
    readonly turn: number
    readonly data: JsonValue
  }[]
  readonly mvu?: AgentRpProjection['mvu']
  readonly preset?: AgentRpProjection['preset']
  readonly presetState?: ActiveSessionPreset
  readonly presetLibrary: AgentRpProjection['presetLibrary']
  readonly lastRequest?: AgentRpProjection['lastRequest']
  readonly promptRegex?: AgentRpProjection['promptRegex']
  readonly generations: Readonly<Record<string, GenerationStateRecord>>
  /** Appended replacement seq → the transcript row it stands in for. */
  readonly surfaceAnchors: Readonly<Record<string, number>>
  /** Transcript rows a replacement superseded; the planner hides them. */
  readonly supersededSeqs: readonly number[]
  /**
   * Rows dropped from the surface by a real `replace` — today only the
   * floor-hide marker. Unlike {@link supersededSeqs} these rows have no
   * stand-in carrying their text: the player asked for them to be gone, so the
   * planner hides them outright.
   */
  readonly shadowedSeqs: readonly number[]
  readonly currentReplySeq?: number
  readonly presentation?: RoleplayTurnPresentation
  readonly tavern?: TavernHelperState
  readonly tavernMessageAnnotations: TavernMessageAnnotationState
  readonly auxiliaryGenerations: TavernAuxiliaryGenerationReplay
  readonly regexPacks: readonly SessionRegexPackSnapshot[]
  readonly regexConfiguration: RegexConfigurationState
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Replayable Host state behind the client-visible Agent RP projection. */
    agentRp: AgentRpProjectionState
  }
}

const projectionStateSchema = {
  parse(value: unknown): AgentRpProjectionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('invalid agentRp projection state')
    }
    const record = value as Partial<Record<keyof AgentRpProjectionState, unknown>>
    if (typeof record.character !== 'object' || record.character === null || Array.isArray(record.character)
      || (record.turnMode !== 'conversation' && record.turnMode !== 'agent')
      || typeof record.cardWorldInfoCount !== 'number' || !Number.isSafeInteger(record.cardWorldInfoCount)
      || record.cardWorldInfoCount < 0
      || typeof record.standaloneWorldInfos !== 'object' || record.standaloneWorldInfos === null
      || Array.isArray(record.standaloneWorldInfos)
      || typeof record.worldInfoConfiguration !== 'object' || record.worldInfoConfiguration === null
      || Array.isArray(record.worldInfoConfiguration)
      || typeof record.replayTime !== 'number' || !Number.isSafeInteger(record.replayTime)
      || !Array.isArray(record.surface)
      || typeof record.calls !== 'object' || record.calls === null || Array.isArray(record.calls)
      || typeof record.personaCommands !== 'object' || record.personaCommands === null
      || Array.isArray(record.personaCommands)
      || !Array.isArray(record.nativeStates) || !validNativeStates(record.nativeStates)
      || !Array.isArray(record.presetLibrary)
      || !Array.isArray(record.regexPacks)
      || typeof record.generations !== 'object' || record.generations === null || Array.isArray(record.generations)
      || (record.presentation !== undefined && (typeof record.presentation !== 'object'
        || record.presentation === null || Array.isArray(record.presentation)))
      || typeof record.tavernMessageAnnotations !== 'object' || record.tavernMessageAnnotations === null
      || Array.isArray(record.tavernMessageAnnotations)
      || typeof record.auxiliaryGenerations !== 'object' || record.auxiliaryGenerations === null
      || Array.isArray(record.auxiliaryGenerations)) {
      throw new Error('invalid agentRp projection state')
    }
    return value as AgentRpProjectionState
  },
} as ProjectionDefinition<'agentRp', AgentRpProjectionState>['stateSchema']

const INITIAL_CHARACTER: AgentRpProjectionState['character'] = {
  characterName: DEFAULT_AGENT_RP_CHARACTER_NAME,
  description: '',
  personality: '',
  scenario: '',
  importedMessageCount: 0,
  source: 'preset',
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function cardProjection(
  previous: AgentRpProjectionState['character'],
  meta: CharacterImportMeta,
  card: ImportedCharacterCard,
): { readonly character: AgentRpProjectionState['character']; readonly lorebookEntries: number } {
  const result = meta.result
  return {
    character: {
      characterName: card.nickname?.trim() || card.name,
      originalCharacterName: card.name,
      description: card.description.trim(),
      personality: card.personality.trim(),
      scenario: card.scenario.trim(),
      ...(result.userName === undefined ? {} : { userName: result.userName }),
      ...(previous.persona === undefined ? {} : { persona: previous.persona }),
      cardVersion: result.cardVersion,
      characterCardRaw: card.raw,
      ...(result.transport === 'png' ? { avatarAttachmentId: result.sourceAttachmentId } : {}),
      ...(result.transport === 'charx' && result.libraryId !== undefined ? { avatarLibraryId: result.libraryId } : {}),
      importedMessageCount: previous.importedMessageCount,
      frontend: card.frontend,
      source: 'character-card',
    },
    lorebookEntries: card.lorebook?.entries.length ?? 0,
  }
}

function mvuAfterTavernMutation(
  current: AgentRpProjectionState['mvu'],
  tavern: TavernHelperState,
): AgentRpProjectionState['mvu'] {
  const scope = tavern.lastMutation?.scope
  if (scope !== 'message' && scope !== 'chat') return current
  const statData = tavern.scopes[scope].stat_data
  if (statData === undefined || jsonObject(statData) === undefined) return current
  return {
    statData,
    updateCount: (current?.updateCount ?? 0) + 1,
  }
}

function cardLorebookSource(meta: CharacterImportMeta, card: ImportedCharacterCard): SessionLorebookSource | undefined {
  if (card.lorebook === undefined) return undefined
  return {
    id: `character:${meta.result.sourceAttachmentId}`,
    name: card.lorebook.name?.trim() || `${card.nickname?.trim() || card.name}的世界书`,
    source: 'character',
    lorebook: card.lorebook,
    degradations: card.degradations.filter(value => value.startsWith('lorebook-')),
  }
}

function worldInfoLorebookSource(
  meta: WorldInfoImportMeta,
  source: SessionLorebookSource['source'] = 'standalone',
): SessionLorebookSource {
  const worldInfo = JSON.parse(JSON.stringify(meta.raw)) as ImportedWorldInfo['raw']
  const parsed = parseWorldInfoJson(JSON.stringify(worldInfo))
  return {
    id: `${source}:${meta.result.sourceAttachmentId}`,
    name: meta.result.name,
    source,
    lorebook: parsed.lorebook,
    degradations: meta.result.degradations.filter(value => value !== 'entry-regex'),
  }
}

/**
 * Longest floor preview the panel needs. The list is re-sent on every
 * projection update, so it carries an excerpt rather than the body.
 */
const FLOOR_PREVIEW_LENGTH = 40

/**
 * How much of a floor is read to produce that excerpt. Folding whitespace over
 * the whole body to keep 40 characters makes the cost scale with message
 * length, which is exactly the shape of the `includesKey` regression: this runs
 * for every floor on every projection update. A bounded head still yields 40
 * characters unless the text is almost entirely whitespace, and the truncation
 * flag keeps the ellipsis correct even then.
 */
const FLOOR_PREVIEW_SCAN_LENGTH = FLOOR_PREVIEW_LENGTH * 8

function floorPreview(text: string): string {
  const truncated = text.length > FLOOR_PREVIEW_SCAN_LENGTH
  const head = truncated ? text.slice(0, FLOOR_PREVIEW_SCAN_LENGTH) : text
  const normalized = head.replace(/\s+/gu, ' ').trim()
  // Count code points so an excerpt never ends inside a surrogate pair.
  const points = Array.from(normalized)
  if (points.length > FLOOR_PREVIEW_LENGTH) return `${points.slice(0, FLOOR_PREVIEW_LENGTH).join('')}…`
  return truncated && normalized !== '' ? `${normalized}…` : normalized
}

let floorCacheSurface: AgentRpProjectionState['surface'] | undefined
let floorCacheHidden: TavernHelperState['hiddenPrefix']
let floorCacheValue: AgentRpProjection['floors'] | undefined

/**
 * Floor list for the visibility panel, recomputed only when the surface or the
 * hidden prefix actually changes.
 *
 * `applySurface` returns the very same array when an event carries no surface
 * operation, and a node's text is fixed once its event exists — a replacement
 * lands under a new seq. Reference identity is therefore an exact key, not an
 * approximation, and it costs nothing to compare. Without it this rebuilt every
 * floor on every appended event, streamed chunks included.
 * @param state - the projection state being viewed.
 * @param visible - surface floors already projected by the caller.
 * @returns the cached or freshly built floor list.
 */
function floorProjection(
  state: AgentRpProjectionState,
  visible: readonly { readonly seq: number; readonly role?: 'user' | 'assistant'; readonly text?: string }[],
): AgentRpProjection['floors'] {
  const hidden = state.tavern?.hiddenPrefix
  if (floorCacheValue !== undefined && floorCacheSurface === state.surface && floorCacheHidden === hidden) {
    return floorCacheValue
  }
  const floors = [
    ...(hidden ?? []).map(message => ({
      seq: message.seq, role: message.role, preview: floorPreview(message.text), hidden: true,
    })),
    ...visible.flatMap(message => message.text === undefined || message.role === undefined
      ? []
      : [{ seq: message.seq, role: message.role, preview: floorPreview(message.text), hidden: false }]),
  ]
  floorCacheSurface = state.surface
  floorCacheHidden = hidden
  floorCacheValue = floors
  return floors
}

function surfaceText(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user' && event.data.source.kind !== 'model') return undefined
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  if (event.type === 'assistant/message') {
    if (event.data.message.source.kind !== 'model') return undefined
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  return undefined
}

function surfaceReasoning(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message' || event.data.message.source.kind !== 'model') return undefined
  const blocks = event.data.message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : [])
  return blocks.length === 0 ? undefined : blocks.join('\n')
}

function surfaceRole(event: SessionEvent): 'user' | 'assistant' | undefined {
  if (event.type === 'user/message' && (event.data.source.kind === 'user' || event.data.source.kind === 'model')) return 'user'
  if (event.type === 'assistant/message' && event.data.message.source.kind === 'model') return 'assistant'
  return undefined
}

/**
 * Fold one Agent RP supersession into the projected surface.
 *
 * DSH 0.1.3 bars an Assistant message from replacing surface nodes, so a
 * rewrite appends and records the supersession separately. The projection must
 * reproduce what a positional `replace` did: drop the superseded floors and
 * move the replacements into the earliest superseded position, instead of
 * leaving them stranded at the tail.
 * @param surface - projected surface before this event.
 * @param event - the `agent-rp/surface-override` event.
 * @returns the surface with the supersession applied.
 */
/**
 * Fold the transcript anchor of each Agent RP replacement.
 *
 * The Host builds transcript rows from append-origin events, and DSH 0.1.3
 * forces Agent RP's replacements to be appends — so a regenerated reply now
 * owns its own row instead of quietly taking over the original one. Readers
 * that key off the anchor (the version switcher, `currentReplySeq`, the reply
 * a new generation targets) resolve a replacement's row back through this map.
 * Anchors resolve transitively, so a chain of regenerations still points at
 * the first reply's row.
 * @param anchors - map before this event.
 * @param event - the `agent-rp/surface-override` event.
 * @returns the map with this supersession recorded.
 */
/**
 * Fold the set of transcript rows an Agent RP replacement superseded.
 *
 * A superseded row is still append-origin, so the Host keeps rendering it; the
 * display planner hides it and renders on the replacement instead. Mirrors the
 * overlay fold: a replacement leaves the set when a later record supersedes it.
 * @param superseded - set before this event, in ascending seq order.
 * @param event - the `agent-rp/surface-override` event.
 * @returns the set with this supersession recorded.
 */
function applySupersededSeqs(
  superseded: AgentRpProjectionState['supersededSeqs'],
  event: SessionEvent,
): AgentRpProjectionState['supersededSeqs'] {
  if (event.type !== ('agent-rp/surface-override' as SessionEvent['type'])) return superseded
  const data = event.data as { readonly supersedes?: unknown; readonly replacements?: unknown }
  if (!Array.isArray(data.supersedes) || !Array.isArray(data.replacements)) return superseded
  const supersedes = data.supersedes.filter((seq): seq is number => typeof seq === 'number')
  const replacements = data.replacements.filter((seq): seq is number => typeof seq === 'number')
  if (supersedes.length === 0 || replacements.length === 0) return superseded
  const next = new Set(superseded)
  for (const seq of supersedes) next.add(seq)
  for (const seq of replacements) next.delete(seq)
  return [...next].sort((left, right) => left - right)
}

function applySurfaceAnchors(
  anchors: AgentRpProjectionState['surfaceAnchors'],
  event: SessionEvent,
): AgentRpProjectionState['surfaceAnchors'] {
  if (event.type !== ('agent-rp/surface-override' as SessionEvent['type'])) return anchors
  const data = event.data as { readonly supersedes?: unknown; readonly replacements?: unknown }
  if (!Array.isArray(data.supersedes) || !Array.isArray(data.replacements)) return anchors
  const supersedes = data.supersedes.filter((seq): seq is number => typeof seq === 'number')
  const replacements = data.replacements.filter((seq): seq is number => typeof seq === 'number')
  if (supersedes.length === 0 || replacements.length === 0) return anchors
  const earliest = Math.min(...supersedes)
  const anchor = anchors[String(earliest)] ?? earliest
  const next = { ...anchors }
  for (const seq of replacements) next[String(seq)] = anchor
  return next
}

function applySurfaceOverride(
  surface: AgentRpProjectionState['surface'],
  event: SessionEvent,
): AgentRpProjectionState['surface'] {
  const data = event.data as { readonly supersedes?: unknown; readonly replacements?: unknown }
  if (!Array.isArray(data.supersedes) || !Array.isArray(data.replacements)) return surface
  const superseded = new Set(data.supersedes.filter((seq): seq is number => typeof seq === 'number'))
  const replacements = data.replacements.filter((seq): seq is number => typeof seq === 'number')
  if (superseded.size === 0 || replacements.length === 0) return surface
  const moving = new Set(replacements)
  const moved = replacements.flatMap(seq => surface.filter(node => node.seq === seq))
  // A prompt-only rewrite never joins the visible surface, so its replacements
  // are absent here. Dropping the originals then would erase the row instead of
  // restating it — leave the visible transcript exactly as it was.
  if (moved.length === 0) return surface
  const next: AgentRpProjectionState['surface'][number][] = []
  let placed = false
  for (const node of surface) {
    if (superseded.has(node.seq)) {
      if (!placed) { next.push(...moved); placed = true }
      continue
    }
    if (moving.has(node.seq)) continue
    next.push(node)
  }
  if (!placed) next.push(...moved)
  return next
}

/**
 * Collect the surface rows one real `replace` dropped.
 *
 * A `replace` states that the shadowed range is no longer part of the
 * conversation at all. The DSH transcript is append-origin and keeps rendering
 * those rows, so the planner needs their seqs to take them off screen.
 * @param shadowed - seqs dropped by earlier replacements.
 * @param surface - surface as it stood before this event.
 * @param event - the next committed session event.
 * @returns the accumulated seqs, or the same reference when nothing changed.
 */
function applyShadowedSeqs(
  shadowed: readonly number[],
  surface: AgentRpProjectionState['surface'],
  event: SessionEvent,
): readonly number[] {
  if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') {
    return shadowed
  }
  // A prompt-regex view replaces a row for the MODEL only: the human still saw
  // the original and must keep seeing it, which is why `applySurface` skips
  // these events entirely. Counting their shadowed range here took the player's
  // own message off the screen the moment they sent it.
  const message = event.type === 'user/message' ? event.data : event.data.message
  if (event.type !== 'tool/result'
    && typeof (message.source as unknown as Record<string, unknown>)[PROMPT_REGEX_SOURCE_MARKER] === 'object') {
    return shadowed
  }
  const operation = event.surfaceOp
  if (operation === undefined || operation === 'append') return shadowed
  const start = surface.findIndex(value => value.seq === operation.startSeq)
  const end = surface.findIndex(value => value.seq === operation.endSeq)
  if (start < 0 || end < start) return shadowed
  const dropped = surface.slice(start, end + 1).map(value => value.seq)
  return dropped.length === 0 ? shadowed : [...shadowed, ...dropped]
}

function applySurface(
  surface: AgentRpProjectionState['surface'],
  event: SessionEvent,
): AgentRpProjectionState['surface'] {
  if (event.type === ('agent-rp/surface-override' as SessionEvent['type'])) {
    return applySurfaceOverride(surface, event)
  }
  if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') return surface
  const message = event.type === 'user/message' ? event.data : event.data.message
  if (event.type !== 'tool/result'
    && typeof (message.source as unknown as Record<string, unknown>)[PROMPT_REGEX_SOURCE_MARKER] === 'object') return surface
  const text = surfaceText(event)
  const reasoning = surfaceReasoning(event)
  const role = surfaceRole(event)
  const node = {
    seq: event.seq,
    ...(text === undefined ? {} : { text }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(role === undefined ? {} : { role }),
  }
  const operation = event.surfaceOp
  if (operation === undefined) return surface
  if (operation === 'append') return [...surface, node]
  const start = surface.findIndex(value => value.seq === operation.startSeq)
  const end = surface.findIndex(value => value.seq === operation.endSeq)
  if (start < 0 || end < start) return surface
  return [
    ...surface.slice(0, start),
    node,
    ...surface.slice(end + 1),
  ]
}

function promptRegexTrace(event: SessionEvent): AgentRpProjection['promptRegex'] | undefined {
  const source = event.type === 'user/message'
    ? event.data.source
    : event.type === 'assistant/message' ? event.data.message.source : undefined
  if (source === undefined) return undefined
  return readPromptRegexSourceMarker(
    (source as unknown as Record<string, unknown>)[PROMPT_REGEX_SOURCE_MARKER],
  )?.trace
}

let worldInfoCacheKey: string | undefined
let worldInfoCacheValue: AgentRpProjection['worldInfo'] | undefined

/**
 * Identity of every input the World Info view depends on, excluding the text of
 * the reply being streamed. A streamed reply grows one surface node in place,
 * so this signature is stable for the whole generation and changes at the turn
 * boundaries — the prompt is submitted, and the reply settles.
 * @param state - the projection state being viewed.
 * @returns a comparable signature string.
 */
function worldInfoCacheSignature(state: AgentRpProjectionState): string {
  return [
    state.worldInfoConfiguration.revision,
    state.worldInfoConfiguration.overrides.length,
    Object.keys(state.standaloneWorldInfos).join(','),
    state.cardLorebook === undefined ? 0 : 1,
    state.character.characterName,
    state.surface.length,
    state.currentReplySeq ?? -1,
    state.tavern === undefined ? 0 : 1,
  ].join('|')
}

/**
 * Activation view for the World Info panel, recomputed only when its inputs
 * change. The view is client-visible, so the Host drives it once per appended
 * event — including every streamed chunk — while a full activation pass walks
 * every key of every entry across the scan window. The prompt does not read
 * this view: `prepareRoleplayTurn` resolves lorebooks independently, so a panel
 * that settles at turn boundaries cannot change what the model receives.
 * @param state - the projection state being viewed.
 * @param ejsTemplateEngine - isolated template runtime, when available.
 * @returns the World Info activation view.
 */
function worldInfoProjection(
  state: AgentRpProjectionState,
  ejsTemplateEngine?: EjsTemplateEngine,
): AgentRpProjection['worldInfo'] {
  const signature = worldInfoCacheSignature(state)
  if (signature === worldInfoCacheKey && worldInfoCacheValue !== undefined) return worldInfoCacheValue
  worldInfoCacheKey = signature
  worldInfoCacheValue = worldInfoProjectionUncached(state, ejsTemplateEngine)
  return worldInfoCacheValue
}

function worldInfoProjectionUncached(
  state: AgentRpProjectionState,
  ejsTemplateEngine?: EjsTemplateEngine,
): AgentRpProjection['worldInfo'] {
  const sources = withTavernWorldbooks([
    ...(state.cardLorebook === undefined ? [] : [state.cardLorebook]),
    ...Object.values(state.standaloneWorldInfos),
  ], state.tavern)
  const messages = state.surface.flatMap(node => node.text === undefined ? [] : [node.text])
  const transcript = state.surface.flatMap(node => node.text === undefined || node.role === undefined
    ? []
    : [{ role: node.role, content: node.text }])
  const configuredSources = sources.map(source => ({ source, configured: configuredLorebook(source, state.worldInfoConfiguration) }))
  const characterWorldbook = characterWorldInfoBookName(sources, state.tavern)
  const identity = {
    characterName: state.character.characterName,
    userName: state.character.persona?.name ?? state.character.userName ?? '用户',
  }
  const templateOptions = ejsTemplateEngine === undefined ? {} : {
    regexEngine: ejsTemplateEngine,
    renderTemplate: ejsTemplateEngine.createRenderer({
      characterName: state.character.characterName,
      userName: state.character.persona?.name ?? state.character.userName ?? '用户',
      ...(characterWorldbook === undefined ? {} : { characterWorldInfoBookName: characterWorldbook }),
      replayTime: state.replayTime,
      messages,
      transcript,
      variableScopes: state.tavern?.scopes ?? {},
      ...(state.mvu === undefined ? {} : { statData: state.mvu.statData }),
      worldInfoBooks: createEjsWorldInfoBooks(configuredSources.map(({ source, configured }) => ({
        id: source.id,
        name: source.name,
        lorebook: configured.lorebook,
      }))),
    }),
    renderMacro: (content: string) => substituteSillyTavernIdentityMacros(
      substituteMvuMacros(content, state.mvu?.statData),
      identity,
    ),
  }
  let activeCount = 0
  const aggregateBudget = worldInfoTokenBudget(state.worldInfoConfiguration)
  const inspectedCollection = createNativeWorldEngine(templateOptions).evaluate({
    format: 0,
    books: configuredSources.map(({ source, configured }) => ({ id: source.id, lorebook: configured.lorebook })),
    messages,
    ...(aggregateBudget === undefined ? {} : { tokenBudget: aggregateBudget }),
  })
  const books = configuredSources.map(({ source, configured }, sourceIndex) => {
    const inspected = inspectedCollection.books[sourceIndex]!.inspected
    const overrides = new Map(state.worldInfoConfiguration.overrides
      .filter(item => item.bookId === source.id).map(item => [item.entryIndex, item]))
    return {
      id: source.id,
      name: source.name,
      source: source.source,
      ...(configured.lorebook.scanDepth === undefined ? {} : { scanDepth: configured.lorebook.scanDepth }),
      ...(source.lorebook.scanDepth === undefined ? {} : { fileScanDepth: source.lorebook.scanDepth }),
      scanDepthModified: worldInfoBookOverride(state.worldInfoConfiguration, source.id) !== undefined,
      // Removed books stay in the manager so they can be restored; they just
      // no longer reach the prompt.
      removed: (state.worldInfoConfiguration.removedBooks ?? []).includes(source.id),
      ...(source.lorebook.tokenBudget === undefined ? {} : { tokenBudget: source.lorebook.tokenBudget }),
      recursiveScanning: source.lorebook.recursiveScanning,
      degradations: source.degradations,
      entries: configured.lorebook.entries.map((entry, index) => {
        const decision = inspected.entries[index]!
        const override = overrides.get(index)
        const deleted = configured.deleted.has(index)
        if (decision.active && !deleted) activeCount += 1
        return {
          index,
          sourceId: entry.sourceId,
          ...editableWorldInfoEntry(entry),
          useRegex: entry.useRegex,
          hasDecorators: entry.hasDecorators,
          compatibilityBlockers: entry.compatibilityBlockers ?? [],
          active: decision.active && !deleted,
          reason: deleted ? 'deleted' as const : decision.reason,
          matchedKeys: decision.matchedKeys,
          matchedSecondaryKeys: decision.matchedSecondaryKeys,
          approximateTokens: decision.approximateTokens,
          ...(decision.template === undefined ? {} : { template: decision.template }),
          ...(decision.templateError === undefined ? {} : { templateError: decision.templateError }),
          modified: override?.entry !== undefined,
          deleted,
        }
      }),
    }
  })
  const entryReasons = books.flatMap(book => book.entries.map(entry => entry.reason))
  return {
    revision: state.worldInfoConfiguration.revision,
    activeCount,
    ...(aggregateBudget === undefined ? {} : { tokenBudget: aggregateBudget }),
    approximateTokens: inspectedCollection.approximateTokens,
    budgetExcludedCount: inspectedCollection.books.flatMap(book => book.inspected.entries)
      .filter(entry => entry.reason === 'session-budget-excluded').length,
    failureCounts: summarizeWorldEngineFailures(entryReasons),
    books,
  }
}

function toolCallId(event: Extract<SessionEvent, { type: 'tool/result' }>): string | undefined {
  // DSH 0.2.0 carries both on the tool-role message instead of inside a
  // `tool-result` block, so a result without content still identifies its call.
  return String(event.data.message.toolCallId)
}

function toolFailed(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  return event.data.message.isError === true
}

function parseCharacterMeta(value: JsonValue | undefined): CharacterImportMeta | undefined {
  const meta = jsonObject(value)
  const result = jsonObject(meta?.result)
  if (meta?.format !== 0 || result?.version !== 0 || meta.raw === undefined
    || typeof result.name !== 'string'
    || (result.cardVersion !== 1 && result.cardVersion !== 2 && result.cardVersion !== 3)
    || typeof result.sourceAttachmentId !== 'string'
    || (result.transport !== 'png' && result.transport !== 'json')) return undefined
  return value as unknown as CharacterImportMeta
}

function parseWorldInfoMeta(value: JsonValue | undefined): WorldInfoImportMeta | undefined {
  const meta = jsonObject(value)
  const result = jsonObject(meta?.result)
  if (meta?.format !== 0 || result?.version !== 0 || meta.raw === undefined
    || typeof result.sourceAttachmentId !== 'string'
    || typeof result.entryCount !== 'number' || !Number.isSafeInteger(result.entryCount)
    || result.entryCount < 0) return undefined
  return value as unknown as WorldInfoImportMeta
}

function parsePresetMeta(value: JsonValue | undefined): PresetImportMeta | undefined {
  const meta = jsonObject(value)
  const result = jsonObject(meta?.result)
  const preset = jsonObject(meta?.preset)
  if (meta?.format !== 0 || result?.version !== 0 || preset?.format !== 0
    || typeof result.name !== 'string'
    || typeof result.promptCount !== 'number' || !Number.isSafeInteger(result.promptCount)
    || typeof result.enabledCount !== 'number' || !Number.isSafeInteger(result.enabledCount)
    || typeof result.regexScriptCount !== 'number' || !Number.isSafeInteger(result.regexScriptCount)) return undefined
  return value as unknown as PresetImportMeta
}

function presetProjection(
  name: string,
  preset: ImportedSillyTavernPreset,
  revision: number,
  importedPreset: ImportedSillyTavernPreset = preset,
  libraryId?: string,
): NonNullable<AgentRpProjection['preset']> {
  const generation = preset.generation
  const enabled = new Set(preset.order.filter(entry => entry.enabled).map(entry => entry.identifier))
  const promptsById = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]))
  const importedPromptsById = new Map(importedPreset.prompts.map(prompt => [prompt.identifier, prompt]))
  const importedOrderById = new Map(importedPreset.order.map((entry, position) => [entry.identifier, { ...entry, position }]))
  const regexScripts = presetRegexScripts(preset)
  const helperScripts = presetTavernHelperScripts(preset)
  const compatibility = preset.extensionCompatibility
  const appliedGeneration = [
    generation.temperature === undefined ? undefined : 'temperature',
    generation.maxTokens === undefined ? undefined : 'maxTokens（受模型上限约束）',
    generation.reasoningEffort === undefined || generation.reasoningEffort === 'auto'
      ? undefined : 'reasoningEffort（按当前模型能力）',
  ].filter((value): value is string => value !== undefined)
  const preservedGeneration = [
    generation.topP === undefined ? undefined : 'top_p',
    generation.topK === undefined ? undefined : 'top_k',
    generation.topA === undefined ? undefined : 'top_a',
    generation.minP === undefined ? undefined : 'min_p',
    generation.frequencyPenalty === undefined ? undefined : 'frequency_penalty',
    generation.presencePenalty === undefined ? undefined : 'presence_penalty',
    generation.repetitionPenalty === undefined ? undefined : 'repetition_penalty',
    generation.reasoningEffort === 'auto' ? 'reasoning_effort（auto，跟随模型）' : undefined,
  ].filter((value): value is string => value !== undefined)
  const extensionStatus: NonNullable<AgentRpProjection['preset']>['extensionStatus'] = compatibility === undefined
    ? [
        preset.extensionSummary.hasSPreset ? {
          name: 'SPreset', detail: '旧导入未记录子功能状态，需重新导入后核对', state: 'unsupported' as const,
        } : undefined,
        preset.extensionSummary.hasTavernHelper ? {
          name: 'Tavern Helper', detail: '旧导入未记录脚本状态，需重新导入后核对', state: 'unsupported' as const,
        } : undefined,
      ].filter((value): value is NonNullable<typeof value> => value !== undefined)
    : [
    compatibility?.macroNestEnabled === undefined ? undefined : {
      name: '嵌套宏',
      detail: compatibility.macroNestEnabled
        ? '已由 Agent RP 组装器执行'
        : '原预设未启用',
      state: compatibility.macroNestEnabled ? 'active' as const : 'inactive' as const,
    },
    compatibility?.chatSquashEnabled === undefined ? undefined : {
      name: 'Chat Squash',
      detail: compatibility.chatSquashEnabled
        ? '原预设已启用，当前 Host 尚未执行'
        : '原预设已关闭，无需执行',
      state: compatibility.chatSquashEnabled ? 'unsupported' as const : 'inactive' as const,
    },
    compatibility?.regexBindingEnabled === undefined ? undefined : {
      name: '预设正则绑定',
      detail: compatibility.regexBindingEnabled
        ? '绑定扩展已启用；当前仅执行预设自带正则'
        : compatibility.regexBindingMatchesPresetScripts === true
          ? '绑定扩展已关闭；同一批预设正则已由 Agent RP 接管'
          : '原预设已关闭，无需执行',
      state: compatibility.regexBindingEnabled ? 'unsupported' as const
        : compatibility.regexBindingMatchesPresetScripts === true ? 'active' as const : 'inactive' as const,
    },
    compatibility?.tavernHelperScriptCount === undefined ? undefined : {
      name: 'Tavern Helper 脚本',
      detail: [
        compatibility.tavernHelperFormat === 'entries' ? '条目数组'
          : compatibility.tavernHelperFormat === 'object' ? '对象格式' : undefined,
        `${helperScripts.filter(script => script.enabled).length}/${helperScripts.length} 个脚本接管`,
        compatibility.tavernHelperVariableCount === undefined
          ? undefined : `${compatibility.tavernHelperVariableCount} 个变量`,
        compatibility.tavernHelperIgnoredFieldCount === undefined || compatibility.tavernHelperIgnoredFieldCount === 0
          ? undefined : `${compatibility.tavernHelperIgnoredFieldCount} 个扩展字段未接管`,
      ].filter((value): value is string => value !== undefined).join(' · '),
      state: helperScripts.some(script => script.enabled) ? 'active' as const : 'inactive' as const,
    },
      ].filter((value): value is NonNullable<typeof value> => value !== undefined)
  return {
    ...(libraryId === undefined ? {} : { libraryId }),
    name,
    promptCount: preset.prompts.length,
    enabledCount: preset.prompts.filter(prompt => enabled.has(prompt.identifier)).length,
    revision,
    prompts: [...preset.order.flatMap((entry) => {
      const prompt = promptsById.get(entry.identifier)
      return prompt === undefined ? [] : [{
        ...(() => {
          const importedPrompt = importedPromptsById.get(prompt.identifier)
          return {
            imported: importedPrompt !== undefined,
            importedName: importedPrompt?.name ?? prompt.name,
            importedRole: importedPrompt?.role ?? prompt.role,
            ...(importedPrompt?.injectionPosition === undefined ? {} : { importedInjectionPosition: importedPrompt.injectionPosition }),
            ...(importedPrompt?.injectionDepth === undefined ? {} : { importedInjectionDepth: importedPrompt.injectionDepth }),
            ...(importedPrompt?.injectionOrder === undefined ? {} : { importedInjectionOrder: importedPrompt.injectionOrder }),
          }
        })(),
        identifier: prompt.identifier,
        name: prompt.name,
        role: prompt.role,
        content: prompt.content,
        importedContent: importedPromptsById.get(prompt.identifier)?.content ?? prompt.content,
        contentModified: prompt.content !== importedPromptsById.get(prompt.identifier)?.content,
        importedAttached: importedOrderById.has(prompt.identifier),
        importedEnabled: importedOrderById.get(prompt.identifier)?.enabled ?? false,
        ...(importedOrderById.get(prompt.identifier) === undefined ? {} : { importedPosition: importedOrderById.get(prompt.identifier)!.position }),
        marker: prompt.marker,
        systemPrompt: prompt.systemPrompt,
        forbidOverrides: prompt.forbidOverrides,
        ...(prompt.injectionPosition === undefined ? {} : { injectionPosition: prompt.injectionPosition }),
        ...(prompt.injectionDepth === undefined ? {} : { injectionDepth: prompt.injectionDepth }),
        ...(prompt.injectionOrder === undefined ? {} : { injectionOrder: prompt.injectionOrder }),
        attached: true,
        enabled: entry.enabled,
        toggleable: canTogglePresetPrompt(preset, prompt.identifier),
        editable: canEditPresetPrompt(preset, prompt.identifier),
        deletable: !prompt.systemPrompt && !prompt.marker,
      }]
    }), ...preset.prompts.filter(prompt => !preset.order.some(entry => entry.identifier === prompt.identifier)).map(prompt => ({
      ...(() => {
        const importedPrompt = importedPromptsById.get(prompt.identifier)
        return {
          imported: importedPrompt !== undefined,
          importedName: importedPrompt?.name ?? prompt.name,
          importedRole: importedPrompt?.role ?? prompt.role,
          ...(importedPrompt?.injectionPosition === undefined ? {} : { importedInjectionPosition: importedPrompt.injectionPosition }),
          ...(importedPrompt?.injectionDepth === undefined ? {} : { importedInjectionDepth: importedPrompt.injectionDepth }),
          ...(importedPrompt?.injectionOrder === undefined ? {} : { importedInjectionOrder: importedPrompt.injectionOrder }),
        }
      })(),
      identifier: prompt.identifier,
      name: prompt.name,
      role: prompt.role,
      content: prompt.content,
      importedContent: importedPromptsById.get(prompt.identifier)?.content ?? prompt.content,
      contentModified: prompt.content !== importedPromptsById.get(prompt.identifier)?.content,
      importedAttached: importedOrderById.has(prompt.identifier),
      importedEnabled: importedOrderById.get(prompt.identifier)?.enabled ?? false,
      ...(importedOrderById.get(prompt.identifier) === undefined ? {} : { importedPosition: importedOrderById.get(prompt.identifier)!.position }),
      marker: prompt.marker,
      systemPrompt: prompt.systemPrompt,
      forbidOverrides: prompt.forbidOverrides,
      ...(prompt.injectionPosition === undefined ? {} : { injectionPosition: prompt.injectionPosition }),
      ...(prompt.injectionDepth === undefined ? {} : { injectionDepth: prompt.injectionDepth }),
      ...(prompt.injectionOrder === undefined ? {} : { injectionOrder: prompt.injectionOrder }),
      attached: false,
      enabled: false,
      toggleable: canTogglePresetPrompt(preset, prompt.identifier),
      editable: canEditPresetPrompt(preset, prompt.identifier),
      deletable: !prompt.systemPrompt && !prompt.marker,
    }))],
    generation: {
      ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
      ...(generation.maxTokens === undefined ? {} : { maxTokens: generation.maxTokens }),
      ...(generation.reasoningEffort === undefined ? {} : { reasoningEffort: generation.reasoningEffort }),
      ...(generation.topP === undefined ? {} : { topP: generation.topP }),
      ...(generation.topK === undefined ? {} : { topK: generation.topK }),
      ...(generation.topA === undefined ? {} : { topA: generation.topA }),
      ...(generation.minP === undefined ? {} : { minP: generation.minP }),
      ...(generation.frequencyPenalty === undefined ? {} : { frequencyPenalty: generation.frequencyPenalty }),
      ...(generation.presencePenalty === undefined ? {} : { presencePenalty: generation.presencePenalty }),
      ...(generation.repetitionPenalty === undefined ? {} : { repetitionPenalty: generation.repetitionPenalty }),
    },
    formats: { ...preset.formats },
    degradedRoleCount: 0,
    preservedInChatCount: preset.prompts.filter(prompt => enabled.has(prompt.identifier) && prompt.injectionPosition === 1).length,
    regexScriptCount: preset.extensionSummary.regexScriptCount,
    enabledRegexScriptCount: regexScripts.filter(script => !script.disabled).length,
    activeDisplayRegexCount: regexScripts.filter(script => !script.disabled && script.markdownOnly).length,
    preservedPromptRegexCount: regexScripts.filter(script => !script.disabled
      && (!script.markdownOnly || script.promptOnly)).length,
    regexScripts: regexScripts.map((script, index) => ({ ...script, index })),
    tavernHelperScripts: helperScripts,
    tavernHelperVariables: preset.tavernHelperVariables ?? {},
    appliedGeneration,
    preservedGeneration,
    omittedExtensions: [
      preset.extensionSummary.hasSPreset ? 'SPreset' : undefined,
      preset.extensionSummary.hasTavernHelper ? 'Tavern Helper' : undefined,
    ].filter((value): value is string => value !== undefined),
    extensionStatus,
  }
}

function withoutCall(
  calls: Readonly<Record<string, ImportCall>>,
  callId: string,
): Readonly<Record<string, ImportCall>> {
  return Object.fromEntries(Object.entries(calls).filter(([id]) => id !== callId))
}

type AgentRpProjectionDefinition = ProjectionDefinition<'agentRp', AgentRpProjectionState> & {
  readonly wire: NonNullable<ProjectionDefinition<'agentRp', AgentRpProjectionState>['wire']>
  /** DSH rc.8 projection contract; retained beside `stateSchema`/`wire` for newer Hosts. */
  readonly schema: typeof projectionSchema
  readonly preload: false
  readonly view: (state: AgentRpProjectionState) => AgentRpProjection
}

/**
 * Pure fold for one committed event.
 *
 * Returns the very same state when the event changes nothing, which is what
 * the projection contract asks for: an unchanged reference produces zero
 * downstream work — no view, no schema validation, no wire payload. The
 * `replayTime` stamp is deliberately NOT applied here; see `apply`.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
function foldAgentRpProjectionEvent(
  state: AgentRpProjectionState,
  event: SessionEvent,
): AgentRpProjectionState {
  // Reads the surface as it stood BEFORE this event, so it must run first.
  const shadowedSeqs = applyShadowedSeqs(state.shadowedSeqs, state.surface, event)
  const surface = applySurface(state.surface, event)
  const surfaceAnchors = applySurfaceAnchors(state.surfaceAnchors, event)
  const supersededSeqs = applySupersededSeqs(state.supersededSeqs, event)
  const auxiliaryGenerations = applyTavernAuxiliaryGenerationEvent(state.auxiliaryGenerations, event)
  const withSurface = surface === state.surface && auxiliaryGenerations === state.auxiliaryGenerations
    && surfaceAnchors === state.surfaceAnchors && supersededSeqs === state.supersededSeqs
    && shadowedSeqs === state.shadowedSeqs
    ? state
    : { ...state, surface, surfaceAnchors, supersededSeqs, shadowedSeqs, auxiliaryGenerations }
  const tavernMessageAnnotations = applyTavernMessageAnnotationEvent(withSurface.tavernMessageAnnotations, event)
  if (tavernMessageAnnotations !== withSurface.tavernMessageAnnotations) {
    return { ...withSurface, tavernMessageAnnotations }
  }
  if (event.type === 'agent-rp/turn-mode') {
    return { ...withSurface, turnMode: parseRoleplayTurnModeRecord(event.data).mode }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let regexConfiguration
    try {
      regexConfiguration = decodeRegexConfiguration(event.data.text)
    } catch {
      regexConfiguration = undefined
    }
    if (regexConfiguration !== undefined) return { ...withSurface, regexConfiguration }
  }
  if (event.type === 'agent-rp/regex-pack-seed') {
    try {
      const pack = parseSessionRegexPack(event.data)
      if (withSurface.regexPacks.some(existing => existing.id === pack.id)) return withSurface
      return { ...withSurface, regexPacks: [...withSurface.regexPacks, pack] }
    } catch {
      return withSurface
    }
  }
  if (event.type === 'agent-rp/mvu-state') return { ...withSurface, mvu: event.data }
  if (event.type === 'agent-rp/staged-state-request' || event.type === 'agent-rp/staged-state-result'
    || (event.type === 'agent-rp/turn-worker-result' && event.data.workerId === 'state-settlement')) {
    const kind = event.type === 'agent-rp/staged-state-request' ? 'request' as const
      : event.type === 'agent-rp/staged-state-result' ? 'result' as const : 'worker' as const
    // A result carries no turn of its own; it is matched to its request by seq.
    const turn = kind === 'result' ? -1 : Number((event.data as { turn?: unknown }).turn ?? -1)
    const entry = { seq: event.seq, kind, turn, data: event.data as unknown as JsonValue }
    // Only the newest turn is ever displayed, so the trail stays bounded.
    const trail = [...withSurface.stateSettlementTrail, entry].slice(-40)
    return { ...withSurface, stateSettlementTrail: trail }
  }
  if (event.type === 'agent-rp/state-scheme-seed') {
    try {
      return { ...withSurface, stateScheme: parseRoleplayStateScheme(event.data) }
    } catch {
      return withSurface
    }
  }
  if (event.type === 'agent-rp/world-info-library-seed') {
    try {
      const semantics = worldInfoLibrarySeedSemantics(event)
      const meta = parseWorldInfoImportMeta(event.data.meta as unknown as JsonValue)
      const source = worldInfoLorebookSource(
        meta,
        semantics.placement === 'actor' ? 'character' : 'standalone',
      )
      const provisionalLibraryCardLorebook = semantics.placement === 'actor'
        && withSurface.character.avatarLibraryId !== undefined
        && withSurface.cardLorebook?.id === `character:library:${withSurface.character.avatarLibraryId}`
      const existingCharacterSources = [
        ...(withSurface.cardLorebook === undefined || provisionalLibraryCardLorebook
          ? []
          : [withSurface.cardLorebook]),
        ...Object.values(withSurface.standaloneWorldInfos).filter(item => item.source === 'character'),
      ]
      const primaryActorWorld = semantics.placement === 'actor' && existingCharacterSources.length === 0
      const standaloneWorldInfos = primaryActorWorld
        ? withSurface.standaloneWorldInfos
        : { ...withSurface.standaloneWorldInfos, [meta.result.sourceAttachmentId]: source }
      const lorebookSources = [
        ...(primaryActorWorld
          ? [source]
          : withSurface.cardLorebook === undefined ? [] : [withSurface.cardLorebook]),
        ...Object.values(standaloneWorldInfos),
      ]
      const mvu = readCurrentMvuStateFromLorebooks(lorebookSources.map(item => item.lorebook), [])
      const { mvu: _previousMvu, ...withoutMvu } = withSurface
      return {
        ...withoutMvu,
        standaloneWorldInfos,
        ...(primaryActorWorld ? {
          cardLorebook: source,
          cardWorldInfoCount: source.lorebook.entries.length,
        } : semantics.placement === 'actor' ? {
          cardWorldInfoCount: withSurface.cardWorldInfoCount + source.lorebook.entries.length,
        } : {}),
        ...(mvu === undefined ? {} : { mvu }),
      }
    } catch {
      return withSurface
    }
  }
  const nativeStates = applyRoleplayStateEvent(withSurface.nativeStates, event)
  if (nativeStates !== withSurface.nativeStates) return { ...withSurface, nativeStates }
  if (event.type === 'agent-rp/turn-presentation') {
    const presentation = normalizeRoleplayTurnPresentation(event.data)
    return presentation.current ? { ...withSurface, presentation } : withSurface
  }
  const trace = promptRegexTrace(event)
  if (trace !== undefined) return { ...withSurface, promptRegex: trace }
  if (event.type === 'command/run' && event.data.name === 'rp-persona') {
    return {
      ...withSurface,
      personaCommands: { ...withSurface.personaCommands, [String(event.data.commandId)]: event.seq },
    }
  }
  if (event.type === 'command/done') {
    const commandId = String(event.data.commandId)
    const sourceEventSeq = withSurface.personaCommands[commandId]
    if (sourceEventSeq !== undefined) {
      const { [commandId]: _completed, ...personaCommands } = withSurface.personaCommands
      if (event.data.kind !== 'success') return { ...withSurface, personaCommands }
      try {
        const record = decodePersonaCommandRecord(event.data.text)
        if (record === undefined || record.sourceEventSeq !== sourceEventSeq) {
          return { ...withSurface, personaCommands }
        }
        const { persona: _persona, userName: _userName, ...character } = withSurface.character
        return {
          ...withSurface,
          personaCommands,
          character: {
            ...character,
            ...(record.persona === undefined ? {} : { persona: record.persona, userName: record.persona.name }),
            ...(record.persona !== undefined || record.fallbackUserName === undefined
              ? {}
              : { userName: record.fallbackUserName }),
          },
        }
      } catch {
        return { ...withSurface, personaCommands }
      }
    }
  }
  if (event.type === 'agent-rp/tavern-state' || event.type === 'agent-rp/tavern-state-attachment'
    || (event.type === 'command/done' && event.data.kind === 'success')) {
    try {
      const tavern = event.type === 'agent-rp/tavern-state'
        ? event.data
        : event.type === 'agent-rp/tavern-state-attachment'
          ? event.data.active ? event.data.state : undefined
          : decodeActiveTavernHelperState(event.data.text)
      if (tavern !== undefined) {
        const mvu = mvuAfterTavernMutation(withSurface.mvu, tavern)
        return {
          ...withSurface,
          tavern,
          ...(mvu === undefined ? {} : { mvu }),
        }
      }
    } catch {
      return withSurface
    }
  }
  const generation = event.type === 'command/done' && event.data.kind === 'success'
    ? decodeGenerationState(event.data.text)
    : event.type === ('agent-rp/generation-state' as SessionEvent['type'])
      ? (event as SessionEvent & { readonly data: GenerationStateRecord }).data
      : undefined
  if (generation !== undefined) {
    return {
      ...withSurface,
      ...(generation.mvu === undefined ? {} : { mvu: generation.mvu }),
      generations: { ...state.generations, [generation.groupId]: generation },
      currentReplySeq: generation.anchorSeq,
    }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let directWorldInfo: { readonly key: string; readonly source: SessionLorebookSource } | undefined
    try {
      const record = decodeWorldInfoLibraryImport(event.data.text)
      if (record !== undefined) {
        const meta = parseWorldInfoImportMeta(record.meta)
        directWorldInfo = { key: meta.result.sourceAttachmentId, source: worldInfoLorebookSource(meta) }
      }
    } catch {
      return withSurface
    }
    if (directWorldInfo !== undefined) {
      return {
        ...withSurface,
        standaloneWorldInfos: {
          ...withSurface.standaloneWorldInfos,
          [directWorldInfo.key]: directWorldInfo.source,
        },
      }
    }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let worldInfoConfiguration
    try {
      worldInfoConfiguration = decodeWorldInfoConfiguration(event.data.text)
    } catch {
      return withSurface
    }
    if (worldInfoConfiguration !== undefined) return { ...withSurface, worldInfoConfiguration }
  }
  if (event.type === 'agent-rp/persona-seed') {
    try {
      const persona = parseSessionPersona(event.data.persona)
      return {
        ...withSurface,
        character: { ...withSurface.character, userName: persona.name, persona },
      }
    } catch {
      return withSurface
    }
  }
  if (event.type === 'agent-rp/sillytavern-chat-import') {
    const identity = readSillyTavernChatIdentity([event])
    return {
      ...withSurface,
      character: {
        ...withSurface.character,
        ...(withSurface.character.source === 'preset' && identity !== undefined
          ? { characterName: identity.characterName, source: 'sillytavern-chat' as const }
          : {}),
        ...(identity?.userName === undefined ? {} : { userName: identity.userName }),
        importedMessageCount: event.data.messages.length,
      },
    }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let chat: SillyTavernChatCommandRecord | undefined
    let launch: CharacterLibraryLaunchRecord | undefined
    try {
      launch = decodeCharacterLibraryLaunch(event.data.text)
      chat = decodeSillyTavernChatCommandRecord(event.data.text) ?? launch?.chat
    } catch {
      return withSurface
    }
    if (chat !== undefined) {
      const withChat = {
        ...withSurface,
        character: {
          ...withSurface.character,
          ...(withSurface.character.source === 'preset' && chat.characterName !== undefined
            ? { characterName: chat.characterName, source: 'sillytavern-chat' as const }
            : {}),
          ...(chat.userName === undefined ? {} : { userName: chat.userName }),
          importedMessageCount: chat.messageCount,
        },
      }
      if (launch === undefined) return withChat
      const card = parseCharacterCardValue(launch.meta.raw)
      const projected = cardProjection(withChat.character, launch.meta, card)
      const { avatarAttachmentId: _avatarAttachmentId, ...libraryCharacter } = projected.character
      const cardLorebook = cardLorebookSource(launch.meta, card)
      const { cardLorebook: _previousLorebook, ...withoutCardLorebook } = withChat
      return {
        ...withoutCardLorebook,
        character: {
          ...libraryCharacter,
          avatarLibraryId: launch.libraryId,
          ...(launch.persona === undefined ? {} : { persona: launch.persona }),
        },
        cardWorldInfoCount: projected.lorebookEntries,
        ...(cardLorebook === undefined ? {} : { cardLorebook }),
        mvu: readCurrentMvuState(card, []),
        tavern: initializeTavernHelperState(card.frontend, launch.meta.result.sourceAttachmentId, withChat.tavern),
      }
    }
  }
  if (event.type === 'agent-rp/character-card-seed') {
    const card = parseCharacterCardValue(event.data.meta.raw)
    const projected = cardProjection(withSurface.character, event.data.meta, card)
    const libraryId = 'characterLibraryId' in event.data.source
      ? event.data.source.characterLibraryId
      : undefined
    const cardLorebook = cardLorebookSource(event.data.meta, card)
    const mvu = readCurrentMvuState(card, [])
    const {
      cardLorebook: _previousLorebook,
      mvu: _previousMvu,
      ...withoutCardLorebook
    } = withSurface
    return {
      ...withoutCardLorebook,
      character: libraryId === undefined
        ? projected.character
        : { ...projected.character, avatarLibraryId: libraryId },
      cardWorldInfoCount: projected.lorebookEntries,
      ...(cardLorebook === undefined ? {} : { cardLorebook }),
      ...(mvu === undefined ? {} : { mvu }),
      tavern: initializeTavernHelperState(card.frontend, event.data.meta.result.sourceAttachmentId, withSurface.tavern),
    }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let launch
    try {
      launch = decodeCharacterLibraryLaunch(event.data.text)
    } catch {
      return withSurface
    }
    if (launch !== undefined) {
      const card = parseCharacterCardValue(launch.meta.raw)
      const projected = cardProjection(withSurface.character, launch.meta, card)
      const { avatarAttachmentId: _avatarAttachmentId, ...libraryCharacter } = projected.character
      const cardLorebook = cardLorebookSource(launch.meta, card)
      const { cardLorebook: _previousLorebook, ...withoutCardLorebook } = withSurface
      return {
        ...withoutCardLorebook,
        character: {
          ...libraryCharacter,
          avatarLibraryId: launch.libraryId,
          ...(launch.persona === undefined ? {} : { persona: launch.persona }),
        },
        cardWorldInfoCount: projected.lorebookEntries,
        ...(cardLorebook === undefined ? {} : { cardLorebook }),
        mvu: readCurrentMvuState(card, []),
        tavern: initializeTavernHelperState(card.frontend, launch.meta.result.sourceAttachmentId, withSurface.tavern),
      }
    }
  }
  if (event.type === 'agent-rp/sillytavern-preset-seed') {
    const presetState = {
      result: event.data.result,
      importedPreset: event.data.preset,
      preset: event.data.preset,
      revision: 0,
      ...(event.data.libraryId === undefined ? {} : { libraryId: event.data.libraryId }),
    }
    return {
      ...withSurface,
      preset: presetProjection(event.data.result.name, event.data.preset, 0, event.data.preset, event.data.libraryId),
      presetState,
      ...(withSurface.tavern === undefined ? {} : {
        tavern: initializeTavernHelperPresetState(
          withSurface.tavern,
          presetTavernHelperScripts(event.data.preset),
          event.data.preset.tavernHelperVariables ?? {},
          event.data.result.sourceAttachmentId,
        ),
      }),
    }
  }
  if (event.type === 'command/done' && event.data.kind === 'success') {
    let library
    try {
      library = parsePresetLibraryResult(event.data.text)
    } catch {
      return withSurface
    }
    if (library === undefined) return withSurface
    if (library.selected !== undefined) {
      const selected = library.selected
      const presetState: ActiveSessionPreset = {
        result: {
          version: 0,
          name: selected.name,
          sourceEventSeq: event.seq,
          sourceAttachmentId: `library:${selected.libraryId}`,
          promptCount: selected.preset.prompts.length,
          enabledCount: selected.preset.order.filter(item => item.enabled).length,
          regexScriptCount: selected.preset.extensionSummary.regexScriptCount,
        },
        importedPreset: selected.preset,
        preset: selected.preset,
        revision: 0,
        libraryId: selected.libraryId,
      }
      return {
        ...withSurface,
        presetLibrary: library.entries,
        preset: presetProjection(selected.name, selected.preset, 0, selected.preset, selected.libraryId),
        presetState,
        ...(withSurface.tavern === undefined ? {} : {
          tavern: initializeTavernHelperPresetState(
            withSurface.tavern,
            presetTavernHelperScripts(selected.preset),
            selected.preset.tavernHelperVariables ?? {},
            `library:${selected.libraryId}`,
          ),
        }),
      }
    }
    if (withSurface.preset === undefined || withSurface.presetState === undefined || library.linkedLibraryId === undefined) {
      return { ...withSurface, presetLibrary: library.entries }
    }
    return {
      ...withSurface,
      presetLibrary: library.entries,
      preset: { ...withSurface.preset, libraryId: library.linkedLibraryId },
      presetState: { ...withSurface.presetState, libraryId: library.linkedLibraryId },
    }
  }
  if (event.type === 'command/run' && event.data.name === 'rp-preset-configure' && event.data.args !== undefined) {
    if (withSurface.preset === undefined || withSurface.presetState === undefined) return withSurface
    try {
      const configured = configurePreset(withSurface.presetState, parsePresetConfigurationRequest(event.data.args))
      const revision = withSurface.presetState.revision + 1
      return {
        ...withSurface,
        preset: presetProjection(
          withSurface.preset.name,
          configured,
          revision,
          withSurface.presetState.importedPreset,
          withSurface.presetState.libraryId,
        ),
        presetState: { ...withSurface.presetState, preset: configured, revision },
      }
    } catch {
      return withSurface
    }
  }
  // DSH 0.2.0 carries the rendered system prompt as a surface node instead of a
  // header field. Fold the latest one so the header below can still report the
  // prompt that request was assembled with.
  if ((event.type as string) === 'system/message') {
    // Read structurally: the event type is absent from the map on Hosts that
    // predate it, and only its text blocks matter here.
    const blocks = (event as {
      readonly data: { readonly message: { readonly content: readonly { readonly type: string; readonly text?: string }[] } }
    }).data.message.content
    return {
      ...withSurface,
      systemPrompt: blocks.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n'),
    }
  }
  if (event.type === 'request/header') {
    const config = event.data.header.config
    return {
      ...withSurface,
      lastRequest: {
        eventSeq: event.seq,
        time: event.time,
        ...(withSurface.presetState === undefined ? {} : {
          presetName: withSurface.presetState.result.name,
          presetRevision: withSurface.presetState.revision,
        }),
        system: withSurface.systemPrompt,
        config: {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          ...(config.stop === undefined ? {} : { stop: config.stop }),
        },
        toolNames: event.data.header.tools?.map(tool => tool.name) ?? [],
      },
    }
  }
  if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    const nextState = text.trim() === '' ? withSurface : { ...withSurface, currentReplySeq: event.seq }
    if (withSurface.mvu === undefined || !/<UpdateVariable(?:variable)?>/iu.test(text)) return nextState
    try {
      const update = applyMvuReply(withSurface.mvu.statData, text)
      return update === undefined ? nextState : {
        ...nextState,
        mvu: {
          statData: update.statData,
          updateCount: withSurface.mvu.updateCount + 1,
        },
      }
    } catch (error: unknown) {
      return {
        ...nextState,
        mvu: {
          ...withSurface.mvu,
          lastError: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }
  if (event.type === 'tool/call') {
    const kind = event.data.name === 'import_character_card'
      ? 'character-card'
      : event.data.name === 'import_world_info' ? 'world-info'
        : event.data.name === 'import_sillytavern_preset' ? 'preset' : undefined
    return kind === undefined
      ? withSurface
      : { ...withSurface, calls: { ...withSurface.calls, [String(event.data.callId)]: kind } }
  }
  if (event.type !== 'tool/result') return withSurface
  const callId = toolCallId(event)
  if (callId === undefined) return withSurface
  const kind = withSurface.calls[callId]
  if (kind === undefined) return withSurface
  const calls = withoutCall(withSurface.calls, callId)
  if (toolFailed(event)) return { ...withSurface, calls }
  if (kind === 'character-card') {
    const meta = parseCharacterMeta(event.data.meta)
    if (meta === undefined) return { ...withSurface, calls }
    const card = parseCharacterCardValue(meta.raw)
    const projected = cardProjection(withSurface.character, meta, card)
    const cardLorebook = cardLorebookSource(meta, card)
    const { cardLorebook: _previousLorebook, ...withoutCardLorebook } = withSurface
    return {
      ...withoutCardLorebook,
      calls,
      character: projected.character,
      cardWorldInfoCount: projected.lorebookEntries,
      ...(cardLorebook === undefined ? {} : { cardLorebook }),
      mvu: readCurrentMvuState(card, []),
      tavern: initializeTavernHelperState(card.frontend, meta.result.sourceAttachmentId, withSurface.tavern),
    }
  }
  if (kind === 'preset') {
    const meta = parsePresetMeta(event.data.meta)
    return meta === undefined
      ? { ...withSurface, calls }
      : {
          ...withSurface,
          calls,
          preset: presetProjection(meta.result.name, meta.preset, 0),
          presetState: {
            result: meta.result,
            importedPreset: meta.preset,
            preset: meta.preset,
            revision: 0,
          },
          ...(withSurface.tavern === undefined ? {} : {
            tavern: initializeTavernHelperPresetState(
              withSurface.tavern,
              presetTavernHelperScripts(meta.preset),
              meta.preset.tavernHelperVariables ?? {},
              meta.result.sourceAttachmentId,
            ),
          }),
        }
  }
  const meta = parseWorldInfoMeta(event.data.meta)
  return meta === undefined
    ? { ...withSurface, calls }
    : {
        ...withSurface,
        calls,
        standaloneWorldInfos: {
          ...withSurface.standaloneWorldInfos,
          [meta.result.sourceAttachmentId]: worldInfoLorebookSource(meta),
        },
      }
}

/** Build one projection definition with an optional isolated EJS evaluator. */
export function createAgentRpProjectionDefinition(
  ejsTemplateEngine?: EjsTemplateEngine,
  sessionEventsAvailable: () => boolean = hostSupportsAgentRpSessionEvents,
): AgentRpProjectionDefinition {
  const definition: ProjectionDefinition<'agentRp', AgentRpProjectionState> & {
    readonly wire: NonNullable<ProjectionDefinition<'agentRp', AgentRpProjectionState>['wire']>
  } = {
  key: 'agentRp',
  stateSchema: projectionStateSchema,
  // The value contains full card, lorebook, preset, script, and transcript
  // state. Opening a session reads it from history; bulk session discovery
  // must never serialize it for every conversation.
  init: () => ({
    character: INITIAL_CHARACTER,
    turnMode: 'conversation',
    cardWorldInfoCount: 0,
    standaloneWorldInfos: {},
    worldInfoConfiguration: { format: 0, revision: 0, overrides: [] },
    replayTime: 0,
    systemPrompt: '',
    surface: [],
    shadowedSeqs: [],
    calls: {},
    personaCommands: {},
    nativeStates: [],
    stateSettlementTrail: [],
    presetLibrary: [],
    generations: {},
    surfaceAnchors: {},
    supersededSeqs: [],
    tavernMessageAnnotations: {},
    auxiliaryGenerations: EMPTY_TAVERN_AUXILIARY_GENERATION_REPLAY,
    regexPacks: [],
    regexConfiguration: { format: 0, revision: 0, overrides: [], added: [] },
  }),
  /**
   * Stamp the replay clock only when the event actually changed something.
   *
   * `replayTime` exists solely to give the World Info panel's EJS sandbox a
   * replayable `Date.now()`, and `worldInfoCacheSignature` deliberately
   * excludes it. Bumping it on every event therefore produced a new state
   * reference — and so a full view, validation and wire payload — for every
   * streamed chunk, to carry a timestamp nothing read at that moment.
   * Stamping it alongside real changes keeps the clock exactly as fresh as the
   * view that reads it, because that view only runs when the state changes.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state, or the same reference when nothing changed.
   */
  apply(state, event) {
    const next = foldAgentRpProjectionEvent(state, event)
    return next === state ? state : { ...next, replayTime: event.time }
  },
  wire: {
  viewSchema: projectionSchema as NonNullable<ProjectionDefinition<'agentRp', AgentRpProjectionState>['wire']>['viewSchema'],
  view: state => {
    const sessionEvents = sessionEventsAvailable()
    const worldInfo = worldInfoProjection(state, ejsTemplateEngine)
    const auxiliaryGenerations = summarizeTavernAuxiliaryGenerationReplay(state.auxiliaryGenerations)
    const tavernMessageAnnotations = indexTavernMessageAnnotations(state.tavernMessageAnnotations)
    const visibleTavernMessages = state.surface.flatMap(({ seq, text, reasoning, role }) => text === undefined || role === undefined
      ? []
      : [{ seq, role, text, ...(reasoning === undefined ? {} : { reasoning }), isHidden: false as const }])
    const hiddenTavernMessages = state.tavern?.hiddenPrefix ?? []
    const floors = floorProjection(state, visibleTavernMessages)
    return {
      ...state.character,
      hostCapabilities: { sessionEvents },
      turnMode: sessionEvents ? state.turnMode : 'conversation',
      nativeStates: state.nativeStates.map(stateValue => ({
        id: stateValue.id,
        revision: stateValue.revision,
        ownerModuleId: stateValue.ownerModuleId,
        writerModuleId: stateValue.writerModuleId,
        eventSeq: stateValue.eventSeq,
        value: stateValue.value,
      })),
      ...(auxiliaryGenerations.requests === 0 && auxiliaryGenerations.malformed === 0
        ? {}
        : { auxiliaryGenerations }),
      worldInfoCount: worldInfo.books.reduce((total, book) => total + book.entries.filter(entry => !entry.deleted).length, 0),
      floors,
      worldInfo,
      regexPacks: state.regexPacks.map(pack => ({
        id: pack.id,
        name: pack.name,
        ...summarizeRegexPackScripts(pack.scripts),
        scripts: pack.scripts.map(script => ({ ...script })),
      })),
      // Every imported rule after this Session's own overlay, in execution
      // order. Both the display pass and the manager read this one list, so
      // what the player edits is exactly what runs.
      regex: {
        revision: state.regexConfiguration.revision,
        scripts: configuredRegexScripts([
          { owner: 'regex' as const, scripts: state.regexPacks.flatMap(pack => pack.scripts) },
          { owner: 'prompt-policy' as const, scripts: state.preset?.regexScripts ?? [] },
          { owner: 'actor' as const, scripts: state.character.frontend?.regexScripts ?? [] },
        ], state.regexConfiguration).map(entry => ({
          owner: entry.owner,
          index: entry.index,
          modified: entry.modified,
          deleted: entry.deleted,
          script: { ...entry.script },
        })),
      },
      ...(state.mvu === undefined ? {} : { mvu: state.mvu }),
      ...(state.stateSettlementTrail.length === 0 ? {} : {
        stateSettlement: (() => {
          const trail = state.stateSettlementTrail
          const turns = trail.flatMap(item => item.turn >= 0 ? [item.turn] : [])
          const turn = turns.length === 0 ? -1 : Math.max(...turns)
          const requests = new Map<number, { readonly stage: string; readonly turn: number }>()
          for (const item of trail) {
            if (item.kind !== 'request') continue
            const data = item.data as { readonly stage?: unknown; readonly turn?: unknown }
            requests.set(item.seq, {
              stage: typeof data.stage === 'string' ? data.stage : 'proposal',
              turn: Number(data.turn ?? -1),
            })
          }
          const stages = trail.flatMap((item) => {
            if (item.kind !== 'result') return []
            const data = item.data as {
              readonly requestSeq?: unknown
              readonly result?: { readonly kind?: unknown; readonly operations?: unknown; readonly failure?: unknown
                readonly detail?: { readonly message?: unknown } }
            }
            const request = requests.get(Number(data.requestSeq ?? -1))
            if (request === undefined || request.turn !== turn) return []
            const result = data.result ?? {}
            const success = result.kind === 'success'
            return [{
              stage: request.stage === 'verification' ? 'verification' as const : 'proposal' as const,
              outcome: success ? 'success' as const : 'failure' as const,
              ...(success && Array.isArray(result.operations)
                ? { operations: result.operations as JsonValue[] } : {}),
              ...(success ? {} : {
                error: typeof result.detail?.message === 'string'
                  ? result.detail.message
                  : String(result.failure ?? '状态结算失败'),
              }),
            }]
          })
          const worker = trail.findLast(item => item.kind === 'worker' && item.turn === turn)
          const outcome = worker === undefined
            ? undefined
            : (worker.data as { readonly outcome?: unknown }).outcome
          const answered = new Set(trail.flatMap(item => item.kind === 'result'
            ? [Number((item.data as { readonly requestSeq?: unknown }).requestSeq ?? -1)] : []))
          const ownRequests = [...requests].filter(([, request]) => request.turn === turn)
          // Either a dispatched stage is still open, or the automatic Worker has
          // dispatched for this turn and not yet reported — the second clause
          // covers the retry delay between a failed stage and its replacement,
          // where nothing is momentarily in flight but the run is not over.
          const settling = ownRequests.some(([seq]) => !answered.has(seq))
            || (outcome === undefined && ownRequests.length > 0)
          return {
            turn,
            settling,
            ...(typeof outcome === 'string' ? { outcome: outcome as 'applied' } : {}),
            stages,
          }
        })(),
      }),
      ...(state.stateScheme === undefined ? {} : {
        stateScheme: (() => {
          const scheme = state.stateScheme
          const current = state.nativeStates.find(value => value.id === scheme.stateId)
          const libraryId = roleplayStateSchemeLibraryId(scheme.source)
          return {
            id: scheme.id,
            name: scheme.name,
            stateId: scheme.stateId,
            value: current?.value ?? scheme.initial,
            revision: current?.revision ?? 0,
            rules: scheme.rules,
            ...(libraryId === undefined ? {} : { libraryId }),
            ...(scheme.verificationMaxTokens === undefined
              ? {} : { verificationMaxTokens: scheme.verificationMaxTokens }),
          }
        })(),
      }),
      ...(state.preset === undefined ? {} : { preset: state.preset }),
      presetLibrary: state.presetLibrary,
      ...(state.lastRequest === undefined ? {} : { lastRequest: state.lastRequest }),
      ...(state.promptRegex === undefined ? {} : { promptRegex: state.promptRegex }),
      generations: Object.values(state.generations).map(group => ({
        groupId: group.groupId,
        anchorSeq: group.anchorSeq,
        selectedVersionSeq: group.selectedVersionSeq,
        assistantSeqs: group.assistantSeqs,
        versions: group.versions,
        ...(group.rewrittenInput === undefined ? {} : { rewrittenInput: group.rewrittenInput }),
      })),
      ...(Object.keys(state.surfaceAnchors).length === 0
        ? {}
        : { surfaceAnchors: state.surfaceAnchors }),
      ...(state.supersededSeqs.length === 0 ? {} : { supersededSeqs: state.supersededSeqs }),
      ...(state.shadowedSeqs.length === 0 ? {} : { shadowedSeqs: state.shadowedSeqs }),
      ...(state.currentReplySeq === undefined ? {} : { currentReplySeq: state.currentReplySeq }),
      ...(state.presentation === undefined ? {} : { presentation: state.presentation }),
      ...(state.tavern === undefined ? {} : {
        tavern: {
          ...state.tavern,
          messages: [
            ...hiddenTavernMessages.map(message => ({ ...message, isHidden: true as const })),
            ...visibleTavernMessages,
          ].map((message, messageId) => {
            const selected = Object.values(state.generations)
              .findLast(generation => generation.surfaceSeq === message.seq)?.selectedVersionSeq ?? message.seq
            const annotations = tavernMessageAnnotations.get(selected) ?? {}
            return {
              ...message,
              messageId,
              ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
            }
          }),
        },
      }),
    }
  },
  },
  stateVersion: 18,
  }
  return {
    ...definition,
    // DSH rc.8 reads the client-visible schema and view from the top level.
    // Newer Hosts read the state schema and the same view through `wire`.
    schema: projectionSchema,
    preload: false,
    view: definition.wire.view,
  }
}

/** Projection definition used by pure replay tests and deployments without EJS initialization. */
export const agentRpProjectionDefinition = createAgentRpProjectionDefinition()
