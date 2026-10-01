/** Browser-safe values shared by the local Persona library and Roleplay UI. */

/** Same-origin endpoint served by the Agent RP Host plugin. */
export const PERSONA_LIBRARY_PATH = '/api/agent-rp/personas'

/** Reusable player identity stored outside Character Cards and Sessions. */
export interface PersonaLibraryEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly updatedAt: number
  /** Flat resource-center labels; display-only, nothing downstream reads them. */
  readonly tags: readonly string[]
}

/** Fields accepted when creating or editing one reusable Persona. */
export interface PersonaLibrarySaveRequest {
  readonly format: 0
  readonly id?: string
  readonly name: string
  readonly description: string
  /** Omitted keeps the entry's existing labels; an empty array clears them. */
  readonly tags?: readonly string[]
}

/** Immutable Persona snapshot selected for one new Roleplay Session. */
export interface SessionPersonaSnapshot {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** Validate and normalize a Persona snapshot crossing a Session command or event boundary. */
export function parseSessionPersonaSnapshot(value: unknown): SessionPersonaSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Persona 快照不是对象')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (typeof record.id !== 'string' || !/^persona-[0-9a-f-]+$/u.test(record.id)
    || typeof record.name !== 'string' || record.name.trim() === '' || record.name.trim().length > 120
    || typeof record.description !== 'string' || record.description.trim().length > 12_000
    || keys.some(key => key !== 'id' && key !== 'name' && key !== 'description')) {
    throw new Error('Persona 快照字段无效')
  }
  return {
    id: record.id,
    name: record.name.trim(),
    description: record.description.trim(),
  }
}
