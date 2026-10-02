/** Browser HTTP access for reusable standalone regex packs. */

import {
  SESSION_REGEX_PACK_PATH,
  type SessionRegexPackAttachResponse,
} from '../session-regex-pack-protocol.ts'
import {
  REGEX_PACK_LIBRARY_PATH,
  type RegexPackLibraryDeleteResponse,
  type RegexPackLibraryImportResponse,
  type RegexPackLibraryListResponse,
  type RegexPackLibrarySummary,
} from '../regex-pack-library-protocol.ts'

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const value = await response.json() as { readonly error?: string } & T
  if (!response.ok) throw new Error(value.error ?? `${fallback}（${response.status}）`)
  return value
}

/** List every reusable pack without loading expressions into the resource center. */
export async function listRegexPacks(): Promise<readonly RegexPackLibrarySummary[]> {
  const response = await fetch(REGEX_PACK_LIBRARY_PATH, { headers: { accept: 'application/json' } })
  return (await responseJson<RegexPackLibraryListResponse>(response, '正则包库读取失败')).entries
}

/** Import one standalone SillyTavern JSON export. */
export async function importRegexPackFile(file: File): Promise<RegexPackLibrarySummary> {
  const response = await fetch(`${REGEX_PACK_LIBRARY_PATH}?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: file,
  })
  return (await responseJson<RegexPackLibraryImportResponse>(response, '正则包导入失败')).entry
}

/** Remove the reusable copy while preserving Session-owned snapshots. */
export async function deleteRegexPack(id: string): Promise<void> {
  const response = await fetch(`${REGEX_PACK_LIBRARY_PATH}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { accept: 'application/json' },
  })
  await responseJson<RegexPackLibraryDeleteResponse>(response, '正则包移除失败')
}

/**
 * Attach one reusable pack to the Session the regex manager is open on.
 *
 * The Host reads the library once and freezes the pack's content into the
 * Session log, so editing or deleting the library entry afterwards never
 * changes what this Session runs.
 * @param sessionId - Session taking the pack.
 * @param packId - library pack to attach.
 * @returns what the Session actually took.
 */
export async function attachSessionRegexPack(
  sessionId: string,
  packId: string,
): Promise<SessionRegexPackAttachResponse> {
  const response = await fetch(SESSION_REGEX_PACK_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ format: 0, sessionId, packId }),
  })
  return responseJson<SessionRegexPackAttachResponse>(response, '正则包引入失败')
}
