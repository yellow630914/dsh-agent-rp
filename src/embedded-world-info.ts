/** Standalone SillyTavern World Info projection preserving Character Card source fields. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  CharacterCardVersion,
  ImportedCharacterCard,
  ImportedLorebookEntry,
  ImportedWorldInfo,
} from './import/types.ts'

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function secondaryLogic(value: ImportedLorebookEntry['secondaryLogic']): number {
  if (value === 'and-any') return 0
  if (value === 'not-all') return 1
  if (value === 'not-any') return 2
  return 3
}

function position(entry: ImportedLorebookEntry): number {
  return entry.position === 'before_char' ? 0 : entry.position === 'at_depth' ? 4 : 1
}

function role(entry: ImportedLorebookEntry): number | undefined {
  return entry.injectionRole === 'system' ? 0
    : entry.injectionRole === 'user' ? 1 : entry.injectionRole === 'assistant' ? 2 : undefined
}

function characterBookEntry(
  raw: JsonValue | undefined,
  entry: ImportedLorebookEntry,
  version: CharacterCardVersion,
): Record<string, JsonValue> {
  const original = record(raw) ?? {}
  const extensions = record(original.extensions) ?? {}
  const injectionRole = role(entry)
  const hasAuthoredLabel = original.name !== undefined || original.comment !== undefined
  return {
    ...structuredClone(original),
    id: original.id ?? original.uid ?? entry.sourceId,
    keys: [...entry.keys],
    secondary_keys: [...entry.secondaryKeys],
    ...(hasAuthoredLabel || entry.name === undefined ? {} : { name: entry.name }),
    ...(hasAuthoredLabel || entry.comment === undefined ? {} : { comment: entry.comment }),
    content: entry.content,
    enabled: entry.enabled,
    insertion_order: entry.insertionOrder,
    selective: entry.selective,
    constant: entry.constant,
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    position: entry.position === 'before_char' ? 'before_char'
      : entry.position === 'at_depth' ? 4 : 'after_char',
    ...(entry.injectionDepth === undefined ? {} : { depth: entry.injectionDepth }),
    ...(injectionRole === undefined ? {} : { role: injectionRole }),
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    ...(version === 3 || entry.useRegex ? { use_regex: entry.useRegex } : {}),
    extensions: {
      ...structuredClone(extensions),
      ...(entry.ignoreBudget ? { ignore_budget: true } : {}),
    },
  }
}

function characterBook(worldInfo: ImportedWorldInfo, version: CharacterCardVersion): JsonValue {
  const original = record(worldInfo.raw) ?? {}
  const rawEntries = Array.isArray(original.entries)
    ? original.entries
    : Object.values(record(original.entries) ?? {})
  return {
    ...structuredClone(original),
    ...(worldInfo.name === undefined ? {} : { name: worldInfo.name }),
    ...(worldInfo.lorebook.scanDepth === undefined ? {} : { scan_depth: worldInfo.lorebook.scanDepth }),
    ...(worldInfo.lorebook.tokenBudget === undefined ? {} : { token_budget: worldInfo.lorebook.tokenBudget }),
    recursive_scanning: worldInfo.lorebook.recursiveScanning,
    extensions: structuredClone(record(original.extensions) ?? {}),
    entries: worldInfo.lorebook.entries.map((entry, index) => characterBookEntry(rawEntries[index], entry, version)),
  }
}

function projectedEntry(raw: JsonValue | undefined, entry: ImportedLorebookEntry): Record<string, JsonValue> {
  const original = record(raw) ?? {}
  const extensions = record(original.extensions) ?? {}
  const injectionRole = role(entry)
  return {
    ...structuredClone(original),
    uid: original.uid ?? original.id ?? entry.sourceId,
    key: [...entry.keys],
    keysecondary: [...entry.secondaryKeys],
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.comment === undefined ? {} : { comment: entry.comment }),
    content: entry.content,
    disable: !entry.enabled,
    order: entry.insertionOrder,
    selective: entry.selective,
    constant: entry.constant,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    selectiveLogic: secondaryLogic(entry.secondaryLogic),
    position: position(entry),
    ...(entry.injectionDepth === undefined ? {} : { depth: entry.injectionDepth }),
    ...(injectionRole === undefined ? {} : { role: injectionRole }),
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    ...(entry.scanDepth === undefined ? {} : { scanDepth: entry.scanDepth }),
    useRegex: entry.useRegex,
    extensions: {
      ...structuredClone(extensions),
      ...(entry.ignoreBudget ? { ignore_budget: true } : {}),
    },
  }
}

/** Convert a validated embedded book into deterministic standalone JSON bytes. */
export function embeddedWorldInfoAsset(card: ImportedCharacterCard): {
  readonly data: Uint8Array
  readonly filename: string
} | undefined {
  if (card.lorebook === undefined) return undefined
  const root = record(card.raw)
  const cardData = card.version === 1 ? root : record(root?.data)
  const original = record(cardData?.character_book) ?? {}
  const originalEntries = Array.isArray(original.entries) ? original.entries : []
  const worldInfo: Record<string, JsonValue> = {
    ...structuredClone(original),
    ...(card.lorebook.name === undefined ? {} : { name: card.lorebook.name }),
    ...(card.lorebook.scanDepth === undefined ? {} : { scan_depth: card.lorebook.scanDepth }),
    ...(card.lorebook.tokenBudget === undefined ? {} : { token_budget: card.lorebook.tokenBudget }),
    recursive_scanning: card.lorebook.recursiveScanning,
    entries: card.lorebook.entries.map((entry, index) => projectedEntry(originalEntries[index], entry)),
  }
  const name = (card.lorebook.name?.trim() || `${card.nickname?.trim() || card.name}的世界书`)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .slice(0, 200)
  return {
    data: new TextEncoder().encode(`${JSON.stringify(worldInfo, null, 2)}\n`),
    filename: `${name || '角色内置世界书'}.json`,
  }
}

/** Blank entry used as the base for a newly added lorebook row. */
export function blankLorebookEntry(sourceId: string): ImportedLorebookEntry {
  return {
    sourceId,
    keys: [],
    secondaryKeys: [],
    content: '',
    enabled: true,
    insertionOrder: 100,
    selective: false,
    constant: false,
    caseSensitive: false,
    matchWholeWords: false,
    secondaryLogic: 'and-any',
    position: 'after_char',
    useRegex: false,
    hasDecorators: false,
    ignoreBudget: false,
  }
}

/**
 * Rebuild standalone World Info JSON from an edited entry list.
 *
 * Each edited row cites the index it came from so its original JSON object can
 * be carried through: SillyTavern books routinely hold fields this runtime does
 * not model, and an edit must not silently drop them. A row citing no index is
 * newly added and starts from an empty object. Omitted rows are the deletion.
 * @param worldInfo - the stored book being edited.
 * @param rows - complete replacement list, in the order they should be stored.
 * @param scanDepth - book-level default depth to store; `undefined` removes it,
 *   which is how the editor expresses "this book sets no default of its own".
 *   Required rather than optional so a caller cannot silently mean "keep".
 * @returns standalone World Info JSON ready to serialize.
 */
export function worldInfoWithEntries(
  worldInfo: ImportedWorldInfo,
  rows: readonly { readonly sourceIndex?: number; readonly entry: ImportedLorebookEntry }[],
  scanDepth: number | undefined,
): JsonValue {
  const original = record(worldInfo.raw) ?? {}
  const rawEntries = Array.isArray(original.entries)
    ? original.entries
    : Object.values(record(original.entries) ?? {})
  // Added rows continue the book's own uid sequence instead of leaking this
  // runtime's internal row name, so an edited book still reads like any other
  // SillyTavern export.
  let nextUid = rawEntries.reduce<number>((highest, raw) => {
    const uid = record(raw)?.uid
    return typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= highest ? uid + 1 : highest
  }, rawEntries.length)
  // Clone first and drop the key outright when the edit removed the default:
  // overriding in place keeps scan_depth where the file had it, so a book that
  // keeps its default still serializes byte-identically.
  const carried = structuredClone(original)
  if (scanDepth === undefined) delete carried.scan_depth
  return {
    ...carried,
    ...(worldInfo.name === undefined ? {} : { name: worldInfo.name }),
    ...(scanDepth === undefined ? {} : { scan_depth: scanDepth }),
    ...(worldInfo.lorebook.tokenBudget === undefined ? {} : { token_budget: worldInfo.lorebook.tokenBudget }),
    recursive_scanning: worldInfo.lorebook.recursiveScanning,
    entries: rows.map(row => projectedEntry(
      row.sourceIndex === undefined ? { uid: nextUid++ } : rawEntries[row.sourceIndex],
      row.entry,
    )),
  }
}

/** Rebuild the exchange-format `character_book` from one bound World Info snapshot. */
export function characterCardWithWorldInfo(
  card: ImportedCharacterCard,
  worldInfo: ImportedWorldInfo | undefined,
): JsonValue {
  const raw = structuredClone(card.raw)
  const root = record(raw)
  const cardData = card.version === 1 ? root : record(root?.data)
  if (root === undefined || cardData === undefined) throw new Error('角色卡原始数据缺少可导出的角色字段')
  if (worldInfo === undefined) delete cardData.character_book
  else cardData.character_book = characterBook(worldInfo, card.version)
  return raw
}
