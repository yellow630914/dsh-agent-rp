/** Prompt Manager assembly for imported SillyTavern Chat Completion presets. */

import { createMessage, type Message, type RequestMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { ImportedCharacterCard } from './import/types.ts'
import type {
  ImportedSillyTavernPreset,
  SillyTavernPresetContinuation,
  SillyTavernPresetPrompt,
} from './import/sillytavern-preset.ts'
import type { RoleplayPromptOrigin } from './prompt-origin.ts'
import { roleplayModelHistory } from './roleplay-surface-overlay.ts'
import type { EjsTemplateResult } from './ejs-template.ts'
import {
  hasTurnVariantRoleplaySyntax,
  ReplayableRoleplayMacros,
  type RoleplayMacroContext,
  type RoleplayMacroMessage,
} from './roleplay-macro.ts'

/** Runtime values substituted into marker prompts and macros. */
export interface PresetPromptInputs {
  readonly card?: ImportedCharacterCard
  /** Identity used by preset macros when a Session starts from World Info or chat history without a card. */
  readonly characterName?: string
  readonly userName?: string
  readonly userPersona?: string
  readonly worldInfoBefore: readonly string[]
  readonly worldInfoAfter: readonly string[]
  /**
   * Per-entry authorship for the two World Info markers, positionally paired
   * with the arrays above. The markers join every entry into one module, so
   * without this the preview can only say "world info" for a block that may
   * hold thirty independently-activated entries.
   */
  readonly worldInfoBeforeOrigins?: readonly RoleplayPromptOrigin[]
  readonly worldInfoAfterOrigins?: readonly RoleplayPromptOrigin[]
  readonly session: Session
  readonly pendingMessages?: readonly UserMessage[]
  /** Prepared turn context shared with native card and world adapters. */
  readonly macroContext?: RoleplayMacroContext
  readonly worldInfoMacrosResolved?: boolean
  readonly mvuEnabled?: boolean
  readonly renderTemplate?: (template: string) => EjsTemplateResult
}

/** Provider-neutral role retained by one ordered prompt contribution. */
export type RoleplayPromptRole = 'system' | 'user' | 'assistant'

/** One ordered prompt module after adapter expansion. */
export interface RoleplayOrderedPrompt {
  readonly role: RoleplayPromptRole
  readonly content: string
  /** Authorship, carried for the prompt preview; never read on the send path. */
  readonly origin?: RoleplayPromptOrigin
}

/** Host-compatible prompt split around the conversation history. */
export interface RoleplayAssembledPrompt {
  readonly beforeHistory: readonly RoleplayOrderedPrompt[]
  readonly afterHistory: readonly RoleplayOrderedPrompt[]
  readonly inChat: readonly RoleplayInChatPrompt[]
  readonly includeHistory: boolean
  readonly continuation?: RoleplayContinuationPlan
  readonly enabledPromptCount: number
  readonly unsupportedMacroCount: number
  readonly templateRenderCount: number
  readonly templateFailureCount: number
}

/** Prompt fields required by the final LLM message assembly seam. */
export type RoleplayProviderPromptPlan = Pick<
  RoleplayAssembledPrompt,
  'beforeHistory' | 'afterHistory' | 'inChat' | 'includeHistory' | 'continuation'
>

/** Expanded continuation behavior retained until the final provider message seam. */
export interface RoleplayContinuationPlan {
  readonly prefill: boolean
  readonly postfix: '' | ' ' | '\n' | '\n\n'
  readonly nudgePrompt: string
}

/** One expanded prompt module placed relative to recent chat messages. */
export interface RoleplayInChatPrompt {
  readonly role: RoleplayPromptRole
  readonly content: string
  readonly depth: number
  readonly order: number
  /** Authorship, carried for the prompt preview; never read on the send path. */
  readonly origin?: RoleplayPromptOrigin
}

/** Compatibility names retained for existing adapter callers. */
export type SillyTavernOrderedPrompt = RoleplayOrderedPrompt
export type AssembledSillyTavernPreset = RoleplayAssembledPrompt
export type SillyTavernPromptPlan = RoleplayProviderPromptPlan
export type SillyTavernContinuationPlan = RoleplayContinuationPlan
export type SillyTavernInChatPrompt = RoleplayInChatPrompt

/** Stable request-level system text and the ordered modules that must remain before history. */
export interface RoleplaySystemPromptSplit {
  readonly systemPromptText: string
  readonly beforeHistory: readonly RoleplayOrderedPrompt[]
}

/**
 * Move only the leading stable system run into the provider system field.
 * Presets without chat history retain their complete authored message order.
 */
export function splitRoleplaySystemPrompt(
  plan: RoleplayProviderPromptPlan,
): RoleplaySystemPromptSplit {
  if (!plan.includeHistory) return { systemPromptText: '', beforeHistory: plan.beforeHistory }
  const firstNonSystem = plan.beforeHistory.findIndex(prompt => prompt.role !== 'system')
  const prefixLength = firstNonSystem < 0 ? plan.beforeHistory.length : firstNonSystem
  if (prefixLength === 0) return { systemPromptText: '', beforeHistory: plan.beforeHistory }
  return {
    systemPromptText: plan.beforeHistory.slice(0, prefixLength)
      .map(prompt => prompt.content).join('\n\n'),
    beforeHistory: plan.beforeHistory.slice(prefixLength),
  }
}

function macroMessageText(message: ReturnType<Session['deriveMessages']>[number] | UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function macroMessages(session: Session, pending: readonly UserMessage[]): readonly RoleplayMacroMessage[] {
  const history = roleplayModelHistory(session)
  const historyIds = new Set(history.map(message => message.id))
  return [...history, ...pending.filter(message => !historyIds.has(message.id))].flatMap((message) => {
    if ((message.role !== 'user' && message.role !== 'assistant')
      || (message.source.kind !== 'user' && message.source.kind !== 'model')) return []
    return [{ role: message.role, content: macroMessageText(message) }]
  })
}

interface PromptAssemblyDiagnostics {
  templateRenders: number
  templateFailures: number
}

interface ExpandedPromptText {
  readonly text: string
  readonly turnVariant: boolean
}

const RESOLVED_FORMAT_VALUE = '\u0000agent-rp-resolved-format-value\u0000'

function applyFormat(
  format: string,
  variable: string,
  value: string,
  macros: ReplayableRoleplayMacros,
  valueResolved = false,
): string {
  if (value.trim() === '') return ''
  // SillyTavern treats an empty wrapper format as a raw marker insertion.
  // Some community presets intentionally clear these fields instead of using {0}.
  if (format.trim() === '') return valueResolved ? value : macros.expand(value)
  const inserted = valueResolved ? RESOLVED_FORMAT_VALUE : value
  const expanded = macros.expand(format.replaceAll(`{{${variable}}}`, inserted).replaceAll('{0}', inserted))
  return valueResolved ? expanded.replaceAll(RESOLVED_FORMAT_VALUE, value) : expanded
}

function markerText(
  prompt: SillyTavernPresetPrompt,
  preset: ImportedSillyTavernPreset,
  inputs: PresetPromptInputs,
  macros: ReplayableRoleplayMacros,
): string | undefined {
  const card = inputs.card
  switch (prompt.identifier) {
    case 'worldInfoBefore':
      return inputs.worldInfoBefore.map(value => applyFormat(
        preset.formats.worldInfo, 'worldInfo', value, macros, inputs.worldInfoMacrosResolved,
      )).filter(Boolean).join('\n\n')
    case 'worldInfoAfter':
      return inputs.worldInfoAfter.map(value => applyFormat(
        preset.formats.worldInfo, 'worldInfo', value, macros, inputs.worldInfoMacrosResolved,
      )).filter(Boolean).join('\n\n')
    case 'charDescription': return card?.description ?? ''
    case 'charPersonality':
      return card === undefined ? '' : applyFormat(
        preset.formats.personality, 'personality', card.personality, macros,
      )
    case 'scenario':
      return card === undefined ? '' : applyFormat(
        preset.formats.scenario, 'scenario', card.scenario, macros,
      )
    case 'personaDescription': return inputs.userPersona ?? ''
    case 'dialogueExamples': return card?.messageExample ?? ''
    case 'chatHistory': return undefined
    default: return prompt.content
  }
}

function promptHasTurnVariantSyntax(
  prompt: SillyTavernPresetPrompt,
  preset: ImportedSillyTavernPreset,
  inputs: PresetPromptInputs,
): boolean {
  const card = inputs.card
  if (prompt.identifier === 'worldInfoBefore' || prompt.identifier === 'worldInfoAfter') return true
  const sources = [prompt.content]
  switch (prompt.identifier) {
    case 'charDescription':
      sources.push(card?.description ?? '')
      break
    case 'charPersonality':
      sources.push(preset.formats.personality, card?.personality ?? '')
      break
    case 'scenario':
      sources.push(preset.formats.scenario, card?.scenario ?? '')
      break
    case 'personaDescription':
      sources.push(inputs.userPersona ?? '')
      break
    case 'dialogueExamples':
      sources.push(card?.messageExample ?? '')
      break
    case 'main':
      if (card !== undefined && card.systemPrompt.trim() !== '' && !prompt.forbidOverrides) {
        sources.push(card.systemPrompt)
      }
      break
    case 'jailbreak':
      if (card !== undefined && card.postHistoryInstructions.trim() !== '' && !prompt.forbidOverrides) {
        sources.push(card.postHistoryInstructions)
      }
      break
  }
  return sources.some(hasTurnVariantRoleplaySyntax)
}

function promptText(
  prompt: SillyTavernPresetPrompt,
  preset: ImportedSillyTavernPreset,
  inputs: PresetPromptInputs,
  macros: ReplayableRoleplayMacros,
  diagnostics: PromptAssemblyDiagnostics,
): ExpandedPromptText | undefined {
  const marker = prompt.marker ? markerText(prompt, preset, inputs, macros) : prompt.content
  if (marker === undefined) return undefined
  const card = inputs.card
  let value = marker
  if (prompt.identifier === 'main' && card !== undefined && card.systemPrompt.trim() !== '' && !prompt.forbidOverrides) {
    value = card.systemPrompt.replaceAll('{{original}}', marker)
  }
  if (prompt.identifier === 'jailbreak' && card !== undefined && card.postHistoryInstructions.trim() !== '' && !prompt.forbidOverrides) {
    value = card.postHistoryInstructions.replaceAll('{{original}}', marker)
  }
  const expanded = macros.expand(value)
  const turnVariant = promptHasTurnVariantSyntax(prompt, preset, inputs)
  if (!/<%[=_-]?[\s\S]*?%>/imu.test(expanded)) return { text: expanded, turnVariant }
  if (inputs.renderTemplate === undefined) {
    diagnostics.templateFailures += 1
    return undefined
  }
  const rendered = inputs.renderTemplate(expanded)
  if (!rendered.ok) {
    diagnostics.templateFailures += 1
    return undefined
  }
  diagnostics.templateRenders += 1
  return { text: rendered.text, turnVariant }
}

function continuationPlan(
  continuation: SillyTavernPresetContinuation | undefined,
  macros: ReplayableRoleplayMacros,
): RoleplayContinuationPlan | undefined {
  if (continuation === undefined) return undefined
  return { ...continuation, nudgePrompt: macros.expand(continuation.nudgePrompt) }
}

function precedingToolTransactionStart(messages: readonly RequestMessage[], end: number): number | undefined {
  const resultIds = new Set<string>()
  let cursor = end
  while (cursor > 0) {
    const message = messages[cursor - 1]!
    // DSH 0.2.0 made a tool result its own `tool`-role message with the answered
    // call id at the top level, instead of a `tool-result` block inside a
    // user-role message.
    if (message.role !== 'tool') break
    resultIds.add(String(message.toolCallId))
    cursor -= 1
  }
  if (cursor === end || cursor === 0) return undefined
  const assistant = messages[cursor - 1]!
  const callIds = assistant.content
    .filter(block => block.type === 'tool-call')
    .map(block => String(block.id))
  if (assistant.role !== 'assistant' || callIds.length === 0
    || callIds.length !== resultIds.size || callIds.some(id => !resultIds.has(id))) return undefined
  return cursor - 1
}

function trailingToolTransactionStart(messages: readonly RequestMessage[]): number {
  let start = messages.length
  while (true) {
    const preceding = precedingToolTransactionStart(messages, start)
    if (preceding === undefined) return start
    start = preceding
  }
}

/**
 * One provider message beside the contributions that produced it.
 *
 * A chat row carries no origins — it is its own source, and the preview names it
 * from the message itself. A module message carries exactly one. An in-chat
 * message carries every prompt that was joined into it, in join order.
 */
/**
 * One assembled request message beside the preset modules it came from.
 *
 * `RequestMessage` rather than `Message`: DSH 0.2.0 separated "a durable
 * conversation message" from "a message used for one request", and the loop
 * hands the plugin the latter.
 */
export interface AttributedMessage {
  readonly message: RequestMessage
  readonly origins: readonly RoleplayPromptOrigin[]
}

function carried(messages: readonly RequestMessage[]): AttributedMessage[] {
  return messages.map(message => ({ message, origins: [] }))
}

/** Insert expanded in-chat modules using SillyTavern's depth, priority, and role ordering. */
export function injectAttributedInChatPrompts(
  messages: readonly AttributedMessage[],
  prompts: readonly RoleplayInChatPrompt[],
): AttributedMessage[] {
  if (prompts.length === 0) return [...messages]
  const transactionStart = trailingToolTransactionStart(messages.map(item => item.message))
  const result = messages.slice(0, transactionStart)
  const transaction = messages.slice(transactionStart)
  const baseLength = result.length
  const depths = [...new Set(prompts.map(prompt => prompt.depth))].sort((left, right) => left - right)
  for (const depth of depths) {
    const atDepth = prompts.filter(prompt => prompt.depth === depth)
    const orders = [...new Set(atDepth.map(prompt => prompt.order))].sort((left, right) => right - left)
    const injected: AttributedMessage[] = []
    for (const order of orders) {
      for (const role of ['system', 'user', 'assistant'] as const) {
        const contributing = atDepth
          .filter(prompt => prompt.order === order && prompt.role === role && prompt.content.trim() !== '')
        const content = contributing.map(prompt => prompt.content.trim()).join('\n')
        if (content === '') continue
        injected.push({
          message: requestOnlyModule(role, 'dsh-agent-rp-preset-in-chat', content),
          origins: contributing.flatMap(prompt => prompt.origin === undefined ? [] : [prompt.origin]),
        })
      }
    }
    result.splice(Math.max(0, baseLength - depth), 0, ...injected)
  }
  return [...result, ...transaction]
}

/** Insert expanded in-chat modules using SillyTavern's depth, priority, and role ordering. */
export function injectSillyTavernInChatPrompts(
  messages: readonly RequestMessage[],
  prompts: readonly RoleplayInChatPrompt[],
): RequestMessage[] {
  return injectAttributedInChatPrompts(carried(messages), prompts).map(item => item.message)
}

/**
 * Build one request-only preset module, keeping its SillyTavern role.
 *
 * DSH 0.2.0 constrains durable messages by role: `system` must carry the
 * `system-prompt` source kind and `assistant` must carry a model source, so
 * producer attribution now belongs on `user` and `developer` messages. A
 * SillyTavern preset module cannot follow that: its role is part of the preset's
 * meaning, and claiming a model produced an assistant-role module would be a
 * false provenance.
 *
 * These modules are **request-only** — they are assembled into `options.messages`
 * for one model request and never appended to the Session log, so they never
 * reach the durable-format validator that enforces those pairings. That is what
 * the cast asserts, and why it is confined to this one builder.
 * @param role - the module's SillyTavern role, sent to the provider as-is.
 * @param plugin - the Agent RP subsystem that assembled it.
 * @param text - the module's rendered content.
 * @returns an identified message shaped for one request.
 */
export function requestOnlyModule(role: RoleplayPromptRole, plugin: string, text: string): Message {
  // Built through the user-role factory so the identity and freezing are the
  // library's, then given back its SillyTavern role.
  const identified = createMessage({
    role: 'user',
    source: { kind: 'agent-rp', plugin },
    content: [{ type: 'text', text }],
  })
  return Object.freeze({ ...identified, role }) as unknown as Message
}

function orderedMessage(prompt: RoleplayOrderedPrompt): Message {
  return requestOnlyModule(prompt.role, 'dsh-agent-rp-preset', prompt.content)
}

/**
 * Place ordinary Prompt Manager modules on their original side of chatHistory,
 * retaining user/assistant roles instead of flattening them into the system slot.
 */
export function injectAttributedPromptPlan(
  messages: readonly AttributedMessage[],
  plan: RoleplayProviderPromptPlan,
): AttributedMessage[] {
  const history = plan.includeHistory ? injectAttributedInChatPrompts(messages, plan.inChat) : []
  const transactionStart = trailingToolTransactionStart(history.map(item => item.message))
  const ordered = (prompt: RoleplayOrderedPrompt): AttributedMessage => ({
    message: orderedMessage(prompt),
    origins: prompt.origin === undefined ? [] : [prompt.origin],
  })
  return [
    ...plan.beforeHistory.map(ordered),
    ...history.slice(0, transactionStart),
    ...plan.afterHistory.map(ordered),
    ...history.slice(transactionStart),
  ]
}

export function injectSillyTavernPromptPlan(
  messages: readonly RequestMessage[],
  plan: RoleplayProviderPromptPlan,
): RequestMessage[] {
  return injectAttributedPromptPlan(carried(messages), plan).map(item => item.message)
}

function isContinueInstruction(message: RequestMessage): boolean {
  const source = message.source as Message['source'] & { readonly operation?: unknown }
  return source.kind === 'agent-rp' && source.plugin === 'dsh-agent-rp-generation'
    && source.operation === 'continue'
}

function messageText(message: RequestMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function withContinuationPostfix(message: RequestMessage, postfix: SillyTavernPresetContinuation['postfix']): RequestMessage {
  if (postfix === '') return message
  const content = [...message.content]
  const textIndex = content.findLastIndex(block => block.type === 'text')
  const block = content[textIndex]
  if (block?.type !== 'text' || block.text.endsWith(' ')) return message
  content[textIndex] = { ...block, text: `${block.text}${postfix}` }
  return { ...message, content }
}

/** Apply SillyTavern continue-prefill or continue-nudge semantics after all prompt modules are placed. */
export function applyAttributedContinuation(
  messages: readonly AttributedMessage[],
  continuation: RoleplayContinuationPlan | undefined,
): AttributedMessage[] {
  if (continuation === undefined) return [...messages]
  const instructionIndex = messages.findLastIndex(item => isContinueInstruction(item.message))
  if (instructionIndex < 0) return [...messages]
  const assistantIndex = messages.findLastIndex((item, index) =>
    index < instructionIndex && item.message.role === 'assistant')
  if (assistantIndex < 0) return [...messages]
  const assistant = messages[assistantIndex]!
  if (continuation.prefill) {
    const retained = messages.filter((_item, index) => index !== assistantIndex && index !== instructionIndex)
    return [...retained, {
      message: withContinuationPostfix(assistant.message, continuation.postfix),
      origins: [...assistant.origins, { kind: 'continuation', label: '续写前缀' }],
    }]
  }
  const nudge = continuation.nudgePrompt
    .replace(/\{\{lastchatmessage\}\}/giu, messageText(assistant.message).trim()).trim()
  if (nudge === '') return [...messages]
  return messages.map((item, index) => index === instructionIndex
    ? {
        // The nudge replaces the continue instruction outright, so it is a fresh
        // request-only module rather than an edit of the original message.
        message: requestOnlyModule('system', 'dsh-agent-rp-preset', nudge),
        origins: [{ kind: 'continuation' as const, label: '续写推动' }],
      }
    : item)
}

export function applySillyTavernContinuation(
  messages: readonly RequestMessage[],
  continuation: RoleplayContinuationPlan | undefined,
): RequestMessage[] {
  return applyAttributedContinuation(carried(messages), continuation).map(item => item.message)
}

/**
 * Produce the exact provider-facing order, each message beside its sources.
 *
 * This is the one assembly: {@link prepareSillyTavernProviderMessages} is this
 * function with the attribution dropped, so the prompt preview can never show an
 * order the provider did not receive.
 */
export function prepareAttributedProviderMessages(
  messages: readonly RequestMessage[],
  plan: RoleplayProviderPromptPlan,
): AttributedMessage[] {
  return applyAttributedContinuation(
    injectAttributedPromptPlan(carried(messages), plan),
    plan.continuation,
  )
}

/** Produce the exact provider-facing order after prompt placement and continuation handling. */
export function prepareSillyTavernProviderMessages(
  messages: readonly RequestMessage[],
  plan: RoleplayProviderPromptPlan,
): RequestMessage[] {
  return prepareAttributedProviderMessages(messages, plan).map(item => item.message)
}

/**
 * Attribute one expanded Prompt Manager module.
 *
 * The two World Info markers are the only modules that are a join of several
 * independently-authored pieces, so they carry those pieces as `parts` and the
 * preview can open the block back up into one row per entry.
 */
function presetPromptOrigin(
  prompt: SillyTavernPresetPrompt,
  inputs: PresetPromptInputs,
): RoleplayPromptOrigin {
  const parts = prompt.identifier === 'worldInfoBefore' ? inputs.worldInfoBeforeOrigins
    : prompt.identifier === 'worldInfoAfter' ? inputs.worldInfoAfterOrigins
      : undefined
  return {
    kind: 'preset',
    label: prompt.name.trim() === '' ? prompt.identifier : prompt.name,
    id: prompt.identifier,
    ...(parts === undefined || parts.length === 0 ? {} : { parts }),
  }
}

/** Assemble every ordered module around the retained chat history. */
export function assembleSillyTavernPreset(
  preset: ImportedSillyTavernPreset,
  inputs: PresetPromptInputs,
): RoleplayAssembledPrompt {
  const byId = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]))
  const messages = macroMessages(inputs.session, inputs.pendingMessages ?? [])
  const macros = new ReplayableRoleplayMacros(inputs.macroContext ?? {
    ...(inputs.card === undefined ? {} : { card: inputs.card }),
    ...(inputs.characterName === undefined ? {} : { characterName: inputs.characterName }),
    ...(inputs.userName === undefined ? {} : { userName: inputs.userName }),
    ...(inputs.userPersona === undefined ? {} : { userPersona: inputs.userPersona }),
    messages,
    pendingInput: (inputs.pendingMessages ?? []).map(macroMessageText).filter(Boolean).join('\n'),
    entropy: JSON.stringify([
      String(inputs.session.id),
      inputs.session.seq,
      ...(inputs.pendingMessages ?? []).map(message => String(message.id)),
    ]),
    stableEntropy: String(inputs.session.id),
  })
  const diagnostics: PromptAssemblyDiagnostics = { templateRenders: 0, templateFailures: 0 }
  const before: RoleplayOrderedPrompt[] = []
  const deferred: RoleplayOrderedPrompt[] = []
  const after: RoleplayOrderedPrompt[] = []
  const inChat: RoleplayInChatPrompt[] = []
  const hasHistory = preset.order.some(entry => entry.enabled
    && byId.get(entry.identifier)?.identifier === 'chatHistory')
  let pastHistory = false
  let includeHistory = false
  let enabledPromptCount = 0
  for (const entry of preset.order) {
    if (!entry.enabled) continue
    const prompt = byId.get(entry.identifier)
    if (prompt === undefined) continue
    enabledPromptCount += 1
    if (prompt.identifier === 'chatHistory') {
      includeHistory = true
      pastHistory = true
      continue
    }
    const expanded = promptText(prompt, preset, inputs, macros, diagnostics)
    if (expanded === undefined || expanded.text.trim() === '') continue
    const origin = presetPromptOrigin(prompt, inputs)
    if (prompt.injectionPosition === 1) {
      inChat.push({
        role: prompt.role,
        content: expanded.text,
        depth: Number.isSafeInteger(prompt.injectionDepth) && (prompt.injectionDepth ?? -1) >= 0
          ? prompt.injectionDepth! : 4,
        order: typeof prompt.injectionOrder === 'number' && Number.isFinite(prompt.injectionOrder)
          ? prompt.injectionOrder : 100,
        origin,
      })
      continue
    }
    const ordered = { role: prompt.role, content: expanded.text, origin }
    if (hasHistory && !pastHistory && expanded.turnVariant) {
      deferred.push(ordered)
      continue
    }
    ;(pastHistory ? after : before).push(ordered)
  }
  if (inputs.mvuEnabled === true) {
    after.push({
      role: 'system',
      content: '每次回复都必须在正文末尾完整输出一个 <UpdateVariable><Analysis>…</Analysis><JSONPatch>[…]</JSONPatch></UpdateVariable>；没有变量变化时 JSONPatch 也输出空数组。',
      origin: { kind: 'mvu', label: '变量更新指令' },
    })
  }
  const continuation = continuationPlan(preset.continuation, macros)
  return {
    beforeHistory: before,
    afterHistory: [...deferred, ...after],
    inChat,
    includeHistory,
    ...(continuation === undefined ? {} : { continuation }),
    enabledPromptCount,
    unsupportedMacroCount: macros.unsupportedCount,
    templateRenderCount: diagnostics.templateRenders,
    templateFailureCount: diagnostics.templateFailures,
  }
}
