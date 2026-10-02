/** Capability lookup double for the Workers' reasoning negotiation. */

/**
 * Stand in for `ctx.llm.resolveModelInfo` in a Host double.
 *
 * Every background Worker now asks the exact model which efforts it declares
 * before sending one. A double without this method makes the Worker behave as
 * if the catalogue were unreadable, which silently moves the test onto the
 * degraded path instead of the one it means to cover.
 * @param efforts - the efforts this model declares, `off` first by default.
 * @returns a `resolveModelInfo` implementation.
 */
export function resolveModelInfoDouble(
  ...efforts: readonly string[]
): () => Promise<{ readonly reasoning: { readonly efforts: readonly { readonly id: string; readonly name: string }[] } }> {
  const declared = efforts.length === 0
    ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    : efforts
  return async () => ({ reasoning: { efforts: declared.map(id => ({ id, name: id.toUpperCase() })) } })
}
