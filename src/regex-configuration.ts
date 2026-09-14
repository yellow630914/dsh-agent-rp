/** Host adapter for session-owned regex management. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { cardFromImportMeta, readActiveSessionCharacter } from './import/session-character.ts'
import { readActiveSessionPreset } from './import/session-preset.ts'
import { presetRegexScripts } from './import/sillytavern-preset.ts'
import { readSessionRegexPacks } from './session-regex-pack.ts'
import {
  configureRegex,
  encodeRegexConfiguration,
  parseRegexConfigurationRequest,
  readRegexConfiguration,
  type SessionRegexSource,
} from './regex-configuration-core.ts'

/**
 * Resolve every imported regex collection in execution order, from the durable
 * Session log alone.
 *
 * All three are already Session snapshots — packs through
 * `agent-rp/regex-pack-seed`, the card and preset through their own seeds — so
 * this list is what this Session imported, not what the resource library holds
 * now. Order is the execution order the prompt and display views share, which
 * is what makes `(owner, index)` a stable address for an override.
 */
export function readSessionRegexSourcesFromEvents(events: readonly SessionEvent[]): readonly SessionRegexSource[] {
  const active = readActiveSessionCharacter(events)
  const card = active === undefined ? undefined : cardFromImportMeta(active.meta)
  const preset = readActiveSessionPreset(events)
  return [
    { owner: 'regex', scripts: readSessionRegexPacks(events).flatMap(pack => pack.scripts) },
    { owner: 'prompt-policy', scripts: preset === undefined ? [] : presetRegexScripts(preset.preset) },
    { owner: 'actor', scripts: card?.frontend.regexScripts ?? [] },
  ]
}

/** Host convenience wrapper for callers that already own an Agent. */
export function readSessionRegexSources(agent: Agent): readonly SessionRegexSource[] {
  return readSessionRegexSourcesFromEvents(agent.session.snapshotEvents())
}

/** Execute one regex manager mutation and persist its complete overlay snapshot. */
export function executeRegexConfiguration(invocation: {
  readonly agent: Agent
  readonly rawInput: string
}): { readonly kind: 'success'; readonly text: string } {
  const current = readRegexConfiguration(invocation.agent.session.snapshotEvents())
  const next = configureRegex(
    current,
    parseRegexConfigurationRequest(invocation.rawInput),
    readSessionRegexSources(invocation.agent),
  )
  return { kind: 'success', text: encodeRegexConfiguration(next) }
}
