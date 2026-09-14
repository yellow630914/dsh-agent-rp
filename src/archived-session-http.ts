/**
 * Read-only view of the Host's archived Sessions.
 *
 * DSH archives a Session by adding its id to one registry-global set. That set
 * is write-once through the public seam — `workspaceRegistry.archiveSession()`
 * adds, and nothing removes — and neither the registry nor session persistence
 * offers a delete. So this surface deliberately only reads: unarchiving and
 * deleting are done against the stopped Host by the deployment script, where
 * there is no second writer to race and no in-memory registry state to clobber.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { jsonResponse as json, trustedBrowserRequest, type AgentRpHttpServer } from './host-http.ts'
import { ARCHIVED_SESSION_PATH, type ArchivedSessionSummary } from './archived-session-protocol.ts'

/** Upper bound on listed entries, so a very large archive cannot stall the panel. */
const MAX_ARCHIVED_ENTRIES = 2_000

interface StoredHeader {
  readonly id: string
  readonly title?: unknown
  readonly createdAt?: unknown
  readonly cwd?: unknown
}

interface StoredSnapshot {
  readonly header: StoredHeader
  readonly eventCount?: unknown
  readonly sizeBytes?: unknown
}

interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

interface SessionPersistenceLike {
  list(): Promise<readonly StoredSnapshot[]>
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the archived set against what is actually stored.
 * @param archived - registry-global archived ids, in archive order.
 * @param stored - every Session the persistence backend can list.
 * @returns one summary per archived id, including ids whose log is gone.
 */
export function describeArchivedSessions(
  archived: readonly string[],
  stored: readonly StoredSnapshot[],
): readonly ArchivedSessionSummary[] {
  const bySnapshot = new Map(stored.map(snapshot => [String(snapshot.header.id), snapshot]))
  return archived.slice(0, MAX_ARCHIVED_ENTRIES).map(id => {
    const snapshot = bySnapshot.get(id)
    if (snapshot === undefined) return { id, stored: false }
    return {
      id,
      ...(optionalText(snapshot.header.title) === undefined ? {} : { title: optionalText(snapshot.header.title)! }),
      ...(optionalCount(snapshot.header.createdAt) === undefined
        ? {} : { createdAt: optionalCount(snapshot.header.createdAt)! }),
      ...(optionalText(snapshot.header.cwd) === undefined ? {} : { cwd: optionalText(snapshot.header.cwd)! }),
      ...(optionalCount(snapshot.eventCount) === undefined ? {} : { eventCount: optionalCount(snapshot.eventCount)! }),
      ...(optionalCount(snapshot.sizeBytes) === undefined ? {} : { sizeBytes: optionalCount(snapshot.sizeBytes)! }),
      stored: true,
    }
  })
}

/** Register the same-origin archived-Session listing used by the resource center. */
export function installArchivedSessionHttp(
  ctx: Context,
  hostCtx: Context,
  server: AgentRpHttpServer,
): void {
  ctx.effect(() => server.register({
    kind: 'exact',
    path: ARCHIVED_SESSION_PATH,
    async handler(request, response) {
      if (!trustedBrowserRequest(request)) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        json(response, 405, { error: 'method not allowed' })
        return
      }
      // Both services are first-party but neither is one this plugin requires:
      // a Host without them should still serve every other Agent RP surface.
      const registry = hostCtx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      const persistence = hostCtx.get('sessionPersistence') as SessionPersistenceLike | undefined
      if (registry === undefined) {
        json(response, 200, { format: 0, entries: [], available: false })
        return
      }
      try {
        const stored = persistence === undefined ? [] : await persistence.list()
        json(response, 200, {
          format: 0,
          available: true,
          entries: describeArchivedSessions([...registry.archivedSessionIds].map(String), stored),
        })
      } catch (error: unknown) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'agent-rp: archived session listing HTTP')
}
