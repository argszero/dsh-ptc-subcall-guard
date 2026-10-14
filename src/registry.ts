/**
 * One ledger per stored session, and the reporting budget attached to it.
 *
 * The invariant is per log: `assertReleasedV4Relationships` keeps a map for the
 * session it is validating and throws on the second start that carries an id it
 * has already seen, so state shared across sessions would rename ids that never
 * collided. Hence one {@link SubCallLedger} per session id, and hence the two
 * bounds: a session dropped from the map loses only what a re-open re-learns
 * from its own stored prefix, and a session that collides forever must not write
 * forever into the log it is protecting.
 *
 * @module @argszero/dsh-ptc-subcall-guard/registry
 */

import { SubCallLedger, type RepairRecord } from './repair.ts'

/** What one call to {@link SessionRegistry.admit} released for reporting. */
export interface ReportGrant {
  /** The records to report, in order; empty when the budget is spent. */
  readonly admitted: readonly RepairRecord[]
  /** How many records this call withheld because the budget was spent. */
  readonly suppressed: number
}

/**
 * The per-session ledgers and the per-session reporting budget.
 *
 * Recency is read at lookup time rather than tracked separately: a `Map`
 * iterates in insertion order, so deleting and re-inserting on every hit makes
 * the oldest key the least recently used one.
 */
export class SessionRegistry {
  /** Ledger per session id, ordered least-recently-used first. */
  private readonly ledgers = new Map<string, SubCallLedger>()

  /** How many records have been reported for each session. */
  private readonly reported = new Map<string, number>()

  /**
   * @param maxTrackedSessions - how many sessions keep a ledger before the least recently used is dropped.
   * @param maxReportedRepairs - how many collisions are reported per session.
   */
  constructor(
    private readonly maxTrackedSessions: number,
    private readonly maxReportedRepairs: number,
  ) {}

  /**
   * The ledger for one session, marking it most recently used.
   * @param sessionId - the session the handle addresses.
   * @returns its ledger, created on first use.
   */
  ledgerFor(sessionId: string): SubCallLedger {
    const existing = this.ledgers.get(sessionId)
    if (existing !== undefined) {
      this.ledgers.delete(sessionId)
      this.ledgers.set(sessionId, existing)
      return existing
    }
    const created = new SubCallLedger()
    this.ledgers.set(sessionId, created)
    while (this.ledgers.size > this.maxTrackedSessions) {
      const oldest = this.ledgers.keys().next().value
      /* v8 ignore next -- unreachable while size exceeds a bound of at least one. */
      if (oldest === undefined) break
      this.ledgers.delete(oldest)
      this.reported.delete(oldest)
    }
    return created
  }

  /**
   * Take up to the session's remaining reporting budget.
   * @param sessionId - the session being reported on.
   * @param records - the collisions this append repaired.
   * @returns the records to report and how many were withheld.
   */
  admit(sessionId: string, records: readonly RepairRecord[]): ReportGrant {
    const already = this.reported.get(sessionId) ?? 0
    const room = Math.max(0, this.maxReportedRepairs - already)
    const admitted = records.slice(0, room)
    if (admitted.length > 0) this.reported.set(sessionId, already + admitted.length)
    return { admitted, suppressed: records.length - admitted.length }
  }

  /** How many collisions have been repaired across every tracked session. */
  get repairCount(): number {
    let total = 0
    for (const ledger of this.ledgers.values()) total += ledger.repairCount
    return total
  }

  /** How many sessions currently keep a ledger. */
  get trackedSessions(): number {
    return this.ledgers.size
  }
}
