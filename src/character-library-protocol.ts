/** Browser-safe character-library values shared by the Host and Roleplay UI. */

import type { SessionPersonaSnapshot } from './persona-library-protocol.ts'
import type { CharacterImportDegradation, ImportedRegexScript, TavernHelperImportSummary } from './import/types.ts'
import type { CharacterRegexScriptSummary } from './frontend-regex.ts'

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const CHARACTER_LIBRARY_PATH = '/api/agent-rp/characters'

/** Browser resource classes that an isolated Character Card may request. */
export const CHARACTER_REMOTE_RESOURCE_TYPES = [
  'connect', 'font', 'frame', 'image', 'media', 'script', 'style',
] as const

/** One CSP resource class approved independently from every other class. */
export type CharacterRemoteResourceType = typeof CHARACTER_REMOTE_RESOURCE_TYPES[number]

/** One HTTPS origin and resource class explicitly approved by the local player. */
export interface CharacterRemoteResourceApproval {
  readonly origin: string
  readonly type: CharacterRemoteResourceType
}

/** Network policy for one local Character Card's isolated light frontend. */
export type CharacterRemoteResourcePolicy = 'prompt' | 'isolated-https'

/** Visible collection selected in the local character library. */
export type CharacterLibraryCollection = 'active' | 'archived'

/** One inert embedded image exposed from a CHARX archive. */
export interface CharacterLibraryImage {
  /** Stable index in the Character Card V3 assets array. */
  readonly index: number
  readonly type: string
  readonly name: string
  readonly mediaType: string
  /** Original embedded URI retained for exact light-frontend substitution. */
  readonly sourceUri: string
}

/** One read-only embedded World Info entry shown before a character Session exists. */
export interface CharacterLibraryWorldInfoEntry {
  readonly sourceId: string
  readonly name?: string
  readonly comment?: string
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly content: string
  readonly enabled: boolean
  readonly constant: boolean
  readonly selective: boolean
  readonly useRegex: boolean
}

/** Read-only World Info retained inside an imported Character Card. */
export interface CharacterLibraryWorldInfo {
  readonly name?: string
  readonly entries: readonly CharacterLibraryWorldInfoEntry[]
}

/** One bounded slice of a Character Card's read-only World Info. */
export interface CharacterLibraryWorldInfoPage {
  readonly name?: string
  readonly offset: number
  readonly total: number
  readonly entries: readonly CharacterLibraryWorldInfoEntry[]
}

/** One user-installed display-only rule attached to a local Character Card copy. */
export interface CharacterLibraryDisplayExtension {
  readonly id: string
  readonly scriptName: string
  readonly originalFilename: string
  readonly enabled: boolean
  /** HTTPS origins explicitly approved for image loading by this extension. */
  readonly remoteImageOrigins: readonly string[]
  /** Card-owned rules superseded by an exact malformed-pattern repair. */
  readonly replacedCardRegexNames: readonly string[]
}

/** Player-editable character definition kept beside the immutable imported asset. */
export interface CharacterLibraryEditableContent {
  readonly name: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
  readonly messageExample: string
  readonly firstMessage: string
  readonly alternateGreetings: readonly string[]
}

/** One reusable World Info reference in a character's editable default composition. */
export interface CharacterLibraryWorldReference {
  readonly worldInfoId: string
  readonly provenance: 'embedded-import' | 'user-bound'
}

/** Browser-safe view of the worlds attached to future Sessions for one character. */
export interface CharacterLibraryWorldBinding {
  readonly format: 0
  readonly primary: CharacterLibraryWorldReference | null
  readonly additional: readonly CharacterLibraryWorldReference[]
  readonly revision: number
}

/** Optimistic replacement of one character's complete default world composition. */
export interface CharacterWorldBindingUpdateRequest {
  readonly format: 0
  readonly revision: number
  readonly primaryWorldInfoId: string | null
  readonly additionalWorldInfoIds: readonly string[]
}

/** One card-owned regex with stable source addressing for local enable switches. */
export interface CharacterLibraryRegexScript extends CharacterRegexScriptSummary {
  readonly index: number
  readonly locallyOverridden: boolean
  readonly replacedByDisplayExtension: boolean
}

/** Optimistic, reversible mutation of one local character revision. */
export type CharacterLibraryEditRequest =
  | {
    readonly format: 0
    readonly operation: 'save-content'
    readonly revision: number
    readonly content: CharacterLibraryEditableContent
  }
  | {
    readonly format: 0
    readonly operation: 'set-regex-enabled'
    readonly revision: number
    readonly index: number
    readonly enabled: boolean
  }
  | {
    readonly format: 0
    readonly operation: 'reset'
    readonly revision: number
  }

/** One compact reusable Character Card shown in the library. */
export interface CharacterLibrarySummary {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly originalFilename: string
  readonly cardVersion: 1 | 2 | 3
  readonly greetingCount: number
  readonly worldInfoCount: number
  readonly regexScriptCount: number
  readonly avatarAvailable: boolean
  readonly imageAssetCount: number
  readonly tavernHelper?: TavernHelperImportSummary
  readonly archived: boolean
  /** Flat resource-center labels; the archive carries none. */
  readonly tags: readonly string[]
  readonly transport: 'png' | 'json' | 'charx'
  readonly importedAt: number
  readonly updatedAt: number
}

/** Details loaded only after a user selects one library card. */
export interface CharacterLibraryDetail extends CharacterLibrarySummary {
  readonly mediaType: string
  readonly greetings: readonly string[]
  /** Card-owned display rules applied for inert picker previews. */
  readonly renderedGreetings: readonly string[]
  readonly imageAssets: readonly CharacterLibraryImage[]
  /** Public HTTPS origins referenced by card-owned images or application resources. */
  readonly remoteResourceOrigins: readonly string[]
  /** Statically classified resource origins that can be approved before Session launch. */
  readonly remoteResources: readonly CharacterRemoteResourceApproval[]
  /** Legacy origins that retain approval for every resource class. */
  readonly approvedRemoteResourceOrigins: readonly string[]
  /** Card-owned resource classes explicitly approved by the local player. */
  readonly approvedRemoteResources: readonly CharacterRemoteResourceApproval[]
  /** Per-card remote loading policy; broad HTTPS access remains confined to the sandbox frame. */
  readonly remoteResourcePolicy: CharacterRemoteResourcePolicy
  /** Original embedded entries; edits belong to a launched Session overlay. */
  readonly worldInfo?: CharacterLibraryWorldInfo
  /** Reusable worlds applied to future Sessions and the primary world used by current-version export. */
  readonly worldBinding?: CharacterLibraryWorldBinding
  readonly degradations: readonly CharacterImportDegradation[]
  /** Card-owned regex metadata without expressions, replacements, or card text. */
  readonly regexScripts: readonly CharacterLibraryRegexScript[]
  /** Display-only extensions stored beside, rather than inside, the original card asset. */
  readonly displayExtensions: readonly CharacterLibraryDisplayExtension[]
  /** Exact local text corrections applied without rewriting the imported asset. */
  readonly localCorrectionCount: number
  /** Effective editable fields after applying the local revision. */
  readonly content: CharacterLibraryEditableContent
  /** Monotonic revision used to reject stale editor and regex writes. */
  readonly localRevision: number
  /** Whether character fields or card-owned regex switches differ from the imported asset. */
  readonly localEdits: boolean
}

/** Active card details plus exact pure-display policy loaded only by the local renderer. */
export interface CharacterLibraryRuntimeDetail {
  readonly format: 0
  readonly entry: CharacterLibraryDetail
  readonly displayRegexScripts: readonly ImportedRegexScript[]
}

/** Confirmation returned after an archived Character Card is permanently removed. */
export interface CharacterLibraryDeleteResponse {
  readonly format: 0
  readonly id: string
}

/** What changed when one local card file was added to the library. */
export type CharacterLibraryImportOutcome = 'created' | 'existing' | 'restored'

/** Browser-safe result of importing one local card file. */
export interface CharacterLibraryImportResult {
  readonly entry: CharacterLibraryDetail
  readonly outcome: CharacterLibraryImportOutcome
}

/** Same-origin URL for one validated inert CHARX image. */
export function characterLibraryImageUrl(id: string, index: number): string {
  return `${CHARACTER_LIBRARY_PATH}/${encodeURIComponent(id)}/images/${index}`
}

/** Explicit model-free request embedded beside one selected card attachment. */
export interface CharacterLibrarySessionRequest {
  readonly format: 0
  readonly greetingIndex: number
  readonly userName?: string
  readonly persona?: SessionPersonaSnapshot
}

/** Private command payload selecting one Host-owned card without uploading it to a model. */
export interface CharacterLibraryLaunchRequest {
  readonly format: 0
  readonly characterId: string
  readonly greetingIndex: number
  readonly persona?: SessionPersonaSnapshot
}

/** Stable text prefix recognized by the Character Card Session importer. */
export const CHARACTER_LIBRARY_SESSION_PREFIX = '请从角色库开始新会话'

/** Serialize a library launch without exposing its controls to the model. */
export function encodeCharacterLibrarySessionRequest(request: CharacterLibrarySessionRequest): string {
  return `${CHARACTER_LIBRARY_SESSION_PREFIX}\n${JSON.stringify(request)}`
}
