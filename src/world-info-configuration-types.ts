/** Durable session-local World Info management records. */

/** Editable safe subset of one normalized lorebook entry. */
export interface WorldInfoEditableEntry {
  readonly name?: string
  readonly comment?: string
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly content: string
  readonly enabled: boolean
  readonly insertionOrder: number
  readonly selective: boolean
  readonly constant: boolean
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly secondaryLogic: 'and-any' | 'and-all' | 'not-any' | 'not-all'
  readonly scanDepth?: number
  readonly position: 'before_char' | 'after_char' | 'at_depth'
  readonly injectionDepth?: number
  readonly injectionRole?: 'system' | 'user' | 'assistant'
  readonly priority?: number
  readonly ignoreBudget: boolean
}

/** One entry override addressed within an immutable imported book. */
export interface WorldInfoEntryOverride {
  readonly bookId: string
  readonly entryIndex: number
  readonly deleted: boolean
  readonly entry?: WorldInfoEditableEntry
}

/**
 * One book-level override addressed within an immutable imported book.
 *
 * The record's presence is what states "this Session decides the value" — so an
 * omitted `scanDepth` inside a present record means the Session deliberately
 * removed the book's own default, which is a different outcome from having no
 * record at all (follow the file).
 */
export interface WorldInfoBookOverride {
  readonly bookId: string
  readonly scanDepth?: number
}

/** Complete session-local World Info overlay snapshot. */
export interface WorldInfoConfigurationState {
  readonly format: 0
  readonly revision: number
  readonly overrides: readonly WorldInfoEntryOverride[]
  /** Book-level settings this Session overrides; omitted entirely by snapshots written before book overrides existed. */
  readonly bookOverrides?: readonly WorldInfoBookOverride[]
  /** Optional player-selected aggregate cap across every active book; omitted records do not add a plugin cap. */
  readonly tokenBudget?: number
}

/** Browser mutation accepted by the World Info manager. */
export type WorldInfoConfigurationRequest =
  | { readonly operation: 'toggle'; readonly revision: number; readonly bookId: string; readonly entryIndex: number; readonly enabled: boolean }
  | { readonly operation: 'set-book-enabled'; readonly revision: number; readonly bookId: string; readonly enabled: boolean }
  | { readonly operation: 'reset-book'; readonly revision: number; readonly bookId: string }
  | { readonly operation: 'set-book-scan-depth'; readonly revision: number; readonly bookId: string; readonly scanDepth?: number }
  | { readonly operation: 'reset-book-scan-depth'; readonly revision: number; readonly bookId: string }
  | { readonly operation: 'edit'; readonly revision: number; readonly bookId: string; readonly entryIndex: number; readonly entry: WorldInfoEditableEntry }
  | { readonly operation: 'delete'; readonly revision: number; readonly bookId: string; readonly entryIndex: number; readonly deleted: boolean }
  | { readonly operation: 'reset-entry'; readonly revision: number; readonly bookId: string; readonly entryIndex: number }
  | { readonly operation: 'reset-all'; readonly revision: number }
  | { readonly operation: 'set-budget'; readonly revision: number; readonly tokenBudget: number }
