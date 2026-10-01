/** Flat, display-only labels shared by every resource-center library. */

/** Largest number of labels one resource may carry. */
export const MAX_RESOURCE_TAGS = 12

/** Largest length of one label, counted in code points so CJK is not penalized. */
export const MAX_RESOURCE_TAG_LENGTH = 24

/**
 * Normalize one untrusted label set.
 *
 * Labels are flat and display-only: no nesting, no ordering semantics, and
 * nothing downstream of the resource center reads them. Normalization trims,
 * drops empties, removes duplicates case-sensitively (CJK has no case to fold,
 * and folding Latin would silently merge labels the player chose to distinguish)
 * and sorts, so two equal sets always serialize identically — which is what lets
 * a content-addressed library compare them without churning its ids.
 * @param value - untrusted label array.
 * @param label - field name used in failure text.
 * @returns the normalized labels, sorted.
 */
export function parseResourceTags(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label}必须是文本数组`)
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label}必须是文本数组`)
    const tag = item.trim()
    if (tag === '') continue
    if ([...tag].length > MAX_RESOURCE_TAG_LENGTH) throw new Error(`单个分类最多 ${String(MAX_RESOURCE_TAG_LENGTH)} 个字`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > MAX_RESOURCE_TAGS) throw new Error(`一个资源最多 ${String(MAX_RESOURCE_TAGS)} 个分类`)
  return tags.sort((left, right) => left.localeCompare(right))
}

/**
 * Merge two label sets.
 *
 * Used where a library collapses two resources into one — the content-addressed
 * World Info library does this when an edit makes two books byte-identical.
 * Labels are additive, so neither side's choice is silently dropped; a folder
 * would have had to pick a winner.
 * @param left - one resource's labels.
 * @param right - the other resource's labels.
 * @returns the union, normalized and bounded.
 */
export function mergeResourceTags(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return parseResourceTags([...left, ...right].slice(0, MAX_RESOURCE_TAGS), '分类')
}
