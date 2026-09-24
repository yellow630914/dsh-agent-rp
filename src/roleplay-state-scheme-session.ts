/** Player-driven changes to the state contract one Session is running under. */

import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE } from './roleplay-state-scheme-ids.ts'
import type { RoleplayStateTemplate } from './roleplay-state-template.ts'
import {
  basicRoleplayStateScheme,
  parseRoleplayStateScheme,
  readRoleplayStateScheme,
  roleplayStateSchemeLibraryId,
  sessionRoleplayStateScheme,
  switchedRoleplayStateScheme,
  type RoleplayStateSchemeSnapshot,
  type RoleplayStateSchemeSource,
} from './roleplay-state-scheme.ts'
import { appendAgentRpSessionEvent } from './session-event-compat.ts'

/** The panel template actually in force, and where it came from. */
export interface ResolvedRoleplayStateTemplate {
  readonly template: RoleplayStateTemplate
  /** Session copy, the source entry's, or the built-in fallback. */
  readonly origin: 'session' | 'source' | 'builtin'
}

/**
 * Resolve the template this Session's panel should render with.
 *
 * A Session copy wins so a mid-play edit sticks; otherwise the source entry is
 * read live so resource-center edits reach every Session still following it.
 * A deleted or unreadable source falls back to the built-in rather than
 * blanking a panel whose state is perfectly valid.
 * @param scheme - contract this Session is running under.
 * @param library - authored scheme store, when one is available.
 * @returns the effective template and its origin.
 */
export function resolveRoleplayStateTemplate(
  scheme: RoleplayStateSchemeSnapshot | undefined,
  library: RoleplayStateSchemeTemplateSource | undefined,
): ResolvedRoleplayStateTemplate {
  if (scheme?.template !== undefined) return { template: scheme.template, origin: 'session' }
  const libraryId = roleplayStateSchemeLibraryId(scheme?.source)
  const fromSource = libraryId === undefined ? undefined : library?.template(libraryId)
  if (fromSource !== undefined) return { template: fromSource, origin: 'source' }
  return {
    template: { format: 'html', source: BASIC_ROLEPLAY_STATE_PANEL_TEMPLATE },
    origin: 'builtin',
  }
}

/** One explicit change requested from the state dialog. */
export interface RoleplayStateSchemeChange {
  /** Switch this Session onto another reusable scheme, keeping its own identity. */
  readonly resourceId?: string
  /** Session-level edits that never travel back to the library entry. */
  readonly edit?: {
    readonly name?: string
    readonly initial?: JsonValue
    readonly rules?: string
    /** A template takes this Session off the source; null hands it back. */
    readonly template?: RoleplayStateTemplate | null
    /** A budget overrides the runtime default; null returns to it. */
    readonly verificationMaxTokens?: number | null
  }
}

/** Library view this module needs beyond resolving whole schemes. */
export interface RoleplayStateSchemeTemplateSource extends RoleplayStateSchemeSource {
  template(id: string): RoleplayStateTemplate | undefined
}

function resolveResource(
  resourceId: string,
  source: RoleplayStateSchemeSource | undefined,
): RoleplayStateSchemeSnapshot {
  const builtIn = basicRoleplayStateScheme()
  if (resourceId === builtIn.id) return builtIn
  const libraryId = roleplayStateSchemeLibraryId(resourceId)
  const resolved = libraryId === undefined ? undefined : source?.read(libraryId)
  if (resolved === undefined) throw new Error('状态方案不可用')
  return resolved
}

/**
 * Append the contract change the player asked for.
 *
 * Every change is a new seed rather than an edit of the old one: the Session
 * log is append-only, and `readRoleplayStateScheme` takes the last seed, so the
 * log records exactly which turns ran under which contract and replay stays
 * honest. The Session identity and its state namespace never move, so the
 * settled values and their revision carry across a switch.
 * @param input - live Session, the library to resolve sources from, and the change.
 * @returns the contract now in force.
 */
export function changeSessionRoleplayStateScheme(input: {
  readonly session: Session
  readonly library?: RoleplayStateSchemeSource
  readonly change: RoleplayStateSchemeChange
}): RoleplayStateSchemeSnapshot {
  const events = input.session.snapshotEvents()
  const current = readRoleplayStateScheme(events)
  const { resourceId, edit } = input.change
  if (resourceId === undefined && edit === undefined) throw new Error('状态方案变更请求为空')
  let next: RoleplayStateSchemeSnapshot
  if (resourceId !== undefined) {
    const resource = resolveResource(resourceId, input.library)
    next = current === undefined
      // A Session launched without a contract can still adopt one; it mints its
      // identity now instead of at launch.
      ? sessionRoleplayStateScheme(resource, crypto.randomUUID())
      : switchedRoleplayStateScheme(current, resource)
  } else {
    if (current === undefined) throw new Error('当前会话还没有状态方案，无法编辑')
    next = current
  }
  if (edit !== undefined) {
    const initial = edit.initial === undefined ? next.initial : snapshotJsonValue(edit.initial)
    if (initial === undefined || typeof initial !== 'object' || initial === null || Array.isArray(initial)) {
      throw new Error('状态方案初始值必须是 JSON 对象')
    }
    next = parseRoleplayStateScheme({
      format: 0,
      id: next.id,
      ...(next.source === undefined ? {} : { source: next.source }),
      name: edit.name === undefined ? next.name : edit.name.trim(),
      stateId: next.stateId,
      initial,
      rules: edit.rules === undefined ? next.rules : edit.rules,
      ...(edit.template === null
        ? {}
        : edit.template === undefined
          ? (next.template === undefined ? {} : { template: next.template })
          : { template: edit.template }),
      ...(edit.verificationMaxTokens === null
        ? {}
        : edit.verificationMaxTokens === undefined
          ? (next.verificationMaxTokens === undefined
            ? {} : { verificationMaxTokens: next.verificationMaxTokens })
          : { verificationMaxTokens: edit.verificationMaxTokens }),
    })
  }
  appendAgentRpSessionEvent(input.session, 'agent-rp/state-scheme-seed', next)
  return next
}
