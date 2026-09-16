/**
 * Where one piece of the provider prompt came from.
 *
 * The final message array is flat: preset modules, World Info entries, script
 * injections and chat rows all arrive as plain `{ role, content }`. Once they
 * are merged — several in-chat modules join into one message, several World
 * Info entries join into one `worldInfoBefore` module — the source is gone, and
 * no amount of reading the final array recovers it.
 *
 * So each contribution carries its origin from the point of construction, where
 * the identity is still known. Nothing in the send path reads these; they exist
 * for the prompt preview, which is why every field is optional to produce and a
 * missing origin degrades to "unattributed" rather than failing an assembly.
 */

/** Which subsystem authored one prompt contribution. */
export type RoleplayPromptOriginKind =
  | 'preset'
  | 'world-info'
  | 'card'
  | 'persona'
  | 'memory'
  | 'state'
  | 'mvu'
  | 'tavern-helper'
  | 'history'
  | 'continuation'

/**
 * One attributable prompt contribution.
 *
 * `label` is what a reader should see; `detail` qualifies it (the book a World
 * Info entry belongs to, the keys that activated it). `parts` exists because a
 * single module can be a join of several independently-authored pieces — the
 * `worldInfoBefore` marker is one module holding every before-character entry —
 * and the preview must be able to open it back up.
 */
export interface RoleplayPromptOrigin {
  readonly kind: RoleplayPromptOriginKind
  readonly label: string
  readonly detail?: string
  /** Stable identity within its kind, when one exists (preset identifier, entry id). */
  readonly id?: string
  /** Independently-authored pieces joined into this one contribution, in order. */
  readonly parts?: readonly RoleplayPromptOrigin[]
}

/** Describe one World Info entry as a prompt origin. */
export function worldInfoOrigin(input: {
  readonly bookName: string
  readonly entryId: string
  readonly entryName?: string
  readonly matchedKeys: readonly string[]
  readonly constant: boolean
}): RoleplayPromptOrigin {
  const name = input.entryName?.trim()
  // An unnamed entry is addressed by its source id, which is what the World Info
  // panel shows too, so the two surfaces name the same row the same way.
  const label = name === undefined || name === '' ? input.entryId : name
  const cause = input.constant ? '常驻'
    : input.matchedKeys.length === 0 ? undefined : `关键词 ${input.matchedKeys.join('、')}`
  return {
    kind: 'world-info',
    label,
    id: input.entryId,
    detail: cause === undefined ? input.bookName : `${input.bookName} · ${cause}`,
  }
}
