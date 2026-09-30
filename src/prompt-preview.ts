/**
 * What the provider was actually sent, kept so it can be read back.
 *
 * The capture happens at the one seam where the final array exists — after
 * prompt modules are placed, World Info is activated, regex views are applied
 * and continuation is resolved — so the preview cannot show an order the
 * provider did not receive. Nothing is derived a second time.
 *
 * Bodies stay in the Host. A summary carries sizes and leading snippets; one
 * body is fetched only when a row is opened, because a routine roleplay prompt
 * is a hundred thousand tokens and a panel shows one row at a time.
 *
 * This is memory-only and per Session: the newest request replaces the previous
 * one, and a bounded number of Sessions are retained. Nothing reaches the
 * Session log, so a preview never changes what a replay reconstructs.
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { AttributedMessage } from './preset-prompt.ts'
import type { RoleplayPromptOrigin, RoleplayPromptOriginKind } from './prompt-origin.ts'
import {
  PROMPT_PREVIEW_SNIPPET_CHARS,
  type PromptPreviewBodyResponse,
  type PromptPreviewMessage,
  type PromptPreviewPart,
  type PromptPreviewSummary,
  type PromptPreviewToolReason,
} from './prompt-preview-protocol.ts'
import { PROMPT_REGEX_SOURCE_MARKER } from './frontend-regex.ts'

/** How many Sessions keep their last request available. */
const MAX_RETAINED_SESSIONS = 8

interface RetainedMessage {
  readonly role: PromptPreviewMessage['role']
  readonly text: string
  /** Reasoning riding on an assistant message; kept apart because the provider decides if it counts. */
  readonly reasoning: string
  readonly origins: readonly RoleplayPromptOrigin[]
  /** Naming for a chat row, resolved at capture while the message is in hand. */
  readonly history?: { readonly label: string; readonly detail?: string }
}

interface RetainedRequest {
  readonly capturedAt: number
  readonly sessionId: string
  readonly provider?: string
  readonly model?: string
  readonly system: string
  readonly toolNames: readonly string[]
  readonly omittedToolNames: readonly string[]
  readonly toolReasons: readonly PromptPreviewToolReason[]
  readonly messages: readonly RetainedMessage[]
}

const retained = new Map<string, RetainedRequest>()

/**
 * Same cost model the World Info budget uses, so a preview's numbers and the
 * budget's numbers never disagree about the same text.
 */
export function approximatePromptTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return ascii === 0 && nonAscii === 0 ? 0 : Math.ceil(ascii / 4) + nonAscii
}

/**
 * The model-facing text of one message.
 *
 * Tool results nest their own blocks, and a tool call's arguments are text the
 * provider is charged for, so both are unwrapped: a preview that silently showed
 * them as empty would understate exactly the rows a long agent turn is made of.
 */
function messageText(message: Message): string {
  const textOf = (blocks: readonly ContentBlock[]): string[] => blocks.flatMap(block =>
    block.type === 'text' ? [block.text]
      : block.type === 'tool-call' ? [`${block.name}(${block.arguments})`]
        : block.type === 'tool-result' ? textOf(block.content)
          : [])
  return textOf(message.content).join('\n')
}

function reasoningText(message: Message): string {
  return message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('')
}

function snippetOf(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= PROMPT_PREVIEW_SNIPPET_CHARS
    ? collapsed
    : `${collapsed.slice(0, PROMPT_PREVIEW_SNIPPET_CHARS)}…`
}

function toolCallNames(message: Message): readonly string[] {
  return message.content.flatMap(block => block.type === 'tool-call' ? [block.name] : [])
}

/** Name one chat row from the message itself; it is its own source. */
function historyOrigin(message: Message): { readonly label: string; readonly detail?: string } {
  const source = message.source as Message['source'] & Record<string, unknown>
  const rewritten = typeof source[PROMPT_REGEX_SOURCE_MARKER] === 'object'
  const calls = toolCallNames(message)
  // A tool result is carried as a user-role message, so the role alone would
  // file it under the player's own lines.
  const toolResult = message.content.some(block => block.type === 'tool-result')
  const label = toolResult ? '工具结果'
    : message.role === 'user' ? '玩家消息'
      : message.role === 'assistant' ? '角色消息' : '系统消息'
  const notes = [
    ...(rewritten ? ['已由正则改写'] : []),
    ...(calls.length === 0 ? [] : [`工具调用 ${calls.join('、')}`]),
  ]
  return { label, ...(notes.length === 0 ? {} : { detail: notes.join(' · ') }) }
}

/**
 * Split one merged message back into the pieces that were joined into it.
 *
 * `injectAttributedInChatPrompts` joins with a newline and the World Info
 * markers join with a blank line, so the body is re-split on the separator that
 * yields exactly as many pieces as there are origins. When neither does — a
 * contribution was empty, or a join rule changed — the parts are reported
 * without bodies rather than guessing at a wrong split.
 */
function splitMerged(text: string, count: number): readonly string[] | undefined {
  if (count <= 1) return undefined
  for (const separator of ['\n\n', '\n']) {
    const pieces = text.split(separator)
    if (pieces.length === count) return pieces
  }
  return undefined
}

function partsOf(item: RetainedMessage): readonly PromptPreviewPart[] | undefined {
  if (item.origins.length <= 1) return undefined
  const bodies = splitMerged(item.text, item.origins.length)
  return item.origins.map((origin, index): PromptPreviewPart => {
    const body = bodies?.[index] ?? ''
    return {
      kind: origin.kind,
      label: origin.label,
      ...(origin.detail === undefined ? {} : { detail: origin.detail }),
      ...(origin.id === undefined ? {} : { id: origin.id }),
      chars: body.length,
      approximateTokens: approximatePromptTokens(body),
      snippet: snippetOf(body),
    }
  })
}

/**
 * Expand one contribution into rows.
 *
 * A module that is itself a join — the World Info markers hold every activated
 * entry — reports its entries rather than itself, which is what makes a block of
 * thirty entries readable as thirty rows.
 */
function describeParts(
  origin: RoleplayPromptOrigin,
  text: string,
): readonly PromptPreviewPart[] | undefined {
  const parts = origin.parts
  if (parts === undefined || parts.length === 0) return undefined
  const bodies = splitMerged(text, parts.length)
  return parts.map((part, index): PromptPreviewPart => {
    const body = bodies?.[index] ?? ''
    return {
      kind: part.kind,
      label: part.label,
      ...(part.detail === undefined ? {} : { detail: part.detail }),
      ...(part.id === undefined ? {} : { id: part.id }),
      chars: body.length,
      approximateTokens: approximatePromptTokens(body),
      snippet: snippetOf(body),
    }
  })
}

function describeMessage(item: RetainedMessage, index: number): PromptPreviewMessage {
  const single = item.origins.length === 1 ? item.origins[0]! : undefined
  const history = item.history
  const kind: RoleplayPromptOriginKind = single?.kind ?? (history === undefined ? 'preset' : 'history')
  const label = single?.label ?? history?.label ?? '合并注入'
  const detail = single?.detail ?? history?.detail
  const parts = single === undefined ? partsOf(item) : describeParts(single, item.text)
  return {
    index,
    role: item.role,
    kind,
    label,
    ...(detail === undefined ? {} : { detail }),
    chars: item.text.length,
    approximateTokens: approximatePromptTokens(item.text),
    snippet: snippetOf(item.text),
    ...(parts === undefined ? {} : { parts }),
  }
}

/** Retain the exact request one Session just dispatched. */
export function capturePromptPreview(input: {
  readonly sessionId: string
  readonly messages: readonly AttributedMessage[]
  readonly system?: string
  readonly toolNames?: readonly string[]
  readonly omittedToolNames?: readonly string[]
  readonly toolReasons?: readonly PromptPreviewToolReason[]
  readonly provider?: string
  readonly model?: string
}): void {
  const record: RetainedRequest = {
    capturedAt: Date.now(),
    sessionId: input.sessionId,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    system: input.system ?? '',
    toolNames: [...input.toolNames ?? []],
    omittedToolNames: [...input.omittedToolNames ?? []],
    toolReasons: [...input.toolReasons ?? []],
    messages: input.messages.map(({ message, origins }) => ({
      role: message.role as PromptPreviewMessage['role'],
      text: messageText(message),
      reasoning: message.role === 'assistant' ? reasoningText(message) : '',
      origins,
      ...(origins.length === 0 ? { history: historyOrigin(message) } : {}),
    })),
  }
  // Re-inserting moves this Session to the end, so eviction drops the Session
  // that has been idle longest rather than the one that started earliest.
  retained.delete(input.sessionId)
  retained.set(input.sessionId, record)
  while (retained.size > MAX_RETAINED_SESSIONS) {
    const oldest = retained.keys().next()
    if (oldest.done === true) break
    retained.delete(oldest.value)
  }
}

/** Describe one Session's last dispatched request without any message body. */
export function promptPreviewSummary(sessionId: string): PromptPreviewSummary | undefined {
  const record = retained.get(sessionId)
  if (record === undefined) return undefined
  const messages = record.messages.map(describeMessage)
  const reasoning = record.messages.filter(message => message.reasoning !== '')
  return {
    format: 0,
    capturedAt: record.capturedAt,
    sessionId: record.sessionId,
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    ...(record.model === undefined ? {} : { model: record.model }),
    system: {
      chars: record.system.length,
      approximateTokens: approximatePromptTokens(record.system),
      snippet: snippetOf(record.system),
    },
    toolNames: record.toolNames,
    ...(record.omittedToolNames.length === 0 ? {} : { omittedToolNames: record.omittedToolNames }),
    ...(record.toolReasons.length === 0 ? {} : { toolReasons: record.toolReasons }),
    reasoning: {
      messages: reasoning.length,
      chars: reasoning.reduce((sum, message) => sum + message.reasoning.length, 0),
      approximateTokens: reasoning.reduce((sum, message) => sum + approximatePromptTokens(message.reasoning), 0),
    },
    messages,
    totals: {
      messages: messages.length,
      chars: messages.reduce((sum, message) => sum + message.chars, 0) + record.system.length,
      approximateTokens: messages.reduce((sum, message) => sum + message.approximateTokens, 0)
        + approximatePromptTokens(record.system),
    },
  }
}

/** Read one opened row's full text, including its merged pieces. */
export function promptPreviewBody(
  sessionId: string,
  index: number,
): PromptPreviewBodyResponse | undefined {
  const record = retained.get(sessionId)
  if (record === undefined) return undefined
  if (index < 0) {
    return { format: 0, capturedAt: record.capturedAt, index, text: record.system }
  }
  const item = record.messages[index]
  if (item === undefined) return undefined
  const single = item.origins.length === 1 ? item.origins[0] : undefined
  const count = single?.parts?.length ?? item.origins.length
  const parts = splitMerged(item.text, count)
  return {
    format: 0,
    capturedAt: record.capturedAt,
    index,
    text: item.text,
    ...(parts === undefined ? {} : { parts }),
  }
}

/** Drop one Session's retained request, used when a Session goes away. */
export function forgetPromptPreview(sessionId: string): void {
  retained.delete(sessionId)
}
