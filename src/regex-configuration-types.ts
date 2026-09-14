/** Durable session-local regex management records. */

/**
 * Which imported collection one regex rule came from.
 *
 * The same three ordered collections feed both the prompt view and the display
 * view, so `(owner, index)` addresses a rule identically on either side.
 */
export type RegexScriptOwner = 'regex' | 'prompt-policy' | 'actor'

/** Editable safe subset of one imported regex rule. */
export interface RegexEditableScript {
  readonly scriptName: string
  readonly findRegex: string
  readonly replaceString: string
  readonly trimStrings: readonly string[]
  /** SillyTavern placements: 1 is the player's message, 2 the character's. */
  readonly placement: readonly number[]
  readonly disabled: boolean
  /** Display view only. */
  readonly markdownOnly: boolean
  /** Prompt view only. */
  readonly promptOnly: boolean
  readonly runOnEdit: boolean
  readonly substituteRegex: number
  /** Floor-depth window; `null` is "no bound on this side". */
  readonly minDepth: number | null
  readonly maxDepth: number | null
}

/** One rule override addressed within an immutable imported collection. */
export interface RegexScriptOverride {
  readonly owner: RegexScriptOwner
  readonly index: number
  readonly deleted: boolean
  readonly script?: RegexEditableScript
}

/**
 * Complete session-local regex overlay snapshot.
 *
 * Imported rules stay immutable; this records what this Session decided on top
 * of them. It is a durable Session record, so a branch inherits it with the
 * rest of the log and keeps editing its own copy.
 */
export interface RegexConfigurationState {
  readonly format: 0
  readonly revision: number
  readonly overrides: readonly RegexScriptOverride[]
  /** Rules authored in this Session, applied after every imported collection. */
  readonly added: readonly RegexEditableScript[]
}

/** Browser mutation accepted by the Session regex manager. */
export type RegexConfigurationRequest =
  | { readonly operation: 'toggle'; readonly revision: number; readonly owner: RegexScriptOwner; readonly index: number; readonly disabled: boolean }
  | { readonly operation: 'edit'; readonly revision: number; readonly owner: RegexScriptOwner; readonly index: number; readonly script: RegexEditableScript }
  | { readonly operation: 'delete'; readonly revision: number; readonly owner: RegexScriptOwner; readonly index: number; readonly deleted: boolean }
  | { readonly operation: 'reset-script'; readonly revision: number; readonly owner: RegexScriptOwner; readonly index: number }
  | { readonly operation: 'add'; readonly revision: number; readonly script: RegexEditableScript }
  | { readonly operation: 'edit-added'; readonly revision: number; readonly index: number; readonly script: RegexEditableScript }
  | { readonly operation: 'remove-added'; readonly revision: number; readonly index: number }
  | { readonly operation: 'reset-all'; readonly revision: number }
