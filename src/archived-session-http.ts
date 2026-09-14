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
  readonly revision?: unknown
  readonly eventCount?: unknown
  readonly sizeBytes?: unknown
}

interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

interface StoredEvent {
  readonly type?: unknown
  readonly data?: unknown
}

interface SessionPersistenceLike {
  list(): Promise<readonly StoredSnapshot[]>
  resolveCurrentLog?(id: string): Promise<string | undefined>
  readStoredLog?(path: string, expectedId: string): Promise<{ readonly events: readonly StoredEvent[] }>
}

/**
 * Titles resolved from a Session's log, keyed by id and stored revision.
 *
 * A title is only in the log — `SessionHeader` has no such field — so reading it
 * means decoding the whole Session. Archived logs do not change, so one read per
 * Session is the whole cost; the revision is in the key so an unarchived and
 * resumed Session still refreshes.
 *
 * A Session whose log is still in an older format has no current generation to
 * resolve, and it stays untitled here on purpose: opening it would run the
 * migration chain and write a new artifact, which a read-only panel must never
 * do as a side effect of showing a name.
 */
const titles = new Map<string, string | undefined>()

/** How many uncached titles one request will decode, so a large archive cannot stall it. */
const MAX_TITLE_READS = 12

function lastTitle(events: readonly StoredEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const value = (data as { readonly title?: unknown }).title
    if (typeof value === 'string' && value.trim() !== '') title = value
  }
  return title
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
  titleOf: (id: string) => string | undefined = () => undefined,
): readonly ArchivedSessionSummary[] {
  const bySnapshot = new Map(stored.map(snapshot => [String(snapshot.header.id), snapshot]))
  return archived.slice(0, MAX_ARCHIVED_ENTRIES).map(id => {
    const snapshot = bySnapshot.get(id)
    if (snapshot === undefined) return { id, stored: false }
    // `SessionHeader` carries no title; it only exists as a `session/title`
    // event, so the resolver reads the log and caches what it finds.
    const title = optionalText(snapshot.header.title) ?? titleOf(id)
    return {
      id,
      ...(title === undefined ? {} : { title }),
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
        const archivedIds = [...registry.archivedSessionIds].map(String)
        const keyOf = new Map(stored.map(snapshot => [
          String(snapshot.header.id),
          `${String(snapshot.header.id)} ${String(snapshot.revision ?? '')}`,
        ]))
        let reads = 0
        let pendingTitles = 0
        for (const id of archivedIds) {
          const cacheKey = keyOf.get(id)
          if (cacheKey === undefined || titles.has(cacheKey)) continue
          if (persistence?.resolveCurrentLog === undefined || persistence.readStoredLog === undefined) break
          if (reads >= MAX_TITLE_READS) { pendingTitles += 1; continue }
          reads += 1
          try {
            const path = await persistence.resolveCurrentLog(id)
            const log = path === undefined ? undefined : await persistence.readStoredLog(path, id)
            titles.set(cacheKey, log === undefined ? undefined : lastTitle(log.events))
          } catch {
            // A log this Host cannot decode still belongs in the list; it just
            // shows without a title rather than failing the whole request.
            titles.set(cacheKey, undefined)
          }
        }
        json(response, 200, {
          format: 0,
          available: true,
          pendingTitles,
          entries: describeArchivedSessions(archivedIds, stored, id => {
            const cacheKey = keyOf.get(id)
            return cacheKey === undefined ? undefined : titles.get(cacheKey)
          }),
        })
      } catch (error: unknown) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'agent-rp: archived session listing HTTP')
}
