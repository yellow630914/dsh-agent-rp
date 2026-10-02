/** Where a turn's World Info sits relative to the conversation history. */

import type { RoleplayPromptOrigin } from './prompt-origin.ts'

/**
 * Whether World Info is sent before or after the chat history.
 *
 * A provider's prefix cache only reuses the identical leading run of a request,
 * and each turn's new player input necessarily breaks that run at the end of the
 * history. Everything ordered after the history is therefore recomputed at full
 * price every turn. Moving World Info ahead of the history keeps it inside the
 * reusable prefix on every turn whose triggered set is unchanged — which, in a
 * long roleplay, is most of them.
 *
 * `after-history` stays the default: it is the order every existing Session was
 * played at, and changing where text sits changes what the model reads.
 */
export type RoleplayWorldInfoPlacement = 'after-history' | 'before-history'

/** The order every existing Session was played at. */
export const DEFAULT_WORLD_INFO_PLACEMENT: RoleplayWorldInfoPlacement = 'after-history'

/** Read one stored or requested placement, falling back to the historical order. */
export function normalizeWorldInfoPlacement(value: unknown): RoleplayWorldInfoPlacement {
  return value === 'before-history' ? 'before-history' : DEFAULT_WORLD_INFO_PLACEMENT
}

/** One emitted World Info string, its attribution, and why it was included. */
export interface PlacedWorldInfoEntry {
  readonly content: string
  /** Authorship for the prompt preview; never read on the send path. */
  readonly origin?: RoleplayPromptOrigin
  /** An always-on entry, which stays identical while the triggered set moves. */
  readonly resident: boolean
}

/**
 * Pair each emitted string with its origin and residency by index.
 *
 * The three arrays are built by the same walk over the same active entries, so
 * index `i` describes one entry in all of them. A shorter origin or residency
 * array means that pairing failed upstream; the entry then degrades to
 * unattributed and non-resident rather than silently taking another entry's.
 * @param contents - emitted World Info strings, in insertion order.
 * @param origins - attribution at the same indices.
 * @param residency - whether each entry is always-on, at the same indices.
 * @returns one entry per emitted string.
 */
export function placedWorldInfoEntries(
  contents: readonly string[],
  origins: readonly RoleplayPromptOrigin[] | undefined,
  residency: readonly boolean[] | undefined,
): readonly PlacedWorldInfoEntry[] {
  return contents.map((content, index) => {
    const origin = origins?.[index]
    return {
      content,
      ...(origin === undefined ? {} : { origin }),
      resident: residency?.[index] ?? false,
    }
  })
}

/**
 * Order always-on entries ahead of keyword-triggered ones.
 *
 * Only useful before the history, and only because the two groups age
 * differently: the resident run is identical every turn, while the triggered
 * run changes as the scene moves. Keeping the stable text first means a turn
 * that triggers a different entry loses the cache from that entry onward
 * instead of from the first World Info byte.
 *
 * The sort is stable within each group, so authored insertion order survives,
 * and it moves each entry's origin with it — the preview must keep naming the
 * entry that produced the text.
 * @param entries - emitted entries in insertion order.
 * @returns the same entries, resident ones first.
 */
export function residentFirstWorldInfo(
  entries: readonly PlacedWorldInfoEntry[],
): readonly PlacedWorldInfoEntry[] {
  const resident = entries.filter(entry => entry.resident)
  return resident.length === 0 || resident.length === entries.length
    ? entries
    : [...resident, ...entries.filter(entry => !entry.resident)]
}
