/** Same-origin writes for the resource center's flat labels. */

import { CHARACTER_LIBRARY_PATH } from '../character-library-protocol.ts'
import { PERSONA_LIBRARY_PATH } from '../persona-library-protocol.ts'
import { STATE_SCHEME_LIBRARY_PATH } from '../state-scheme-library-protocol.ts'
import { WORLD_INFO_LIBRARY_PATH } from '../world-info-library-protocol.ts'
import type { PersonaLibraryEntry } from '../persona-library-protocol.ts'
import type { StateSchemeLibraryEntry } from '../state-scheme-library-protocol.ts'

/** The resource-center libraries that carry labels. */
export type TaggableResource = 'characters' | 'world-info' | 'personas' | 'state-schemes'

async function settle(response: Response, fallback: string): Promise<void> {
  if (response.ok) return
  const value = await response.json().catch(() => ({})) as { readonly error?: string }
  throw new Error(value.error ?? `${fallback}（${String(response.status)}）`)
}

const json = { accept: 'application/json', 'content-type': 'application/json' }

/**
 * Replace one resource's labels.
 *
 * Each library keeps labels where its own storage already keeps per-resource
 * metadata, so there is one call shape per kind rather than one shared endpoint:
 * the world book writes a sidecar beside its content-addressed bytes, the card
 * writes its metadata file, and the Persona and scheme carry them inside the
 * record they already save whole.
 * @param kind - which library owns the resource.
 * @param id - the resource.
 * @param tags - complete replacement label set.
 * @param context - the extra fields a whole-record save needs.
 */
export async function saveResourceTags(
  kind: TaggableResource,
  id: string,
  tags: readonly string[],
  context?: PersonaLibraryEntry | StateSchemeLibraryEntry,
): Promise<void> {
  if (kind === 'characters') {
    await settle(await fetch(`${CHARACTER_LIBRARY_PATH}/${encodeURIComponent(id)}/tags`, {
      method: 'POST', headers: json, body: JSON.stringify({ format: 0, tags }),
    }), '角色分类保存失败')
    return
  }
  if (kind === 'world-info') {
    await settle(await fetch(WORLD_INFO_LIBRARY_PATH, {
      method: 'PATCH', headers: json, body: JSON.stringify({ format: 0, id, tags }),
    }), '世界书分类保存失败')
    return
  }
  if (kind === 'personas') {
    const persona = context as PersonaLibraryEntry
    await settle(await fetch(PERSONA_LIBRARY_PATH, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        format: 0, id, name: persona.name, description: persona.description, tags,
      }),
    }), '身份分类保存失败')
    return
  }
  const scheme = context as StateSchemeLibraryEntry
  await settle(await fetch(STATE_SCHEME_LIBRARY_PATH, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      format: 0,
      id,
      expectedRevision: scheme.revision,
      name: scheme.name,
      stateId: scheme.stateId,
      initial: scheme.initial,
      rules: scheme.rules,
      template: scheme.template,
      tags,
    }),
  }), '状态方案分类保存失败')
}
