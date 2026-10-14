/**
 * The repair itself: keep a `subCallId` from repeating inside one session log.
 *
 * ## The invariant being protected
 *
 * `packages/session/session-format-v3-to-v4/src/relationships.ts` walks the
 * whole log and keeps one map of PTC dispatches keyed by `subCallId`:
 *
 * ```ts
 * if (event.type === 'tool/ptc-dispatch-start') {
 *   if (existing !== undefined) throw new SessionFormatError('PTC dispatch repeats subCallId')
 * ```
 *
 * The entry is never deleted, so the rule is not "one live dispatch per id" but
 * "one dispatch per id **in the entire log**". A second start carrying an id
 * that any earlier start already used is therefore fatal, and the check is
 * reached only when the log is read — which is all-or-nothing. One repeat costs
 * the whole session (discussion #9677).
 *
 * ## What the ledger does
 *
 * It mirrors exactly that map, and it mirrors it from both directions:
 *
 * - **Primed from a read.** The resume path reads the stored prefix before it
 *   appends anything, so the ids already in the log are learned for free.
 * - **Fed by appends.** Every start that goes past it is remembered.
 *
 * When a start arrives whose id has already been started, the id is rewritten
 * to one that is unique in this session — `${original}::r1`, `::r2`, … The
 * producer's own ids are `${callId}:ptc:${n}` and never carry `::r`, so the
 * two namespaces cannot collide, and the candidate is checked against the
 * used-set anyway.
 *
 * ## Carrying the settle
 *
 * The producer does not know about the rename, so the settle for a renamed
 * dispatch still arrives under the original id. Each start pushes its written
 * id onto a FIFO keyed by the id the producer used, and the settle pops it —
 * which is why the pairing is well defined: the format requires a start before
 * its settle, so a settle for `X` belongs to the oldest unsettled write of `X`.
 *
 * ## Two properties worth keeping
 *
 * - **`rootCallId` and `parentCallId` are never rewritten.** The rename keeps
 *   the dispatch's root, and the reader's parent test compares roots, so a
 *   nested dispatch whose `parentCallId` still names the original id resolves
 *   to the first (never renamed) start of that id and passes.
 * - **Renaming heals on repetition.** A nested dispatch id derives from its
 *   parent's original id (`${parent}:ptc:${n}`), so when the parent collides a
 *   second time the nested id it yields is one the ledger has already seen —
 *   and is renamed in turn. The rule needs no special case for nesting.
 *
 * @module @argszero/dsh-ptc-subcall-guard/repair
 */

/** The event type that opens one PTC sub-call. */
export const PTC_DISPATCH_START = 'tool/ptc-dispatch-start'

/** The event type that settles it. */
export const PTC_DISPATCH_SETTLE = 'tool/ptc-dispatch'

/**
 * The infix a guarded id carries.
 *
 * The producer mints `${callId}:ptc:${n}` (`packages/core/tools/src/ptc.ts`),
 * so this spelling is outside its namespace: a guarded id can never be mistaken
 * for an id the producer would have minted itself.
 */
export const REPAIR_INFIX = '::r'

/** A session event as this module reads it: `type`, and `data` when it is a record. */
export type EventLike = Record<string, unknown>

/** One rewritten `subCallId`, for the operator. */
export interface RepairRecord {
  /** The id the producer minted, which an earlier start in this session already used. */
  readonly original: string
  /** The session-unique id written in its place. */
  readonly replacement: string
  /** Whether the paired settle was carried along; false when it has not arrived (or never will). */
  settleCarried: boolean
}

/** What one {@link SubCallLedger.repair} call did. */
export interface RepairOutcome {
  /**
   * The batch to append: the caller's own array when nothing needed rewriting,
   * otherwise a copy in which the affected events — and only those — are
   * replaced. Input events are never mutated.
   */
  readonly events: readonly EventLike[]
  /** One record per colliding start in this batch. */
  readonly repairs: readonly RepairRecord[]
  /** How many events in this batch had a `subCallId` rewritten. */
  readonly rewritten: number
}

/**
 * Whether one event opens or settles a PTC dispatch.
 * @param type - the event's `type` field, as stored.
 * @returns `start`, `settle`, or `undefined` for every other event.
 */
export function dispatchRole(type: unknown): 'start' | 'settle' | undefined {
  if (type === PTC_DISPATCH_START) return 'start'
  if (type === PTC_DISPATCH_SETTLE) return 'settle'
  return undefined
}

/**
 * The `subCallId` an event carries, when it carries one as a string.
 * @param event - one session event.
 * @returns the id, or `undefined` for every other shape.
 */
export function subCallIdOf(event: EventLike): string | undefined {
  const data = event['data']
  if (data === null || typeof data !== 'object') return undefined
  const id = (data as Record<string, unknown>)['subCallId']
  return typeof id === 'string' ? id : undefined
}

/**
 * One session's dispatch identity.
 *
 * One ledger per stored session: the invariant is per log, so state shared
 * across sessions would rename things that do not collide.
 */
export class SubCallLedger {
  /** Every `subCallId` this log has already opened a dispatch with. */
  private readonly started = new Set<string>()

  /** For each id the producer used, the ids written for its still-unsettled dispatches. */
  private readonly open = new Map<string, string[]>()

  /** Every repair this ledger made, oldest first. */
  private readonly records: RepairRecord[] = []

  /** Repairs whose settle has not been carried yet, keyed by the written id. */
  private readonly awaitingSettle = new Map<string, RepairRecord>()

  /**
   * Learn the ids a stored prefix already used, so a resumed session renames
   * against the whole log rather than only what it appends.
   *
   * Only starts count: the reader's map is written on a start and merely read on
   * a settle, so a settle-only id is not in it.
   * @param events - the stored events, as `SessionHandle.read` returned them.
   */
  prime(events: readonly EventLike[]): void {
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (dispatchRole(event['type']) !== 'start') continue
      const id = subCallIdOf(event)
      if (id !== undefined) this.started.add(id)
    }
  }

  /** How many collisions this ledger has repaired. */
  get repairCount(): number {
    return this.records.length
  }

  /** Every collision repaired so far. */
  get repairs(): readonly RepairRecord[] {
    return this.records
  }

  /**
   * Rewrite the colliding `subCallId`s in one batch, in order.
   *
   * Pure with respect to its input: the caller's events and their `data`
   * objects are never mutated, because the session holds them and the same
   * values reach the in-memory log.
   * @param events - one contiguous append batch, in seq order.
   * @returns the batch to append, the collisions it repaired, and how many events changed.
   */
  repair(events: readonly EventLike[]): RepairOutcome {
    let copy: EventLike[] | undefined
    const repairs: RepairRecord[] = []
    let rewritten = 0

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (event === undefined) continue
      const role = dispatchRole(event['type'])
      if (role === undefined) continue
      const id = subCallIdOf(event)
      if (id === undefined) continue
      const data = event['data'] as Record<string, unknown>

      if (role === 'start') {
        const repeated = this.started.has(id)
        const written = repeated ? this.mintUnique(id) : id
        this.started.add(written)
        const queue = this.open.get(id)
        if (queue === undefined) this.open.set(id, [written])
        else queue.push(written)
        if (repeated) {
          const record: RepairRecord = { original: id, replacement: written, settleCarried: false }
          this.records.push(record)
          this.awaitingSettle.set(written, record)
          repairs.push(record)
        }
        if (written !== id) {
          copy ??= [...events]
          copy[index] = { ...event, data: { ...data, subCallId: written } }
          rewritten += 1
        }
        continue
      }

      const queue = this.open.get(id)
      const written = queue === undefined ? undefined : queue.shift()
      if (written === undefined || written === id) continue
      copy ??= [...events]
      copy[index] = { ...event, data: { ...data, subCallId: written } }
      rewritten += 1
      const record = this.awaitingSettle.get(written)
      if (record !== undefined) {
        record.settleCarried = true
        this.awaitingSettle.delete(written)
      }
    }

    return { events: copy ?? events, repairs, rewritten }
  }

  /**
   * The first guarded spelling of one id this session has not used.
   * @param original - the id the producer minted.
   * @returns a session-unique id in the guard's own namespace.
   */
  private mintUnique(original: string): string {
    for (let n = 1; ; n += 1) {
      const candidate = `${original}${REPAIR_INFIX}${n}`
      if (!this.started.has(candidate)) return candidate
    }
  }
}
