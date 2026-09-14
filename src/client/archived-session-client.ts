/** Same-origin reader for the Host's archived Sessions. */

import {
  ARCHIVED_SESSION_PATH,
  type ArchivedSessionListResponse,
} from '../archived-session-protocol.ts'

/**
 * List every Session the Host has archived.
 *
 * Read-only on purpose: DSH's archive set is write-once through its public seam
 * and neither it nor session persistence offers a delete, so unarchiving and
 * deleting are done against the stopped Host by the deployment script rather
 * than racing the live registry.
 * @returns the archived entries, and whether this Host has an archive at all.
 */
export async function listArchivedSessions(): Promise<ArchivedSessionListResponse> {
  const response = await fetch(ARCHIVED_SESSION_PATH, { headers: { accept: 'application/json' } })
  const value = await response.json() as Partial<ArchivedSessionListResponse> & { readonly error?: string }
  if (!response.ok || value.format !== 0 || !Array.isArray(value.entries)) {
    throw new Error(value.error ?? `归档会话读取失败（${response.status}）`)
  }
  return {
    format: 0,
    entries: value.entries,
    available: value.available === true,
    ...(typeof value.pendingTitles === 'number' ? { pendingTitles: value.pendingTitles } : {}),
  }
}
