/** Browser-side assembly of current library choices into source-neutral experience requests. */

import type { SessionPersonaSnapshot } from '../persona-library-protocol.ts'
import type { RoleplayResourceSelection } from '../roleplay-resource-catalog-protocol.ts'
import {
  characterLibraryRoleplayResourceId,
  presetLibraryRoleplayResourceId,
  regexPackLibraryRoleplayResourceId,
  worldInfoLibraryRoleplayResourceId,
} from '../roleplay-resource-library-ids.ts'
import type { RoleplayExperienceSessionLaunchRequest } from '../session-launch-protocol.ts'

export type CharacterExperienceSelection = Pick<
  RoleplayExperienceSessionLaunchRequest,
  'actor' | 'participant' | 'worlds' | 'promptPolicy'
  | 'regexPacks'
  | 'stateScheme'
  | 'agentPresetId'
>

export type SceneExperienceSelection = Pick<
  RoleplayExperienceSessionLaunchRequest,
  'participant' | 'worlds' | 'promptPolicy'
  | 'regexPacks'
  | 'stateScheme'
  | 'agentPresetId'
>

/** Assemble the exact peer resources shared by launch and preflight for a character experience. */
export function characterExperienceSelection(input: {
  readonly characterId: string
  readonly greetingIndex: number
  readonly persona?: SessionPersonaSnapshot
  readonly presetId?: string
  readonly worldInfoIds: readonly string[]
  readonly regexPackIds?: readonly string[]
  readonly stateSchemeId?: string
  readonly agentPresetId?: string
}): CharacterExperienceSelection {
  if (!Number.isSafeInteger(input.greetingIndex) || input.greetingIndex < 0) {
    throw new Error('角色开场序号无效')
  }
  return {
    actor: {
      kind: 'actor',
      id: characterLibraryRoleplayResourceId(input.characterId),
      variant: `greeting:${input.greetingIndex}`,
    },
    ...(input.persona === undefined
      ? {}
      : { participant: { kind: 'persona' as const, id: input.persona.id } }),
    worlds: input.worldInfoIds.map(id => ({
      kind: 'world' as const,
      id: worldInfoLibraryRoleplayResourceId(id),
    })),
    ...(input.presetId === undefined
      ? {}
      : { promptPolicy: { kind: 'prompt-policy' as const, id: presetLibraryRoleplayResourceId(input.presetId) } }),
    regexPacks: (input.regexPackIds ?? []).map(id => ({
      kind: 'regex' as const,
      id: regexPackLibraryRoleplayResourceId(id),
    })),
    ...(input.stateSchemeId === undefined || input.stateSchemeId === ''
      ? {}
      : { stateScheme: { kind: 'state-scheme' as const, id: input.stateSchemeId } }),
    ...(input.agentPresetId === undefined ? {} : { agentPresetId: input.agentPresetId }),
  }
}

/** Assemble the exact peer resources shared by launch and preflight for a scene experience. */
export function sceneExperienceSelection(input: {
  readonly primaryWorldInfoId: string
  readonly persona?: SessionPersonaSnapshot
  readonly presetId?: string
  readonly supportingWorldInfoIds: readonly string[]
  readonly regexPackIds?: readonly string[]
  readonly stateSchemeId?: string
  readonly agentPresetId?: string
}): SceneExperienceSelection {
  return {
    ...(input.persona === undefined
      ? {}
      : { participant: { kind: 'persona' as const, id: input.persona.id } }),
    worlds: [input.primaryWorldInfoId, ...input.supportingWorldInfoIds].map(id => ({
      kind: 'world' as const,
      id: worldInfoLibraryRoleplayResourceId(id),
    })),
    ...(input.presetId === undefined
      ? {}
      : { promptPolicy: { kind: 'prompt-policy' as const, id: presetLibraryRoleplayResourceId(input.presetId) } }),
    regexPacks: (input.regexPackIds ?? []).map(id => ({
      kind: 'regex' as const,
      id: regexPackLibraryRoleplayResourceId(id),
    })),
    ...(input.stateSchemeId === undefined || input.stateSchemeId === ''
      ? {}
      : { stateScheme: { kind: 'state-scheme' as const, id: input.stateSchemeId } }),
    ...(input.agentPresetId === undefined ? {} : { agentPresetId: input.agentPresetId }),
  }
}

/** Flatten one native experience selection into preflight resource order. */
export function experiencePreflightResources(
  selection: CharacterExperienceSelection | SceneExperienceSelection,
): readonly RoleplayResourceSelection[] {
  return [
    ...('actor' in selection && selection.actor !== undefined ? [selection.actor] : []),
    ...(selection.participant === undefined ? [] : [selection.participant]),
    ...(selection.worlds ?? []),
    ...(selection.regexPacks ?? []),
    ...(selection.promptPolicy === undefined ? [] : [selection.promptPolicy]),
    ...(selection.stateScheme === undefined ? [] : [selection.stateScheme]),
  ]
}

export function characterExperienceLaunchRequest(input: {
  readonly sourceSessionId: string
  readonly characterId: string
  readonly greetingIndex: number
  readonly persona?: SessionPersonaSnapshot
  readonly presetId?: string
  readonly worldInfoIds: readonly string[]
  readonly regexPackIds?: readonly string[]
  readonly stateSchemeId?: string
}): RoleplayExperienceSessionLaunchRequest {
  return {
    format: 0,
    sourceSessionId: input.sourceSessionId,
    kind: 'experience',
    mode: 'character',
    ...characterExperienceSelection(input),
  }
}

export function sceneExperienceLaunchRequest(input: {
  readonly sourceSessionId: string
  readonly primaryWorldInfoId: string
  readonly persona?: SessionPersonaSnapshot
  readonly presetId?: string
  readonly supportingWorldInfoIds: readonly string[]
  readonly regexPackIds?: readonly string[]
  readonly stateSchemeId?: string
}): RoleplayExperienceSessionLaunchRequest {
  return {
    format: 0,
    sourceSessionId: input.sourceSessionId,
    kind: 'experience',
    mode: 'scene',
    ...sceneExperienceSelection(input),
  }
}
