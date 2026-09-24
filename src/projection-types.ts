/** Browser-safe Roleplay state computed from durable Session events. */

import type { ImportedCharacterFrontend } from './import/types.ts'
import type { ImportedRegexScript } from './import/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionPersonaSnapshot } from './persona-library-protocol.ts'
import type { TavernHelperState } from './tavern-helper.ts'
import type { PromptRegexTraceRecord } from './frontend-regex.ts'
import type { RoleplayTurnPresentation } from './roleplay-turn-presentation-types.ts'

/** Stable fallback identity used by resource-only roleplay Sessions. */
export const DEFAULT_AGENT_RP_CHARACTER_NAME = '角色会话'

/** Current character identity and migration summary for one Roleplay Session. */
export interface AgentRpProjection {
  /** Live Host abilities that gate UI actions; they are not durable roleplay state. */
  readonly hostCapabilities?: {
    readonly sessionEvents: boolean
  }
  /** Per-Session capability strategy, independent from imported prompt presets. */
  readonly turnMode: 'conversation' | 'agent'
  /** Character name used by the prompt and card macros. */
  readonly characterName: string
  /** Lossless card title when the card supplies a shorter runtime nickname. */
  readonly originalCharacterName?: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
  readonly userName?: string
  readonly persona?: SessionPersonaSnapshot
  readonly cardVersion?: 1 | 2 | 3
  /** Exact current character-card JSON retained for same-session script compatibility. */
  readonly characterCardRaw?: JsonValue
  readonly avatarAttachmentId?: string
  readonly avatarLibraryId?: string
  readonly importedMessageCount: number
  /** Native structured state currently active in this Session. */
  readonly nativeStates: readonly {
    readonly id: string
    readonly revision: number
    readonly ownerModuleId: string
    readonly writerModuleId: string
    readonly eventSeq: number
    readonly value: JsonValue
  }[]
  /** Content-free counts for audited auxiliary Tavern model requests. */
  readonly auxiliaryGenerations?: {
    readonly requests: number
    readonly succeeded: number
    readonly failed: number
    readonly pending: number
    readonly malformed: number
  }
  readonly worldInfoCount: number
  /**
   * Every chat floor in order, hidden ones first, carrying only a short preview.
   * The floor panel needs identity and ordering, not bodies, and this list is
   * re-sent on every projection update — so it deliberately does not repeat the
   * full text already present in `tavern.messages`. Unlike that field it is
   * always present, because a Session that never touched a Tavern script still
   * has floors.
   */
  readonly floors: readonly {
    readonly seq: number
    readonly role: 'user' | 'assistant'
    readonly preview: string
    readonly hidden: boolean
  }[]
  /** Imported lorebooks, current session overlays, and next-request activation evidence. */
  readonly worldInfo: {
    readonly revision: number
    readonly activeCount: number
    /** Optional player-selected aggregate cap; omission means Agent RP does not truncate the activated books. */
    readonly tokenBudget?: number
    readonly approximateTokens: number
    readonly budgetExcludedCount: number
    readonly failureCounts: import('./world-engine-diagnostic.ts').WorldEngineFailureCounts
    readonly books: readonly {
      readonly id: string
      readonly name: string
      readonly source: 'character' | 'standalone'
      /** Depth actually in force this Session — the Session's override when it set one, otherwise the file's. */
      readonly scanDepth?: number
      /** The imported file's own default, kept separate so the manager can say what "restore" restores. */
      readonly fileScanDepth?: number
      /** True when this Session decided the depth itself, including deciding the book has none. */
      readonly scanDepthModified: boolean
      readonly tokenBudget?: number
      readonly recursiveScanning: boolean
      readonly degradations: readonly string[]
      readonly entries: readonly {
        readonly index: number
        readonly sourceId: string
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
        readonly useRegex: boolean
        readonly hasDecorators: boolean
        readonly compatibilityBlockers: readonly import('./import/types.ts').LorebookEntryCompatibilityBlocker[]
        readonly active: boolean
        readonly reason: import('./import/lorebook.ts').LorebookActivationReason
        readonly matchedKeys: readonly string[]
        readonly matchedSecondaryKeys: readonly string[]
        readonly approximateTokens: number
        readonly template?: 'rendered' | import('./ejs-template.ts').EjsTemplateFailureKind
        readonly templateError?: import('./ejs-template.ts').EjsTemplateErrorDetail
        readonly modified: boolean
        readonly deleted: boolean
      }[]
    }[]
  }
  readonly frontend?: ImportedCharacterFrontend
  /** Explicit standalone regex packs frozen into this Session in execution order. */
  readonly regexPacks: readonly {
    readonly id: string
    readonly name: string
    readonly scriptCount: number
    readonly enabledCount: number
    readonly displayCount: number
    readonly promptCount: number
    readonly scripts: readonly ImportedRegexScript[]
  }[]
  /**
   * Every imported rule after this Session's own overlay, in execution order.
   *
   * The display pass and the regex manager read this one list, so what the
   * player edits is exactly what runs. `(owner, index)` addresses a rule
   * identically here and on the prompt side; `session` owns rules this Session
   * authored itself.
   */
  readonly regex: {
    readonly revision: number
    readonly scripts: readonly {
      readonly owner: 'regex' | 'prompt-policy' | 'actor' | 'session'
      readonly index: number
      readonly modified: boolean
      readonly deleted: boolean
      readonly script: ImportedRegexScript
    }[]
  }
  /** Latest model-facing regex pass without expressions or message text. */
  readonly promptRegex?: PromptRegexTraceRecord
  readonly mvu?: {
    readonly statData: JsonValue
    readonly updateCount: number
    readonly lastError?: string
  }
  /** Native state contract frozen at launch plus the revision currently in force. */
  readonly stateScheme?: {
    readonly id: string
    readonly name: string
    readonly stateId: string
    readonly value: JsonValue
    readonly revision: number
    /** This Session's own settlement rules, which may differ from the library entry. */
    readonly rules: string
    /** Library entry backing the editable panel template, when one exists. */
    readonly libraryId?: string
    /** Per-scheme completion budget for the verification stage, when one is set. */
    readonly verificationMaxTokens?: number
  }
  /**
   * What the post-narrative settlement did on the most recent turn that ran it.
   *
   * The settlement deliberately writes plugin events no transcript layer can
   * see, which keeps it off the floor list but also leaves the player with no
   * way to tell a silent skip from a failed verification. This is that view.
   */
  readonly stateSettlement?: {
    readonly turn: number
    /** Terminal Worker outcome, absent while the Worker has not reported yet. */
    readonly outcome?: 'applied' | 'unchanged' | 'skipped' | 'failed'
    readonly stages: readonly {
      readonly stage: 'proposal' | 'verification'
      readonly outcome: 'success' | 'failure'
      /** Operations the stage produced, bounded by the settlement contract. */
      readonly operations?: readonly JsonValue[]
      readonly error?: string
    }[]
  }
  /** Isolated Tavern Helper scripts, durable variables, and their visible transcript input. */
  readonly tavern?: TavernHelperState & {
    readonly messages: readonly {
      readonly messageId: number
      readonly seq: number
      readonly role: 'user' | 'assistant'
      readonly text: string
      /** Model reasoning retained for read-only Tavern Helper compatibility. */
      readonly reasoning?: string
      readonly isHidden: boolean
      /** Root-level SillyTavern compatibility fields, isolated by Host script identity. */
      readonly annotations?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>
    }[]
  }
  /** Persistent alternatives for Roleplay replies that have been regenerated or continued. */
  readonly generations: readonly {
    readonly groupId: string
    readonly anchorSeq: number
    readonly selectedVersionSeq: number
    readonly assistantSeqs: readonly number[]
    readonly versions: readonly {
      readonly seq: number
      readonly text: string
    }[]
    /** User row this group superseded, and the text that replaced it. */
    readonly rewrittenInput?: {
      readonly seq: number
      readonly text: string
    }
  }[]
  /**
   * Appended replacement seq → the transcript row it stands in for.
   *
   * DSH 0.1.3 bars an Assistant message from replacing surface nodes, so a
   * regenerated reply is appended and owns its own transcript row. Resolve a
   * row's seq through this map before matching it against `anchorSeq` or
   * `currentReplySeq`; absent for Sessions that never superseded a reply.
   */
  readonly surfaceAnchors?: Readonly<Record<string, number>>
  /**
   * Transcript rows a replacement superseded, in ascending seq order.
   *
   * The Host still renders them — they are append-origin — so the display
   * planner hides them and renders on the replacement row instead.
   */
  readonly supersededSeqs?: readonly number[]
  /**
   * Transcript rows a real surface `replace` dropped, in ascending seq order.
   *
   * Nothing stands in for these — hiding floors states that the player wants
   * them gone from the conversation — so the planner hides them outright.
   * Absent for Sessions that never replaced a surface range.
   */
  readonly shadowedSeqs?: readonly number[]
  /** Stable transcript anchor of the model-visible final Roleplay reply. */
  readonly currentReplySeq?: number
  /** Unified present-phase selection behind the visible reply and its runtime state. */
  readonly presentation?: RoleplayTurnPresentation
  readonly preset?: {
    readonly libraryId?: string
    readonly name: string
    readonly promptCount: number
    readonly enabledCount: number
    readonly revision: number
    readonly prompts: readonly {
      readonly identifier: string
      readonly name: string
      readonly importedName: string
      readonly role: 'system' | 'user' | 'assistant'
      readonly importedRole: 'system' | 'user' | 'assistant'
      readonly content: string
      readonly importedContent: string
      readonly imported: boolean
      readonly contentModified: boolean
      readonly importedAttached: boolean
      readonly importedEnabled: boolean
      readonly importedPosition?: number
      readonly marker: boolean
      readonly systemPrompt: boolean
      readonly forbidOverrides: boolean
      readonly injectionPosition?: number
      readonly injectionDepth?: number
      readonly injectionOrder?: number
      readonly importedInjectionPosition?: number
      readonly importedInjectionDepth?: number
      readonly importedInjectionOrder?: number
      readonly attached: boolean
      readonly enabled: boolean
      readonly toggleable: boolean
      readonly editable: boolean
      readonly deletable: boolean
    }[]
    readonly generation: {
      readonly temperature?: number
      readonly maxTokens?: number
      readonly reasoningEffort?: string
      readonly topP?: number
      readonly topK?: number
      readonly topA?: number
      readonly minP?: number
      readonly frequencyPenalty?: number
      readonly presencePenalty?: number
      readonly repetitionPenalty?: number
    }
    readonly formats: {
      readonly worldInfo: string
      readonly scenario: string
      readonly personality: string
    }
    readonly degradedRoleCount: number
    readonly preservedInChatCount: number
    readonly regexScriptCount: number
    readonly enabledRegexScriptCount: number
    readonly activeDisplayRegexCount: number
    readonly preservedPromptRegexCount: number
    readonly regexScripts: readonly (ImportedRegexScript & { readonly index: number })[]
    readonly tavernHelperScripts: readonly import('./import/types.ts').ImportedTavernHelperScript[]
    readonly tavernHelperVariables: Readonly<Record<string, JsonValue>>
    readonly appliedGeneration: readonly string[]
    readonly preservedGeneration: readonly string[]
    readonly omittedExtensions: readonly string[]
    readonly extensionStatus: readonly {
      readonly name: string
      readonly detail: string
      readonly state: 'active' | 'inactive' | 'unsupported'
    }[]
  }
  readonly presetLibrary: readonly {
    readonly id: string
    readonly name: string
    readonly promptCount: number
    readonly enabledCount: number
    readonly regexScriptCount: number
    readonly tavernHelper?: import('./import/types.ts').TavernHelperLibrarySummary
    readonly updatedAt: number
  }[]
  /** Last Host-recorded request header, used only by the local compatibility inspector. */
  readonly lastRequest?: {
    readonly eventSeq: number
    readonly time: number
    readonly presetName?: string
    readonly presetRevision?: number
    readonly system: string
    readonly config: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
      readonly temperature?: number
      readonly maxTokens?: number
      readonly stop?: readonly string[]
    }
    readonly toolNames: readonly string[]
  }
  readonly source: 'character-card' | 'sillytavern-chat' | 'preset'
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current character identity and migration summary for one Roleplay Session. */
    agentRp: AgentRpProjection
  }
}
