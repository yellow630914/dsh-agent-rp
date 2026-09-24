/** Browser HTTP access for authored native state schemes and their panel templates. */

import {
  STATE_SCHEME_LIBRARY_PATH,
  type StateSchemeLibraryDeleteResponse,
  type StateSchemeLibraryEntry,
  type StateSchemeLibraryEntryResponse,
  type StateSchemeLibraryListResponse,
  type StateSchemeLibrarySaveRequest,
  type StateSchemeLibrarySummary,
} from '../state-scheme-library-protocol.ts'
import {
  ROLEPLAY_STATE_RESETTLE_PATH,
  type RoleplayStateResettleResponse,
} from '../roleplay-state-resettle-protocol.ts'
import { ROLEPLAY_STATE_SCHEME_SESSION_PATH } from '../roleplay-state-scheme-session-protocol.ts'
import type { RoleplayStateTemplate } from '../roleplay-state-template.ts'

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const value = await response.json() as { readonly error?: string } & T
  if (!response.ok) throw new Error(value.error ?? `${fallback}（${response.status}）`)
  return value
}

/** List every authored scheme without loading templates into the resource center. */
export async function listStateSchemes(): Promise<readonly StateSchemeLibrarySummary[]> {
  const response = await fetch(STATE_SCHEME_LIBRARY_PATH, { headers: { accept: 'application/json' } })
  return (await responseJson<StateSchemeLibraryListResponse>(response, '状态方案库读取失败')).entries
}

/** Read one complete authored scheme, including its display-only template. */
export async function readStateScheme(id: string): Promise<StateSchemeLibraryEntry> {
  const response = await fetch(`${STATE_SCHEME_LIBRARY_PATH}?id=${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
  })
  return (await responseJson<StateSchemeLibraryEntryResponse>(response, '状态方案读取失败')).entry
}

/** Create or replace one authored scheme under an explicit revision check. */
export async function saveStateScheme(
  request: StateSchemeLibrarySaveRequest,
): Promise<StateSchemeLibraryEntry> {
  const response = await fetch(STATE_SCHEME_LIBRARY_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  return (await responseJson<StateSchemeLibraryEntryResponse>(response, '状态方案保存失败')).entry
}

/** Remove the reusable scheme while preserving every Session-owned snapshot. */
export async function deleteStateScheme(id: string): Promise<void> {
  const response = await fetch(`${STATE_SCHEME_LIBRARY_PATH}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { accept: 'application/json' },
  })
  await responseJson<StateSchemeLibraryDeleteResponse>(response, '状态方案移除失败')
}

/** Ask the Host to recalculate the latest closed turn's state from its prepared baseline. */
export async function resettleRoleplayState(sessionId: string): Promise<RoleplayStateResettleResponse> {
  const response = await fetch(ROLEPLAY_STATE_RESETTLE_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ format: 0, sessionId }),
  })
  const value = await responseJson<RoleplayStateResettleResponse>(response, '状态重新结算失败')
  if (value.outcome === 'failed' || value.outcome === 'skipped') {
    throw new Error(value.error ?? '状态重新结算没有得到可用结果')
  }
  return value
}

/** Read the contract and the panel template this Session is actually running with. */
export async function readSessionStateScheme(sessionId: string): Promise<{
  readonly template: RoleplayStateTemplate
  readonly templateOrigin: 'session' | 'source' | 'builtin'
}> {
  const response = await fetch(
    `${ROLEPLAY_STATE_SCHEME_SESSION_PATH}?session=${encodeURIComponent(sessionId)}`,
    { headers: { accept: 'application/json' } },
  )
  return responseJson(response, '状态方案读取失败')
}

/** Switch this Session onto another scheme, or edit its own copy in place. */
export async function changeSessionStateScheme(
  sessionId: string,
  change: { readonly resourceId?: string; readonly edit?: {
    readonly name?: string
    readonly initial?: unknown
    readonly rules?: string
    readonly template?: RoleplayStateTemplate | null
    readonly verificationMaxTokens?: number | null
  } },
): Promise<void> {
  const response = await fetch(ROLEPLAY_STATE_SCHEME_SESSION_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ format: 0, sessionId, ...change }),
  })
  await responseJson<{ readonly format: 0 }>(response, '状态方案变更失败')
}

/** List every scheme this Session could switch onto, built-in first. */
export async function listStateSchemeSources(): Promise<readonly {
  readonly id: string
  readonly name: string
}[]> {
  const response = await fetch('/api/agent-rp/resources', { headers: { accept: 'application/json' } })
  const value = await responseJson<{
    readonly entries: readonly { readonly kind: string; readonly id: string; readonly name: string }[]
  }>(response, '资源目录读取失败')
  return value.entries.filter(entry => entry.kind === 'state-scheme')
    .map(entry => ({ id: entry.id, name: entry.name }))
}
