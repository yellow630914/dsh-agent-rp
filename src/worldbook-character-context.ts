/** Small host gateway exposing the active Agent RP character to Worldbook plugins. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { roleplayModelHistory } from './roleplay-surface-overlay.ts'
import type { CharacterImportMeta } from './import/session-character.ts'

export const WORLDBOOK_CHARACTER_CONTEXT_KEY = 'worldbook.characterContext'

export interface WorldbookCharacterContext {
  readonly name: string
  readonly tags: readonly string[]
}

type CharacterResolver = () => WorldbookCharacterContext | undefined

export interface WorldbookCharacterContextRegistry {
  getCurrentCharacter(sessionId: string): WorldbookCharacterContext | undefined
  register(sessionId: string, resolve: CharacterResolver): () => void
}

const WORLDBOOK_SNAPSHOT_CHANNEL_PREFIX = 'agent-rp:inbox-gap:'

interface SnapshotChannelSource {
  readonly channel?: unknown
  readonly sections?: unknown
}

function isWorldbookMessage(
  message: Message,
): message is Message & { readonly source: Extract<Message['source'], { readonly kind: 'plugin' }> } {
  return message.source.kind === 'plugin' && message.source.plugin === 'dsh-worldbook'
}

function isLegacyWorldbookInstruction(message: UserMessage): boolean {
  return isWorldbookMessage(message)
    && (message.source.form === undefined || message.source.form === 'instructions')
}

function worldbookSnapshot(message: Message): { readonly channel?: string; readonly empty: boolean } | undefined {
  if (!isWorldbookMessage(message) || message.source.form !== 'snapshot') return undefined
  const source = message.source as typeof message.source & SnapshotChannelSource
  return {
    ...(typeof source.channel === 'string' ? { channel: source.channel } : {}),
    empty: Array.isArray(source.sections) && source.sections.length === 0,
  }
}

function channelKey(channel: string | undefined): string {
  return channel === undefined ? 'default' : `named:${channel}`
}

function activeWorldbookSnapshotChannels(messages: readonly Message[]): (string | undefined)[] {
  const channels = new Map<string, string | undefined>()
  for (const message of messages) {
    const snapshot = worldbookSnapshot(message)
    if (snapshot === undefined || snapshot.empty) continue
    channels.set(channelKey(snapshot.channel), snapshot.channel)
  }
  return [...channels.values()]
}

function supportsSnapshotChannels(session: { readonly constructor: unknown }): boolean {
  const constructor = session.constructor as { readonly contextSnapshotChannels?: unknown }
  return constructor.contextSnapshotChannels === 1
}

function snapshotSectionText(message: UserMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function createWorldbookSnapshot(message: UserMessage, channel: string): UserMessage {
  return createUserMessage({
    content: message.content,
    source: {
      kind: 'plugin',
      plugin: 'dsh-worldbook',
      form: 'snapshot',
      channel,
      sections: [{ name: channel, text: snapshotSectionText(message) }],
    },
  })
}

function clearWorldbookSnapshot(channel: string | undefined): UserMessage {
  return createUserMessage({
    content: [],
    source: {
      kind: 'plugin',
      plugin: 'dsh-worldbook',
      form: 'snapshot',
      ...(channel === undefined ? {} : { channel }),
      sections: [],
    },
  })
}

/**
 * Publish one external Worldbook evaluation as position-preserving snapshots.
 * Each gap in the current inbox batch is an independent channel, so content
 * before and after a user message stays in place. On a direct user turn, an
 * empty snapshot clears every previously active channel not republished now.
 */
export function coalesceWorldbookSnapshot(
  messages: UserMessage[],
  options: {
    readonly directUserTurn?: boolean
    readonly previousChannels?: readonly (string | undefined)[]
  } = {},
): UserMessage[] {
  let nonWorldbookBefore = 0
  const ordinalByGap = new Map<number, number>()
  const publishedChannels = new Set<string>()
  let changed = false
  const result = messages.map(message => {
    if (isLegacyWorldbookInstruction(message)) {
      const ordinal = ordinalByGap.get(nonWorldbookBefore) ?? 0
      ordinalByGap.set(nonWorldbookBefore, ordinal + 1)
      const channel = `${WORLDBOOK_SNAPSHOT_CHANNEL_PREFIX}${nonWorldbookBefore}:${ordinal}`
      publishedChannels.add(channelKey(channel))
      changed = true
      return createWorldbookSnapshot(message, channel)
    }
    const snapshot = worldbookSnapshot(message)
    if (snapshot !== undefined) publishedChannels.add(channelKey(snapshot.channel))
    if (!isWorldbookMessage(message)) nonWorldbookBefore++
    return message
  })

  if (options.directUserTurn === true) {
    for (const channel of options.previousChannels ?? []) {
      if (publishedChannels.has(channelKey(channel))) continue
      result.push(clearWorldbookSnapshot(channel))
      changed = true
    }
  }
  return changed ? result : messages
}

/**
 * Install the snapshot adapter after each Agent's shared injectors exist.
 * Agent-scoped prepend keeps this adapter outside independently loaded
 * Worldbook waterfalls, regardless of profile bundle order.
 */
export function installWorldbookSnapshotCoalescing(
  ctx: Context,
  options: { readonly snapshotChannels?: boolean } = {},
): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!(options.snapshotChannels ?? supportsSnapshotChannels(agent.session))) return decision
      const snapshot = coalesceWorldbookSnapshot(decision.messages, {
        directUserTurn: messages.some(message => message.source.kind === 'user'),
        previousChannels: activeWorldbookSnapshotChannels(roleplayModelHistory(agent.session)),
      })
      return snapshot === decision.messages ? decision : { ...decision, messages: snapshot }
    }, { prepend: true })
  }, { global: true })
}

/** Multiple preset-scoped Agent instances contribute through one host-visible provider. */
export function createWorldbookCharacterContextRegistry(): WorldbookCharacterContextRegistry {
  const sessions = new Map<string, { readonly token: symbol; readonly resolve: CharacterResolver }>()
  return {
    getCurrentCharacter(sessionId) {
      return sessions.get(sessionId)?.resolve()
    },
    register(sessionId, resolve) {
      const token = Symbol(sessionId)
      sessions.set(sessionId, { token, resolve })
      return () => {
        if (sessions.get(sessionId)?.token === token) sessions.delete(sessionId)
      }
    },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function cardTags(meta: CharacterImportMeta): readonly string[] {
  const root = record(meta.raw)
  const data = record(root?.data) ?? root
  return Array.isArray(data?.tags)
    ? [...new Set(data.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
      .map(tag => tag.trim()))]
    : []
}

/** Build the Worldbook character-filter identity without exposing card content. */
export function worldbookCharacterContext(
  meta: CharacterImportMeta,
  originalFilename?: string,
): WorldbookCharacterContext {
  const filename = originalFilename?.trim().replace(/\.(?:png|json|charx)$/iu, '')
  return {
    name: filename === undefined || filename === '' ? meta.result.name : filename,
    tags: cardTags(meta),
  }
}
