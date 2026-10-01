/** Browser-safe values for the authored native state-scheme library. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RoleplayStateTemplate } from './roleplay-state-template.ts'

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const STATE_SCHEME_LIBRARY_PATH = '/api/agent-rp/state-schemes'

/** Maximum stored scheme size accepted by the Host. */
export const MAX_STATE_SCHEME_BYTES = 1024 * 1024

/** Compact entry shown in the resource center before a Session exists. */
export interface StateSchemeLibrarySummary {
  readonly id: string
  readonly name: string
  readonly stateId: string
  readonly fieldCount: number
  readonly templateFormat: RoleplayStateTemplate['format']
  readonly revision: number
  readonly updatedAt: number
  /** Flat resource-center labels; display-only, nothing downstream reads them. */
  readonly tags: readonly string[]
}

/** Complete authored scheme returned when one entry is opened for editing. */
export interface StateSchemeLibraryEntry extends StateSchemeLibrarySummary {
  /** Opening JSON object frozen into a Session when this scheme is selected. */
  readonly initial: JsonValue
  /** Settlement rules; model-visible, and frozen alongside the opening value. */
  readonly rules: string
  /** Display-only panel template, resolved live so later edits reach old Sessions. */
  readonly template: RoleplayStateTemplate
}

/** One create-or-update request; revision zero creates a new entry. */
export interface StateSchemeLibrarySaveRequest {
  readonly format: 0
  readonly id?: string
  readonly expectedRevision: number
  readonly name: string
  readonly stateId: string
  readonly initial: JsonValue
  readonly rules: string
  readonly template: RoleplayStateTemplate
  /** Omitted keeps the scheme's existing labels; an empty array clears them. */
  readonly tags?: readonly string[]
}

export interface StateSchemeLibraryListResponse {
  readonly format: 0
  readonly entries: readonly StateSchemeLibrarySummary[]
}

export interface StateSchemeLibraryEntryResponse {
  readonly format: 0
  readonly entry: StateSchemeLibraryEntry
}

export interface StateSchemeLibraryDeleteResponse {
  readonly format: 0
  readonly id: string
}
