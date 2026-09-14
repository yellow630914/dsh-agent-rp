/** Browser-safe protocol for inspecting the Host's archived Sessions. */

/** Same-origin read endpoint owned by Agent RP. */
export const ARCHIVED_SESSION_PATH = '/api/agent-rp/archived-sessions'

/** One archived Session as the panel shows it. */
export interface ArchivedSessionSummary {
  readonly id: string
  /** Title as the Session last recorded it; absent when it never got one. */
  readonly title?: string
  readonly createdAt?: number
  /** Working directory the Session belongs to, for telling similarly titled ones apart. */
  readonly cwd?: string
  readonly eventCount?: number
  readonly sizeBytes?: number
  /** False when the archive set still names a Session whose log is gone. */
  readonly stored: boolean
}

/** Complete archived listing, newest archive entry last. */
export interface ArchivedSessionListResponse {
  readonly format: 0
  readonly entries: readonly ArchivedSessionSummary[]
  /**
   * Whether this Host exposes the Workspace registry at all.
   *
   * A Host without it has no archive concept, which the panel must say rather
   * than showing an empty list that looks like "nothing archived".
   */
  readonly available: boolean
}
