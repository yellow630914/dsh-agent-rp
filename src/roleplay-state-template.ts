/** Deterministic, script-free rendering of one state panel template over JSON state. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Authoring formats accepted for one state panel template. */
export type RoleplayStateTemplateFormat = 'html' | 'markdown' | 'text'

export const ROLEPLAY_STATE_TEMPLATE_FORMATS: readonly RoleplayStateTemplateFormat[] = [
  'html', 'markdown', 'text',
]

/** One authored panel template; the source is display-only and never reaches the model. */
export interface RoleplayStateTemplate {
  readonly format: RoleplayStateTemplateFormat
  readonly source: string
}

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly path: string }
  | { readonly kind: 'key' }
  | { readonly kind: 'each'; readonly path: string; readonly body: readonly Node[] }
  | { readonly kind: 'when'; readonly path: string; readonly negate: boolean; readonly body: readonly Node[] }

interface Scope {
  readonly root: JsonValue
  readonly item: JsonValue | undefined
  readonly key: string | undefined
}

const TAG = /\{\{\s*([^{}]*?)\s*\}\}/gu

const MAX_TEMPLATE_LENGTH = 256 * 1024
const MAX_OUTPUT_LENGTH = 512 * 1024
const MAX_ITERATIONS = 512

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
}

/**
 * Resolve one JSON Pointer against the state root or the current loop item.
 *
 * A missing path is not an error: a template written for an older scheme must
 * keep rendering after the scheme gains or loses a field, so every unresolved
 * pointer reads as absent instead of failing the whole panel.
 * @param scope - current root, loop item and loop key.
 * @param path - absolute pointer, or one starting with `.` for the loop item.
 * @returns the value, or undefined when any segment is missing.
 */
function resolve(scope: Scope, path: string): JsonValue | undefined {
  const relative = path.startsWith('.')
  const pointer = relative ? path.slice(1) : path
  let current: JsonValue | undefined = relative ? scope.item : scope.root
  if (pointer === '' || pointer === '/') return current
  if (!pointer.startsWith('/')) return undefined
  for (const raw of pointer.slice(1).split('/')) {
    const segment = unescapeSegment(raw)
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, JsonValue>)[segment]
  }
  return current
}

function present(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === '' || value === 0) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function stringify(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => character === '&' ? '&amp;'
    : character === '<' ? '&lt;'
      : character === '>' ? '&gt;'
        : character === '"' ? '&quot;' : '&#39;')
}

function entries(value: JsonValue | undefined): readonly { readonly key: string; readonly item: JsonValue }[] {
  if (Array.isArray(value)) return value.map((item, index) => ({ key: String(index), item }))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, item]) => ({ key, item }))
  }
  return []
}

/** Parse one template source into a bounded node tree without evaluating anything. */
export function parseRoleplayStateTemplate(source: string): readonly Node[] {
  if (source.length > MAX_TEMPLATE_LENGTH) throw new Error('状态栏模板过大')
  const stack: { readonly opener: string; readonly nodes: Node[] }[] = [{ opener: '', nodes: [] }]
  let cursor = 0
  TAG.lastIndex = 0
  for (let match = TAG.exec(source); match !== null; match = TAG.exec(source)) {
    const current = stack.at(-1)!
    if (match.index > cursor) current.nodes.push({ kind: 'text', text: source.slice(cursor, match.index) })
    cursor = match.index + match[0].length
    const body = match[1] ?? ''
    if (body === '/' || body === '/#' || body === '/?' || body === '/!') {
      if (stack.length === 1) throw new Error(`状态栏模板有多余的结束标记 ${JSON.stringify(match[0])}`)
      stack.pop()
      continue
    }
    if (body.startsWith('#')) {
      stack.push({ opener: match[0], nodes: [] })
      const frame = stack.at(-1)!
      const parent = stack.at(-2)!
      parent.nodes.push({ kind: 'each', path: body.slice(1).trim(), body: frame.nodes })
      continue
    }
    if (body.startsWith('?') || body.startsWith('!')) {
      stack.push({ opener: match[0], nodes: [] })
      const frame = stack.at(-1)!
      const parent = stack.at(-2)!
      parent.nodes.push({
        kind: 'when',
        path: body.slice(1).trim(),
        negate: body.startsWith('!'),
        body: frame.nodes,
      })
      continue
    }
    if (body === '@') {
      current.nodes.push({ kind: 'key' })
      continue
    }
    current.nodes.push({ kind: 'value', path: body })
  }
  if (cursor < source.length) stack.at(-1)!.nodes.push({ kind: 'text', text: source.slice(cursor) })
  if (stack.length !== 1) throw new Error(`状态栏模板缺少结束标记 ${JSON.stringify(stack.at(-1)!.opener)}`)
  return stack[0]!.nodes
}

function render(
  nodes: readonly Node[],
  scope: Scope,
  escape: (value: string) => string,
  budget: { remaining: number },
): string {
  let out = ''
  for (const node of nodes) {
    if (budget.remaining <= 0) break
    // Composite nodes spend the budget inside their own recursion, so only the
    // leaves charge it here; charging both would truncate long panels early.
    if (node.kind === 'when') {
      const matched = present(resolve(scope, node.path))
      out += matched === node.negate ? '' : render(node.body, scope, escape, budget)
      continue
    }
    if (node.kind === 'each') {
      for (const entry of entries(resolve(scope, node.path)).slice(0, MAX_ITERATIONS)) {
        if (budget.remaining <= 0) break
        out += render(node.body, { ...scope, item: entry.item, key: entry.key }, escape, budget)
      }
      continue
    }
    const raw = node.kind === 'text'
      ? node.text
      : node.kind === 'key' ? escape(scope.key ?? '') : escape(stringify(resolve(scope, node.path)))
    const piece = raw.length > budget.remaining ? raw.slice(0, budget.remaining) : raw
    budget.remaining -= piece.length
    out += piece
  }
  return out
}

/**
 * Fill one authored template with the current state values.
 *
 * Rendering is a pure function of the template and the state: no clock, no
 * randomness and no script execution, so the same state always produces the
 * same panel and the template can never influence model-visible content.
 * @param template - authored source plus its format.
 * @param state - current JSON state for this scheme.
 * @returns rendered source in the template's own format.
 */
export function renderRoleplayStateTemplate(
  template: RoleplayStateTemplate,
  state: JsonValue,
): string {
  const nodes = parseRoleplayStateTemplate(template.source)
  const escape = template.format === 'html' ? escapeHtml : (value: string) => value
  return render(nodes, { root: state, item: state, key: undefined }, escape, { remaining: MAX_OUTPUT_LENGTH })
}

/** Validate an authored template without rendering it against real state. */
export function parseRoleplayStateTemplateValue(value: unknown, label: string): RoleplayStateTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}无效`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'format' && key !== 'source')
    || typeof record.source !== 'string' || record.source.length > MAX_TEMPLATE_LENGTH
    || !ROLEPLAY_STATE_TEMPLATE_FORMATS.includes(record.format as RoleplayStateTemplateFormat)) {
    throw new Error(`${label}无效`)
  }
  parseRoleplayStateTemplate(record.source)
  return { format: record.format as RoleplayStateTemplateFormat, source: record.source }
}
