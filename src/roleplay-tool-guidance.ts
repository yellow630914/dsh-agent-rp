/** Provider-neutral Agent tool guidance retained across workspace settings and model turns. */

/** Whether image tools must stay idle, may be chosen, or should be attempted each RP turn. */
export type AgentRpImageMode = 'never' | 'requested' | 'auto' | 'always'

/**
 * Whether post-narrative state settlement never runs, waits for the player, or runs every turn.
 *
 * There is deliberately no "force the model to call the state tool" mode: the
 * inline tool costs two surface events and a transcript row every turn and
 * breaks the reusable prompt prefix, while the background Worker reaches the
 * same state through plugin events that no transcript layer can see.
 */
export type AgentRpStateMode = 'never' | 'requested' | 'auto'

/**
 * Whether a narrative request carries its tool schemas every turn or only when
 * the turn plausibly needs one.
 *
 * This is not a cost preference. DeepSeek's thinking mode concatenates every
 * earlier turn's reasoning into the context only when the request carries
 * `tools`, and rejects the request if that reasoning is withheld; without
 * `tools` the earlier reasoning is ignored. So a roleplay whose turns rarely
 * call a tool still re-reads all of its own old drafts, unless the schemas are
 * left off the turns that do not need them.
 */
export type AgentRpRequestToolsMode = 'on-demand' | 'always'

/** One deployment-owned instruction for an installed MCP or other tool provider. */
export interface ToolGuidanceEntryConfig {
  readonly id: string
  readonly enabled: boolean
  readonly text: string
}

/** Normalized settings compatible with Thetail's public tool-guidance format. */
export interface ResolvedToolGuidanceConfig {
  readonly enabled: boolean
  readonly includeFramework: boolean
  readonly includeAgentRp: boolean
  readonly imageMode: AgentRpImageMode
  /** Post-narrative state settlement cadence; absent settings keep the previous automatic behavior. */
  readonly stateMode: AgentRpStateMode
  /** When narrative requests carry tool schemas; absent settings resolve to on-demand. */
  readonly requestTools: AgentRpRequestToolsMode
  readonly custom: readonly ToolGuidanceEntryConfig[]
}

/** Immutable tool policy frozen into one concrete Roleplay turn. */
export interface RoleplayToolPolicyPlan {
  readonly format: 0
  /** Exact normalized workspace input needed to replay this policy. */
  readonly source: ResolvedToolGuidanceConfig
  readonly capability: {
    /** Whether Agent RP's two durable-artifact presentation tools are visible and executable. */
    readonly artifactPresentation: boolean
  }
  readonly behavior: {
    readonly image: {
      readonly mode: AgentRpImageMode
      /** Runtime publication limit; choosing whether to generate remains an Agent decision. */
      readonly maxPublicationsPerTurn: 0 | 1
    }
    readonly state: {
      readonly mode: AgentRpStateMode
      /** Whether this turn prepares a state contract at all. */
      readonly contractPrepared: boolean
      /** Whether the post-narrative Worker settles without an explicit player request. */
      readonly settleAutomatically: boolean
    }
    readonly request: {
      /** Whether this turn's narrative requests may leave their tool schemas off. */
      readonly tools: AgentRpRequestToolsMode
    }
  }
  readonly guidance: {
    readonly includeFramework: boolean
    readonly customIds: readonly string[]
    /** Short model-visible context compiled from the structured policy. */
    readonly contextText: string
  }
}

/** Neutral defaults expose the publication seam without assuming one image provider. */
export const DEFAULT_TOOL_GUIDANCE: ResolvedToolGuidanceConfig = {
  enabled: true,
  includeFramework: true,
  includeAgentRp: true,
  imageMode: 'auto',
  stateMode: 'auto',
  requestTools: 'on-demand',
  custom: [],
}

function requiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${field} is invalid`)
  const normalized = value.trim()
  if (normalized === '') throw new TypeError(`${field} must contain non-whitespace text`)
  return normalized
}

/** Validate persisted guidance while accepting settings written by Thetail's fork verbatim. */
export function normalizeToolGuidanceConfig(value: unknown): ResolvedToolGuidanceConfig {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new TypeError('toolGuidance must be an object')
  }
  const source = value === undefined ? {} : value as Record<string, unknown>
  const bool = (field: 'enabled' | 'includeFramework' | 'includeAgentRp'): boolean => {
    const candidate = source[field]
    if (candidate === undefined) return DEFAULT_TOOL_GUIDANCE[field]
    if (typeof candidate !== 'boolean') throw new TypeError(`toolGuidance.${field} is invalid`)
    return candidate
  }
  const imageMode = source.imageMode ?? DEFAULT_TOOL_GUIDANCE.imageMode
  if (imageMode !== 'never' && imageMode !== 'requested' && imageMode !== 'auto' && imageMode !== 'always') {
    throw new TypeError('toolGuidance.imageMode is invalid')
  }
  // Settings written by forks predate this field, so its absence keeps the
  // automatic cadence instead of silently disabling state settlement.
  const stateMode = source.stateMode ?? DEFAULT_TOOL_GUIDANCE.stateMode
  if (stateMode !== 'never' && stateMode !== 'requested' && stateMode !== 'auto') {
    throw new TypeError('toolGuidance.stateMode is invalid')
  }
  const requestTools = source.requestTools ?? DEFAULT_TOOL_GUIDANCE.requestTools
  if (requestTools !== 'on-demand' && requestTools !== 'always') {
    throw new TypeError('toolGuidance.requestTools is invalid')
  }
  const customSource = source.custom ?? DEFAULT_TOOL_GUIDANCE.custom
  if (!Array.isArray(customSource) || customSource.length > 32) {
    throw new TypeError('toolGuidance.custom is invalid')
  }
  const custom = customSource.map((value, index): ToolGuidanceEntryConfig => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`toolGuidance.custom[${index}] is invalid`)
    }
    const entry = value as Record<string, unknown>
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new TypeError(`toolGuidance.custom[${index}].enabled is invalid`)
    }
    return {
      id: requiredText(entry.id, 80, `toolGuidance.custom[${index}].id`),
      enabled: entry.enabled ?? true,
      text: requiredText(entry.text, 12_000, `toolGuidance.custom[${index}].text`),
    }
  })
  if (new Set(custom.map(entry => entry.id)).size !== custom.length) {
    throw new TypeError('toolGuidance custom entry ids must be unique')
  }
  return {
    enabled: bool('enabled'),
    includeFramework: bool('includeFramework'),
    includeAgentRp: bool('includeAgentRp'),
    imageMode,
    stateMode,
    requestTools,
    custom,
  }
}

function roleplayImageModeGuidance(mode: AgentRpImageMode): string {
  if (mode === 'never') return '图像工具策略：本回合不生成或发布角色插图。'
  if (mode === 'requested') return '图像工具策略：只有玩家在本轮明确要求图片时才可以调用生图与发布工具。'
  if (mode === 'always') {
    return '图像工具策略：若已配置可用的生图工具，本回合应至多尝试一次生图与发布；工具不可用或失败时继续正常回复，不循环重试。'
  }
  return '图像工具策略：用户明确要求图片，或当前场景确实受益于插图时可以调用；普通对话无需生图。'
}

/** Compile persisted compatibility settings into one replayable turn policy. */
export function prepareRoleplayToolPolicy(
  value: ResolvedToolGuidanceConfig = DEFAULT_TOOL_GUIDANCE,
): RoleplayToolPolicyPlan {
  const source = normalizeToolGuidanceConfig(value)
  const artifactPresentation = source.enabled && source.includeAgentRp && source.imageMode !== 'never'
  const custom = source.enabled ? source.custom.filter(entry => entry.enabled) : []
  const contextText = !source.enabled ? '' : [
    '【Agent RP 工具策略】',
    ...(source.includeFramework ? [
      '只有玩家明确要求长期记住时才使用持久记忆工具；显式导入角色卡、世界书或预设时使用对应的导入工具。',
    ] : []),
    ...(artifactPresentation ? [
      '本机已配置图片服务时，可以在完成本轮可见正文后调用一次 generate_roleplay_image；它会返回不会自动显示在正文中的持久图片产物。',
      '要把产物放在本轮最终角色回复之后，优先以其准确 artifact id 调用 stage_roleplay_artifact；兼容旧工具链时可以改用 publish_roleplay_image。',
      '一次图片只使用一种发布方式；不得传入 URL、data URI、base64、临时链接或猜测的路径，发布失败后不得原样重复调用。',
    ] : []),
    ...custom.map(entry => `工具提供方说明（${entry.id}）：\n${entry.text}`),
    roleplayImageModeGuidance(artifactPresentation ? source.imageMode : 'never'),
  ].join('\n')
  return {
    format: 0,
    source: {
      ...source,
      custom: source.custom.map(entry => ({ ...entry })),
    },
    capability: { artifactPresentation },
    behavior: {
      image: {
        mode: artifactPresentation ? source.imageMode : 'never',
        maxPublicationsPerTurn: artifactPresentation ? 1 : 0,
      },
      state: {
        mode: source.stateMode,
        // A prepared contract is what makes the state readable and a manual
        // settlement possible, so only "never" withholds it.
        contractPrepared: source.stateMode !== 'never',
        settleAutomatically: source.stateMode === 'auto',
      },
      request: { tools: source.requestTools },
    },
    guidance: {
      includeFramework: source.enabled && source.includeFramework,
      customIds: custom.map(entry => entry.id),
      contextText,
    },
  }
}
