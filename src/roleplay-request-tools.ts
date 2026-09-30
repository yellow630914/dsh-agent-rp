/**
 * Whether one narrative request needs its tool schemas at all.
 *
 * DeepSeek's thinking mode decides what happens to earlier turns' reasoning by
 * whether the request carries `tools`: with them, every earlier turn's
 * reasoning is concatenated into the context (and withholding it is a 400);
 * without them it is ignored. A roleplay turn rarely calls a tool, so carrying
 * the schemas every turn makes the model re-read all of its own old drafts for
 * nothing. The schemas are therefore left off unless this turn plausibly needs
 * one of them.
 *
 * The decision only ever removes tools that Agent RP knows how to judge. Any
 * other tool — an MCP server, a framework tool added later — keeps the whole
 * set, because leaving an unknown capability off is a silent regression while
 * keeping it only costs what this module was meant to save.
 */

import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { ROLEPLAY_ACTOR_INSPECTION_TOOL, ROLEPLAY_ACTOR_REVISION_TOOL } from './roleplay-actor-revision.ts'
import { ROLEPLAY_ARTIFACT_PUBLISH_TOOL, ROLEPLAY_ARTIFACT_STAGE_TOOL } from './roleplay-artifact.ts'
import { ROLEPLAY_IMAGE_GENERATION_TOOL } from './roleplay-image-generation-tool.ts'
import { ROLEPLAY_STATE_ACTION_TOOL } from './roleplay-state-action.ts'
import type { PromptPreviewToolReason } from './prompt-preview-protocol.ts'
import type { RoleplayToolPolicyPlan } from './roleplay-tool-guidance.ts'

/** Why a request kept its tool schemas; empty when they were left off. */
export type RoleplayRequestToolReason = PromptPreviewToolReason

export interface RoleplayRequestToolDecision {
  readonly send: boolean
  readonly reasons: readonly RoleplayRequestToolReason[]
}

const IMAGE_TOOLS: ReadonlySet<string> = new Set([
  ROLEPLAY_IMAGE_GENERATION_TOOL,
  ROLEPLAY_ARTIFACT_STAGE_TOOL,
  ROLEPLAY_ARTIFACT_PUBLISH_TOOL,
])
const IMPORT_TOOLS: ReadonlySet<string> = new Set([
  'import_sillytavern_preset',
  'import_character_card',
  'import_world_info',
])
const ACTOR_TOOLS: ReadonlySet<string> = new Set([ROLEPLAY_ACTOR_INSPECTION_TOOL, ROLEPLAY_ACTOR_REVISION_TOOL])
const MEMORY_TOOL = 'remember'
const SEARCH_TOOL = 'web_search'

/** Every tool whose need this module can judge from the turn itself. */
const JUDGED_TOOLS: ReadonlySet<string> = new Set([
  ...IMAGE_TOOLS,
  ...IMPORT_TOOLS,
  ...ACTOR_TOOLS,
  MEMORY_TOOL,
  SEARCH_TOOL,
  // Never exposed to the narrative step, so its presence says nothing.
  ROLEPLAY_STATE_ACTION_TOOL,
])

const IMAGE_INTENT = /(?:图片|圖片|插图|插圖|配图|配圖|画一|畫一|画张|畫張|画个|畫個|画出|畫出|生图|生圖|照片|图像|圖像|\bimage\b|\bpicture\b|illustrat|\bdraw\b)/iu
const SEARCH_INTENT = /(?:搜索|搜尋|搜一下|查一下|查查|查询|查詢|上网|上網|联网|聯網|网上|網上|新闻|新聞|\bsearch\b|look\s*up|\bgoogle\b)/iu
const ACTOR_INTENT = /(?:角色设定|角色設定|人设|人設|角色卡|修改角色|改角色|角色资料|角色資料|character\s+(?:card|definition|sheet))/iu

function textOf(message: RequestMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function isAttachment(block: ContentBlock): boolean {
  return block.type === 'file' || block.type === 'image'
}

/**
 * Decide from the exact messages about to be sent.
 *
 * A turn that has already called a tool keeps the schemas for the rest of the
 * turn: dropping them mid-transaction would change the rules that decide what
 * happens to the reasoning the model is still building on.
 * @param input - the offered tool names, the outgoing history, and the turn's frozen policy.
 * @returns whether to send the schemas, with every reason that required them.
 */
export function decideRoleplayRequestTools(input: {
  readonly toolNames: readonly string[]
  readonly messages: readonly RequestMessage[]
  readonly policy: RoleplayToolPolicyPlan
}): RoleplayRequestToolDecision {
  const { toolNames, messages, policy } = input
  if (toolNames.length === 0) return { send: false, reasons: [] }
  if (policy.behavior.request.tools === 'always') return { send: true, reasons: ['always'] }

  const playerIndex = messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
  const player = playerIndex < 0 ? undefined : messages[playerIndex]
  const playerText = player === undefined ? '' : textOf(player)
  const offered = new Set(toolNames)
  const reasons: RoleplayRequestToolReason[] = []

  if (messages.slice(playerIndex + 1).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call'))) {
    reasons.push('turn-in-progress')
  }
  if (toolNames.some(name => !JUDGED_TOOLS.has(name))) reasons.push('unrecognized-tool')
  // `remember` is only unlocked for a turn whose player asked to be remembered,
  // so being offered it is already the signal.
  if (offered.has(MEMORY_TOOL)) reasons.push('memory')
  if (toolNames.some(name => IMAGE_TOOLS.has(name))) {
    const mode = policy.behavior.image.mode
    if (mode === 'always' || mode === 'auto' || (mode === 'requested' && IMAGE_INTENT.test(playerText))) {
      reasons.push('image')
    }
  }
  if (toolNames.some(name => IMPORT_TOOLS.has(name)) && player?.content.some(isAttachment) === true) {
    reasons.push('attachment')
  }
  if (offered.has(SEARCH_TOOL) && SEARCH_INTENT.test(playerText)) reasons.push('search')
  if (toolNames.some(name => ACTOR_TOOLS.has(name)) && ACTOR_INTENT.test(playerText)) reasons.push('actor')

  return { send: reasons.length > 0, reasons }
}
