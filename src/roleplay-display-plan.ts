/** Pure message-display planning shared by the current DOM adapter and future renderers. */

import type { ImportedCharacterFrontend, ImportedRegexScript } from './import/types.ts'
import {
  AI_OUTPUT_PLACEMENT,
  compileCharacterDisplay,
  renderCharacterDisplay,
  USER_INPUT_PLACEMENT,
  type CompiledCharacterDisplay,
} from './frontend-regex.ts'

/** Placeholder emitted by imported status-bar rules before their visible replacement is resolved. */
export const ROLEPLAY_STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>'

const EMPTY_FRONTEND: ImportedCharacterFrontend = {
  regexScripts: [],
  tavernHelperScriptNames: [],
  tavernHelperScripts: [],
  tavernHelperVariables: {},
}

/** Tavern transcript item needed to resolve display-regex depth and overrides. */
export interface RoleplayDisplayMessage {
  readonly messageId: number
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly isHidden: boolean
}

/** Projection fields that can affect one visible message. */
export interface RoleplayDisplayProjection {
  readonly characterName: string
  readonly userName?: string
  readonly regexPacks?: readonly {
    readonly scripts: readonly ImportedRegexScript[]
  }[]
  readonly preset?: {
    readonly regexScripts: readonly ImportedRegexScript[]
  }
  readonly tavern?: {
    readonly messages: readonly RoleplayDisplayMessage[]
  }
  /**
   * Appended replacement seq → the transcript row it stands in for, and the
   * rows those replacements superseded.
   *
   * DSH 0.1.3 bars an Assistant message from replacing surface nodes, so a
   * regenerated reply is appended and owns its own row while the row it
   * replaced stays in the transcript. Both maps are absent for Sessions that
   * never superseded a reply.
   */
  readonly surfaceAnchors?: Readonly<Record<string, number>>
  readonly supersededSeqs?: readonly number[]
  /**
   * Rows a real surface `replace` dropped — today the floor-hide marker.
   *
   * Nothing stands in for them, so unlike `supersededSeqs` these are hidden
   * unconditionally: the player asked for them to leave the conversation.
   */
  readonly shadowedSeqs?: readonly number[]
  readonly generations: readonly {
    readonly anchorSeq: number
    readonly selectedVersionSeq: number
    readonly assistantSeqs: readonly number[]
    readonly versions: readonly {
      readonly seq: number
      readonly text: string
    }[]
    readonly rewrittenInput?: {
      readonly seq: number
      readonly text: string
    }
  }[]
}

/** Result of deciding how one DSH message row should be presented. */
export type RoleplayDisplayPlan =
  | { readonly kind: 'host' }
  | { readonly kind: 'hidden'; readonly reason: 'unselected-generation' | 'superseded-reply' }
  | {
    readonly kind: 'render'
    readonly source: 'override' | 'selected-generation' | 'display-regex' | 'rewritten-input'
    readonly compilation: CompiledCharacterDisplay
    /** Tavern message represented by this rendered row, when the projection can identify it. */
    readonly messageId?: number
  }

/** Input facts owned by the native user-message Chat Node. */
export interface RoleplayUserDisplayInput {
  readonly seq: number
  readonly alignedMessage?: RoleplayDisplayMessage
}

/** Input facts owned by the native Assistant-step Chat Node. */
export interface RoleplayAssistantDisplayInput {
  readonly finalSeq?: number
  readonly blockText: string
  readonly alignedMessage?: RoleplayDisplayMessage
}

/** Pure planner for all message rows in one projection revision. */
export interface RoleplayDisplayPlanner {
  /** Decide whether and how to replace one user row. */
  user(input: RoleplayUserDisplayInput): RoleplayDisplayPlan
  /** Decide whether and how to replace one Assistant row. */
  assistant(input: RoleplayAssistantDisplayInput): RoleplayDisplayPlan
}

function messageDepth(messages: readonly RoleplayDisplayMessage[] | undefined, messageId: number | undefined): number | undefined {
  if (messages === undefined || messageId === undefined) return undefined
  const index = messages.findIndex(message => message.messageId === messageId)
  return index < 0 ? undefined : messages.length - index - 1
}

function overridePlan(value: string, messageId: number): RoleplayDisplayPlan {
  return {
    kind: 'render',
    source: 'override',
    messageId,
    compilation: { segments: [{ kind: 'html', source: value }], diagnostics: [] },
  }
}

/**
 * Build one immutable display planner without reading the DOM or browser state.
 *
 * @param input - current projection, already-resolved character frontend, view mode, and script overrides.
 * @returns row planners that preserve the Host renderer unless Roleplay presentation has work to do.
 */
export function createRoleplayDisplayPlanner(input: {
  readonly projection: RoleplayDisplayProjection
  readonly frontend?: ImportedCharacterFrontend
  readonly immersive: boolean
  readonly overrides: ReadonlyMap<number, string>
}): RoleplayDisplayPlanner {
  const { projection, frontend, immersive, overrides } = input
  const activeFrontend = frontend ?? EMPTY_FRONTEND
  const messages = projection.tavern?.messages
  const messageBySeq = new Map(messages?.map(message => [message.seq, message]))
  const messageIdBySeq = new Map(messages?.map(message => [message.seq, message.messageId]))
  const sharedRegexScripts = [
    ...(projection.regexPacks ?? []).flatMap(pack => pack.scripts),
    ...(projection.preset?.regexScripts ?? []),
  ]
  const hasDisplayRules = immersive && activeFrontend.regexScripts.length + sharedRegexScripts.length > 0
  // Agent RP's own replacements are append-origin under DSH 0.1.3, so the Host
  // keeps rendering the ones that were themselves later superseded — the
  // blanking message a regeneration writes, and every switched-away copy.
  // Hide exactly those: a row that Agent RP appended AND has since replaced.
  // An ordinary model reply that a replacement shadows is deliberately NOT
  // matched here — it still carries the turn's only text, and the existing
  // unselected-generation rule already decides whether it should show.
  const superseded = new Set(projection.supersededSeqs ?? [])
  const anchors = projection.surfaceAnchors
  const anchorOf = (seq: number): number => anchors?.[String(seq)] ?? seq
  const supersededReplacement = (seq: number): boolean =>
    superseded.has(seq) && anchors?.[String(seq)] !== undefined
  // Hiding floors drops rows through a real surface `replace`, which leaves no
  // stand-in row carrying their text — the narrow rule above deliberately does
  // not match them, because it exists to spare a shadowed model reply that
  // still carries its turn's only text. These have no such claim.
  const shadowed = new Set(projection.shadowedSeqs ?? [])
  const dropped = (seq: number): boolean => shadowed.has(seq) || supersededReplacement(seq)
  const rewrittenInputBySeq = new Map(projection.generations
    .flatMap(group => group.rewrittenInput === undefined ? [] : [[group.rewrittenInput.seq, group.rewrittenInput.text] as const]))

  return {
    user: ({ seq, alignedMessage }) => {
      if (dropped(seq)) return { kind: 'hidden', reason: 'superseded-reply' }
      const message = alignedMessage ?? messageBySeq.get(seq)
      const messageId = message?.messageId ?? messageIdBySeq.get(seq)
      const override = messageId === undefined ? undefined : overrides.get(messageId)
      if (override !== undefined) return overridePlan(override, messageId!)
      // A rewritten row must show its replacement even with no display rules
      // and even when the surface no longer contains this seq: the Host
      // transcript is append-origin, so the row still carries the superseded
      // text and nothing else will correct it. The messageId is deliberately
      // omitted — the DOM adapter gates rendering on card-frame retention, and
      // showing the old message again is worse than losing frame identity on
      // one player row.
      const rewritten = rewrittenInputBySeq.get(seq)
      if (rewritten !== undefined) {
        const renderedInput = renderCharacterDisplay(rewritten, {
          name: projection.characterName,
          frontend: activeFrontend,
        }, USER_INPUT_PLACEMENT, messageDepth(messages, messageId), projection.userName, sharedRegexScripts)
        return {
          kind: 'render', source: 'rewritten-input', compilation: compileCharacterDisplay(renderedInput),
        }
      }
      if (!hasDisplayRules || message?.role !== 'user' || message.text === '') {
        return { kind: 'host' }
      }
      const rendered = renderCharacterDisplay(message.text, {
        name: projection.characterName,
        frontend: activeFrontend,
      }, USER_INPUT_PLACEMENT, messageDepth(messages, message.messageId), projection.userName, sharedRegexScripts)
      return rendered === message.text
        ? { kind: 'host' }
        : { kind: 'render', source: 'display-regex', compilation: compileCharacterDisplay(rendered), messageId: message.messageId }
    },
    assistant: ({ finalSeq, blockText, alignedMessage }) => {
      if (finalSeq !== undefined && dropped(finalSeq)) {
        return { kind: 'hidden', reason: 'superseded-reply' }
      }
      // A replacement row answers for the row it superseded, so the version
      // group is found and compared through that anchor, not the row's own seq.
      const anchoredSeq = finalSeq === undefined ? undefined : anchorOf(finalSeq)
      const generation = anchoredSeq === undefined
        ? undefined
        : projection.generations.find(group => group.assistantSeqs.includes(anchoredSeq)
          || group.anchorSeq === anchoredSeq)
      const selected = generation?.versions.find(version => version.seq === generation.selectedVersionSeq)
      const messageId = (selected === undefined ? undefined : messageIdBySeq.get(selected.seq))
        ?? alignedMessage?.messageId
        ?? (finalSeq === undefined ? undefined : messageIdBySeq.get(finalSeq))
      const override = messageId === undefined ? undefined : overrides.get(messageId)
      if (override !== undefined) return overridePlan(override, messageId!)
      if (immersive && generation !== undefined) {
        if (anchoredSeq !== generation.anchorSeq) return { kind: 'hidden', reason: 'unselected-generation' }
        if (selected !== undefined) {
          const rendered = renderCharacterDisplay(selected.text.replaceAll(ROLEPLAY_STATUS_PLACEHOLDER, ''), {
            name: projection.characterName,
            frontend: activeFrontend,
          }, AI_OUTPUT_PLACEMENT, messageDepth(messages, messageId), projection.userName, sharedRegexScripts)
          return {
            kind: 'render', source: 'selected-generation', compilation: compileCharacterDisplay(rendered),
            ...(messageId === undefined ? {} : { messageId }),
          }
        }
      }
      if (!hasDisplayRules) return { kind: 'host' }
      const raw = alignedMessage?.role === 'assistant' ? alignedMessage.text : blockText
      if (raw === '') return { kind: 'host' }
      const rendered = renderCharacterDisplay(raw.replaceAll(ROLEPLAY_STATUS_PLACEHOLDER, ''), {
        name: projection.characterName,
        frontend: activeFrontend,
      }, AI_OUTPUT_PLACEMENT, messageDepth(messages, messageId), projection.userName, sharedRegexScripts)
      return rendered === raw
        ? { kind: 'host' }
        : {
            kind: 'render', source: 'display-regex', compilation: compileCharacterDisplay(rendered),
            ...(messageId === undefined ? {} : { messageId }),
          }
    },
  }
}
