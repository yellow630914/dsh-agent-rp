/** Browser-safe protocol for invoking Agent RP's model-free Session commands. */

/** Stable same-origin command endpoint owned by Agent RP. */
export const AGENT_RP_COMMAND_PATH = '/api/agent-rp/command'

/** Commands that the Agent RP browser client may invoke through its private endpoint. */
export const AGENT_RP_COMMAND_NAMES = Object.freeze([
  'rp-tavern-variables',
  'rp-tavern-trigger',
  'rp-character-library',
  'rp-chat-import',
  'rp-persona',
  'rp-story-workspace',
  'rp-memory',
  'rp-state',
  'rp-turn-mode',
  'rp-preset-configure',
  'rp-preset-library',
  'rp-generation',
  'rp-draw',
  'rp-world-info',
  'rp-world-info-import',
  'rp-regex',
] as const)

export type AgentRpCommandName = typeof AGENT_RP_COMMAND_NAMES[number]

/** One model-free command request from the Agent RP browser client. */
export interface AgentRpCommandRequest {
  readonly format: 0
  readonly sessionId: string
  readonly line: string
}

/** Admission result after the native DSH command executor has settled. */
export type AgentRpCommandResponse =
  | { readonly format: 0; readonly matched: false }
  | { readonly format: 0; readonly matched: true; readonly commandId: string }

const COMMAND_NAMES = new Set<string>(AGENT_RP_COMMAND_NAMES)

/** Read and validate one allowlisted Agent RP command request. */
export function parseAgentRpCommandRequest(value: unknown): AgentRpCommandRequest & {
  readonly commandName: AgentRpCommandName
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent RP 命令请求必须是对象')
  }
  const candidate = value as Readonly<Record<string, unknown>>
  if (candidate.format !== 0) throw new Error('Agent RP 命令格式不受支持')
  if (typeof candidate.sessionId !== 'string') throw new Error('角色会话编号无效')
  const sessionId = candidate.sessionId.trim()
  if (sessionId === '' || sessionId.length > 512) throw new Error('角色会话编号无效')
  if (typeof candidate.line !== 'string' || candidate.line.length === 0) {
    throw new Error('Agent RP 命令内容无效')
  }
  const match = /^\/([a-z][a-z0-9-]*)(?=\s|$)/u.exec(candidate.line)
  const commandName = match?.[1]
  if (commandName === undefined || !COMMAND_NAMES.has(commandName)) {
    throw new Error('该命令不属于 Agent RP')
  }
  return {
    format: 0,
    sessionId,
    line: candidate.line,
    commandName: commandName as AgentRpCommandName,
  }
}
