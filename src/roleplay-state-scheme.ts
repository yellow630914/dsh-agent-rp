/** Native Roleplay state schemes owned by Agent RP rather than an imported card format. */

import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RoleplayResourceProvider } from './roleplay-resource-catalog.ts'
import { readRoleplayStates } from './roleplay-state.ts'
import {
  parseRoleplayStateTemplateValue,
  type RoleplayStateTemplate,
} from './roleplay-state-template.ts'
import {
  BASIC_ROLEPLAY_STATE_SCHEME_ID,
  isRoleplayStateSchemeSessionId,
  ROLEPLAY_STATE_SCHEME_PROVIDER_ID,
  roleplayStateSchemeLibraryId,
  roleplayStateSchemeResourceId,
  roleplayStateSchemeSessionId,
} from './roleplay-state-scheme-ids.ts'

export {
  BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE,
  BASIC_ROLEPLAY_STATE_SCHEME_ID,
  isRoleplayStateSchemeSessionId,
  ROLEPLAY_STATE_SCHEME_LIBRARY_PREFIX,
  ROLEPLAY_STATE_SCHEME_SESSION_PREFIX,
  roleplayStateSchemeSessionId,
  ROLEPLAY_STATE_SCHEME_MODULE_ID,
  ROLEPLAY_STATE_SCHEME_PROVIDER_ID,
  roleplayStateSchemeLibraryId,
  roleplayStateSchemeResourceId,
} from './roleplay-state-scheme-ids.ts'

/** Exact model-visible state contract this Session is running under. */
export interface RoleplayStateSchemeSnapshot {
  readonly format: 0
  /** Session-owned identity, minted at launch; unchanged by switches and branches. */
  readonly id: string
  /** Reusable resource this contract was last taken from; rewritten on every switch. */
  readonly source?: string
  readonly name: string
  /** Native state namespace this scheme owns for the whole Session. */
  readonly stateId: string
  /** Opening value used until the first settled revision exists. */
  readonly initial: JsonValue
  /** Author-written settlement rules consulted only by the post-narrative stage. */
  readonly rules: string
  /**
   * Session-owned panel template that overrides the source entry's.
   *
   * Absent means "follow the source": edits made in the resource center reach
   * this Session, which is what a shared template is for. Present means the
   * player edited the panel from the state dialog, and this Session keeps its
   * own copy from then on.
   */
  readonly template?: RoleplayStateTemplate
  /**
   * Completion budget for the independent verification stage.
   *
   * How much room the verification needs scales with how large this scheme's
   * state grows, which is a property of the scheme rather than of the
   * workspace. Absent means the runtime default.
   */
  readonly verificationMaxTokens?: number
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Skippable snapshot of the native state contract selected for this Session. */
    'agent-rp/state-scheme-seed': RoleplayStateSchemeSnapshot
  }
}

const SCHEME_ID_PATTERN = /^state-scheme:[\p{L}\p{N}](?:[\p{L}\p{N}._:/-]{0,126}[\p{L}\p{N}])?$/u
const STATE_ID_PATTERN = /^state:[\p{L}\p{N}](?:[\p{L}\p{N}._:/-]{0,126}[\p{L}\p{N}])?$/u

const BASIC_SCHEME: RoleplayStateSchemeSnapshot = {
  format: 0,
  id: BASIC_ROLEPLAY_STATE_SCHEME_ID,
  name: 'Agent RP · 基础状态',
  stateId: 'state:native',
  initial: {
    场景: { 地点: '未定', 时间: '未定' },
    角色: { 状态: '正常', 情绪: '平静' },
    进度: { 回合: 0 },
  },
  rules: [
    '只在正文明确写出变化时更新对应字段，不要凭推测改写。',
    '「进度/回合」在每一轮角色正文之后加一。',
    '「场景/地点」「场景/时间」只在正文交代了新的地点或时间推移时替换。',
    '「角色/状态」「角色/情绪」跟随正文中角色可观察的处境与情绪变化。',
  ].join('\n'),
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${label} has unsupported field ${JSON.stringify(extra)}`)
}

function boundedText(value: unknown, label: string, maximum: number, nonEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximum
    || (nonEmpty && (value === '' || value.trim() !== value))) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function budget(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1_024 || (value as number) > 200_000) {
    throw new Error('状态核验上限必须是 1024 到 200000 之间的整数')
  }
  return value as number
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid: ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate a detached native scheme without consulting mutable provider state. */
export function parseRoleplayStateScheme(value: unknown): RoleplayStateSchemeSnapshot {
  const record = plainObject(value, 'native state scheme')
  exactKeys(
    record,
    ['format', 'id', 'source', 'name', 'stateId', 'initial', 'rules', 'template', 'verificationMaxTokens'],
    'native state scheme',
  )
  if (record.format !== 0 || !Object.hasOwn(record, 'initial')) {
    throw new Error('native state scheme shape is invalid')
  }
  const initial = snapshotJsonValue(record.initial as JsonValue)
  if (initial === undefined || typeof initial !== 'object' || initial === null || Array.isArray(initial)) {
    throw new Error('native state scheme initial value must be a lossless JSON object')
  }
  // Seeds written before the identity split stored the resource id in `id`.
  // Reading them as their own source keeps the panel template resolvable.
  const id = identifier(record.id, 'native state scheme id', SCHEME_ID_PATTERN)
  const source = record.source === undefined
    ? (isRoleplayStateSchemeSessionId(id) ? undefined : id)
    : identifier(record.source, 'native state scheme source', SCHEME_ID_PATTERN)
  return Object.freeze({
    format: 0,
    id,
    ...(source === undefined ? {} : { source }),
    name: boundedText(record.name, 'native state scheme name', 120),
    stateId: identifier(record.stateId, 'native state scheme state id', STATE_ID_PATTERN),
    initial,
    rules: boundedText(record.rules, 'native state scheme rules', 24_000, false),
    ...(record.template === undefined
      ? {}
      : { template: parseRoleplayStateTemplateValue(record.template, '状态栏模板') }),
    ...(record.verificationMaxTokens === undefined ? {} : {
      verificationMaxTokens: budget(record.verificationMaxTokens),
    }),
  })
}

/** Rebuild the scheme selected for this Session solely from the Session log. */
export function readRoleplayStateScheme(
  events: readonly SessionEvent[],
): RoleplayStateSchemeSnapshot | undefined {
  let active: RoleplayStateSchemeSnapshot | undefined
  for (const event of events) {
    if (event.type === 'agent-rp/state-scheme-seed') active = parseRoleplayStateScheme(event.data)
  }
  return active
}

/** Current value and revision of one native scheme namespace, before any settlement this turn. */
export interface RoleplayStateSchemeValue {
  readonly stateId: string
  readonly value: JsonValue
  /** Zero until the first durable revision exists, matching the state compare-and-set contract. */
  readonly revision: number
}

/** Fold the latest durable revision over the scheme's frozen opening value. */
export function readRoleplayStateSchemeValue(
  events: readonly SessionEvent[],
  scheme: RoleplayStateSchemeSnapshot,
): RoleplayStateSchemeValue {
  const current = readRoleplayStates(events).find(state => state.id === scheme.stateId)
  return current === undefined
    ? { stateId: scheme.stateId, value: scheme.initial, revision: 0 }
    : { stateId: scheme.stateId, value: current.value, revision: current.revision }
}

/** The built-in composition offered when no library scheme has been authored yet. */
export function basicRoleplayStateScheme(): RoleplayStateSchemeSnapshot {
  return parseRoleplayStateScheme(BASIC_SCHEME)
}

/** Mint one Session-owned contract from a reusable source. */
export function sessionRoleplayStateScheme(
  source: RoleplayStateSchemeSnapshot,
  unique: string,
): RoleplayStateSchemeSnapshot {
  return parseRoleplayStateScheme({
    format: 0,
    id: roleplayStateSchemeSessionId(unique),
    source: source.source ?? source.id,
    name: source.name,
    stateId: source.stateId,
    initial: source.initial,
    rules: source.rules,
    ...(source.template === undefined ? {} : { template: source.template }),
    ...(source.verificationMaxTokens === undefined
      ? {} : { verificationMaxTokens: source.verificationMaxTokens }),
  })
}

/**
 * Point one Session's existing contract at a different source.
 *
 * The identity and the state namespace survive the switch, so the values and
 * their revision carry over: changing scheme mid-play is meant to adjust the
 * rules and presentation, not to reset the save. Only `source`, `name`,
 * `initial` and `rules` come from the incoming scheme, and `initial` only ever
 * matters again if the namespace has no settled revision yet.
 * @param current - contract this Session is running under.
 * @param next - scheme the player switched to.
 * @returns the replacement seed to append.
 */
export function switchedRoleplayStateScheme(
  current: RoleplayStateSchemeSnapshot,
  next: RoleplayStateSchemeSnapshot,
): RoleplayStateSchemeSnapshot {
  return parseRoleplayStateScheme({
    format: 0,
    id: current.id,
    source: next.source ?? next.id,
    name: next.name,
    stateId: current.stateId,
    initial: next.initial,
    rules: next.rules,
    // A switch adopts the new source's template, so the incoming scheme's
    // presentation is what the player sees until they override it again.
    ...(next.template === undefined ? {} : { template: next.template }),
    ...(next.verificationMaxTokens === undefined
      ? {} : { verificationMaxTokens: next.verificationMaxTokens }),
  })
}

/** Read-only view of the authored scheme library consulted by the resource provider. */
export interface RoleplayStateSchemeSource {
  list(): readonly { readonly id: string; readonly name: string }[]
  read(id: string): RoleplayStateSchemeSnapshot | undefined
}

/** Publish the built-in scheme plus every authored library scheme through the catalog. */
export function roleplayStateSchemeResourceProvider(
  source?: RoleplayStateSchemeSource,
): RoleplayResourceProvider {
  const builtIn = basicRoleplayStateScheme()
  const resolve = (id: string): RoleplayStateSchemeSnapshot | undefined => {
    if (id === builtIn.id) return builtIn
    const libraryId = roleplayStateSchemeLibraryId(id)
    return libraryId === undefined ? undefined : source?.read(libraryId)
  }
  return {
    id: ROLEPLAY_STATE_SCHEME_PROVIDER_ID,
    list: () => [
      { id: builtIn.id, kind: 'state-scheme' as const, name: builtIn.name, availability: 'available' as const },
      ...(source?.list() ?? []).map(entry => ({
        id: roleplayStateSchemeResourceId(entry.id),
        kind: 'state-scheme' as const,
        name: entry.name,
        availability: 'available' as const,
      })),
    ],
    inspect: (descriptor) => {
      const scheme = resolve(descriptor.id)
      if (scheme === undefined) throw new Error('状态方案不可用')
      const initial = scheme.initial as Record<string, JsonValue>
      return {
        kind: 'state-scheme',
        stateId: scheme.stateId,
        fieldCount: Object.keys(initial).length,
      }
    },
    materialize: (input) => {
      const scheme = resolve(input.selection.id)
      if (scheme === undefined || input.selection.variant !== undefined) {
        throw new Error('状态方案选择无效')
      }
      return {
        events: [...structuredClone(input.events), {
          type: 'agent-rp/state-scheme-seed' as const,
          seq: SessionSeq(input.events.length),
          time: Date.now(),
          // The Session takes its own identity here and keeps it for good; the
          // library entry it was copied from is recorded as the source.
          data: structuredClone(sessionRoleplayStateScheme(scheme, crypto.randomUUID())),
          ignorable: true,
        }],
      }
    },
  }
}
