/** Pure session-local regex overlay parsing, persistence, and state transitions. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ImportedRegexScript } from './import/types.ts'
import type {
  RegexConfigurationRequest,
  RegexConfigurationState,
  RegexEditableScript,
  RegexScriptOverride,
  RegexScriptOwner,
} from './regex-configuration-types.ts'

/** One immutable imported collection addressable by the session overlay. */
export interface SessionRegexSource {
  readonly owner: RegexScriptOwner
  readonly scripts: readonly ImportedRegexScript[]
}

const RESULT_PREFIX = 'agent-rp-regex-v0:'
const INITIAL_STATE: RegexConfigurationState = { format: 0, revision: 0, overrides: [], added: [] }

/** Largest number of Session-authored rules accepted, mirroring the pack import ceiling. */
export const MAX_SESSION_REGEX_SCRIPTS = 256

const OWNERS: readonly RegexScriptOwner[] = ['regex', 'prompt-policy', 'actor']

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}必须是非负整数`)
  return value as number
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  return value
}

function textArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label}必须是文本数组`)
  return [...value] as string[]
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`)
  return value
}

function depth(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || (value as number) < -1) throw new Error(`${label}必须是 -1 或更大的整数`)
  return value as number
}

function owner(value: unknown, label: string): RegexScriptOwner {
  if (typeof value !== 'string' || !OWNERS.includes(value as RegexScriptOwner)) throw new Error(`${label}无效`)
  return value as RegexScriptOwner
}

/**
 * Validate one browser-supplied rule.
 *
 * The expression itself is stored exactly as written: an unparseable one is a
 * rule that never matches, which the existing summary already reports, and
 * refusing it here would keep a half-typed pattern from ever being saved.
 */
export function editableRegexScript(value: unknown, label: string): RegexEditableScript {
  const script = object(value, label)
  const placement = [...new Set(script.placement === undefined
    ? []
    : (Array.isArray(script.placement) ? script.placement : [script.placement])
      .map((item, index) => nonNegativeInteger(item, `${label}.placement[${index}]`)))]
  if (placement.length === 0) throw new Error(`${label}至少要作用于一种消息`)
  const substituteRegex = nonNegativeInteger(script.substituteRegex ?? 0, `${label}.substituteRegex`)
  const minDepth = depth(script.minDepth, `${label}.minDepth`)
  const maxDepth = depth(script.maxDepth, `${label}.maxDepth`)
  if (minDepth !== null && maxDepth !== null && maxDepth >= 0 && minDepth >= 0 && maxDepth < minDepth) {
    throw new Error(`${label}的深度上限不能小于下限`)
  }
  return {
    scriptName: text(script.scriptName ?? '', `${label}.scriptName`),
    findRegex: text(script.findRegex ?? '', `${label}.findRegex`),
    replaceString: text(script.replaceString ?? '', `${label}.replaceString`),
    trimStrings: textArray(script.trimStrings ?? [], `${label}.trimStrings`),
    placement,
    disabled: boolean(script.disabled ?? false, `${label}.disabled`),
    markdownOnly: boolean(script.markdownOnly ?? false, `${label}.markdownOnly`),
    promptOnly: boolean(script.promptOnly ?? false, `${label}.promptOnly`),
    runOnEdit: boolean(script.runOnEdit ?? false, `${label}.runOnEdit`),
    substituteRegex,
    minDepth,
    maxDepth,
  }
}

/** Project one imported rule into the editable subset the browser shows. */
export function editableFromImported(script: ImportedRegexScript): RegexEditableScript {
  return {
    scriptName: script.scriptName,
    findRegex: script.findRegex,
    replaceString: script.replaceString,
    trimStrings: [...script.trimStrings],
    placement: [...script.placement],
    disabled: script.disabled,
    markdownOnly: script.markdownOnly,
    promptOnly: script.promptOnly,
    runOnEdit: script.runOnEdit,
    substituteRegex: script.substituteRegex,
    minDepth: script.minDepth,
    maxDepth: script.maxDepth,
  }
}

/** Merge one editable value onto an imported rule, keeping fields the form cannot express. */
export function applyEditableRegexScript(
  script: ImportedRegexScript,
  value: RegexEditableScript,
): ImportedRegexScript {
  return { ...script, ...value }
}

/** Materialize one Session-authored rule as an ordinary imported rule. */
export function importedFromEditable(value: RegexEditableScript, index: number): ImportedRegexScript {
  return { id: `agent-rp-session-regex-${String(index)}`, ...value }
}

function parseOverride(value: unknown, index: number): RegexScriptOverride {
  const record = object(value, `overrides[${index}]`)
  return {
    owner: owner(record.owner, `overrides[${index}].owner`),
    index: nonNegativeInteger(record.index, `overrides[${index}].index`),
    deleted: boolean(record.deleted, `overrides[${index}].deleted`),
    ...(record.script === undefined
      ? {}
      : { script: editableRegexScript(record.script, `overrides[${index}].script`) }),
  }
}

function parseState(value: unknown): RegexConfigurationState {
  const record = object(value, '正则配置')
  if (record.format !== 0 || !Array.isArray(record.overrides)) throw new Error('正则配置格式无效')
  const parsed = record.overrides.map(parseOverride)
  const keys = parsed.map(item => `${item.owner} ${String(item.index)}`)
  if (new Set(keys).size !== keys.length) throw new Error('正则配置包含重复条目')
  if (record.added !== undefined && !Array.isArray(record.added)) throw new Error('正则配置格式无效')
  const added = (record.added ?? []).map((item, index) => editableRegexScript(item, `added[${index}]`))
  if (added.length > MAX_SESSION_REGEX_SCRIPTS) throw new Error('正则配置包含过多自建规则')
  return {
    format: 0,
    revision: nonNegativeInteger(record.revision, 'revision'),
    // An override that neither deletes nor edits carries no information.
    overrides: parsed.filter(item => item.deleted || item.script !== undefined),
    added,
  }
}

/** Parse one private regex manager request. */
export function parseRegexConfigurationRequest(source: string): RegexConfigurationRequest {
  let value: unknown
  try { value = JSON.parse(source) } catch (error: unknown) {
    throw new Error('正则操作请求不是有效 JSON', { cause: error })
  }
  const record = object(value, '正则操作请求')
  const revision = nonNegativeInteger(record.revision, 'revision')
  if (record.operation === 'reset-all') return { operation: 'reset-all', revision }
  if (record.operation === 'add') {
    return { operation: 'add', revision, script: editableRegexScript(record.script, 'script') }
  }
  if (record.operation === 'edit-added') {
    return {
      operation: 'edit-added',
      revision,
      index: nonNegativeInteger(record.index, 'index'),
      script: editableRegexScript(record.script, 'script'),
    }
  }
  if (record.operation === 'remove-added') {
    return { operation: 'remove-added', revision, index: nonNegativeInteger(record.index, 'index') }
  }
  const addressed = {
    owner: owner(record.owner, '正则操作请求.owner'),
    index: nonNegativeInteger(record.index, 'index'),
  }
  if (record.operation === 'toggle') {
    return { operation: 'toggle', revision, ...addressed, disabled: boolean(record.disabled, 'disabled') }
  }
  if (record.operation === 'edit') {
    return { operation: 'edit', revision, ...addressed, script: editableRegexScript(record.script, 'script') }
  }
  if (record.operation === 'delete') {
    return { operation: 'delete', revision, ...addressed, deleted: boolean(record.deleted, 'deleted') }
  }
  if (record.operation === 'reset-script') return { operation: 'reset-script', revision, ...addressed }
  throw new Error('未知的正则操作')
}

/** Encode one complete overlay snapshot into a supported command result. */
export function encodeRegexConfiguration(state: RegexConfigurationState): string {
  return `${RESULT_PREFIX}${JSON.stringify(state)}`
}

/** Decode one overlay snapshot, declining unrelated command output. */
export function decodeRegexConfiguration(source: string | undefined): RegexConfigurationState | undefined {
  if (source?.startsWith(RESULT_PREFIX) !== true) return undefined
  let value: unknown
  try { value = JSON.parse(source.slice(RESULT_PREFIX.length)) } catch (error: unknown) {
    throw new Error('正则配置结果不是有效 JSON', { cause: error })
  }
  return parseState(value)
}

/** Read the last complete regex overlay snapshot from one Session. */
export function readRegexConfiguration(events: readonly SessionEvent[]): RegexConfigurationState {
  let state = INITIAL_STATE
  for (const event of events) {
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue
    state = decodeRegexConfiguration(event.data.text) ?? state
  }
  return state
}

/** One imported or Session-authored rule after the overlay, with what the manager must show. */
export interface ConfiguredRegexScript {
  readonly owner: RegexScriptOwner | 'session'
  readonly index: number
  readonly script: ImportedRegexScript
  readonly modified: boolean
  readonly deleted: boolean
}

/**
 * Apply one session overlay across every imported collection.
 *
 * Deleted rules are retained so the manager can show and restore them; they are
 * reported as `deleted` and also forced `disabled`, so a consumer that only
 * looks at the rule still behaves correctly.
 * @param sources - imported collections in the order they execute.
 * @param state - this Session's overlay.
 * @returns every addressable rule, in execution order.
 */
export function configuredRegexScripts(
  sources: readonly SessionRegexSource[],
  state: RegexConfigurationState,
): readonly ConfiguredRegexScript[] {
  const overrides = new Map(state.overrides.map(item => [`${item.owner} ${String(item.index)}`, item]))
  const imported = sources.flatMap(source => source.scripts.map((script, index) => {
    const override = overrides.get(`${source.owner} ${String(index)}`)
    const configured = override?.script === undefined ? script : applyEditableRegexScript(script, override.script)
    const deleted = override?.deleted === true
    return {
      owner: source.owner,
      index,
      script: deleted ? { ...configured, disabled: true } : configured,
      modified: override?.script !== undefined,
      deleted,
    }
  }))
  return [
    ...imported,
    ...state.added.map((value, index) => ({
      owner: 'session' as const,
      index,
      script: importedFromEditable(value, index),
      modified: true,
      deleted: false,
    })),
  ]
}

/** Rules a consumer should actually execute, in execution order. */
export function activeRegexScripts(
  sources: readonly SessionRegexSource[],
  state: RegexConfigurationState,
): readonly ImportedRegexScript[] {
  return configuredRegexScripts(sources, state)
    .filter(entry => !entry.deleted)
    .map(entry => entry.script)
}

function replaceOverride(
  state: RegexConfigurationState,
  target: { readonly owner: RegexScriptOwner; readonly index: number },
  update: (current: RegexScriptOverride) => RegexScriptOverride | undefined,
): RegexConfigurationState {
  const key = `${target.owner} ${String(target.index)}`
  const current = state.overrides.find(item => `${item.owner} ${String(item.index)}` === key)
    ?? { owner: target.owner, index: target.index, deleted: false }
  const updated = update(current)
  const next = updated?.deleted === false && updated.script === undefined ? undefined : updated
  return {
    ...state,
    revision: state.revision + 1,
    overrides: [
      ...state.overrides.filter(item => `${item.owner} ${String(item.index)}` !== key),
      ...(next === undefined ? [] : [next]),
    ],
  }
}

/** Apply one validated request against the currently imported collections. */
export function configureRegex(
  state: RegexConfigurationState,
  request: RegexConfigurationRequest,
  sources: readonly SessionRegexSource[],
): RegexConfigurationState {
  if (request.revision !== state.revision) throw new Error('正则已在别处改变，请刷新后重试')
  if (request.operation === 'reset-all') {
    return { format: 0, revision: state.revision + 1, overrides: [], added: [] }
  }
  if (request.operation === 'add') {
    if (state.added.length >= MAX_SESSION_REGEX_SCRIPTS) throw new Error('这段会话的自建正则已达上限')
    return { ...state, revision: state.revision + 1, added: [...state.added, request.script] }
  }
  if (request.operation === 'edit-added' || request.operation === 'remove-added') {
    if (state.added[request.index] === undefined) throw new Error('目标正则不存在')
    return {
      ...state,
      revision: state.revision + 1,
      added: request.operation === 'remove-added'
        ? state.added.filter((_script, index) => index !== request.index)
        : state.added.map((script, index) => index === request.index ? request.script : script),
    }
  }
  const source = sources.find(item => item.owner === request.owner)
  const original = source?.scripts[request.index]
  if (source === undefined || original === undefined) throw new Error('目标正则不存在')
  if (request.operation === 'reset-script') return replaceOverride(state, request, () => undefined)
  if (request.operation === 'edit') {
    return replaceOverride(state, request, current => ({ ...current, script: request.script }))
  }
  if (request.operation === 'delete') {
    return replaceOverride(state, request, current => ({ ...current, deleted: request.deleted }))
  }
  return replaceOverride(state, request, current => {
    const script = { ...(current.script ?? editableFromImported(original)), disabled: request.disabled }
    // Toggling back to the imported value leaves no override behind, so a rule
    // the player put back is indistinguishable from one they never touched.
    const matchesOriginal = JSON.stringify(script) === JSON.stringify(editableFromImported(original))
    return matchesOriginal
      ? { owner: current.owner, index: current.index, deleted: current.deleted }
      : { ...current, script }
  })
}
