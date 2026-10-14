/**
 * Keep a repeated PTC sub-call id out of the durable session log.
 *
 * ## The gap
 *
 * A `run_code` program's sub-calls are numbered per execution — the producer
 * mints `${callId}:ptc:${n}` (`packages/core/tools/src/ptc.ts`) with `n` counted
 * inside one `execute()` call and the counter starting at 1 each time. When the
 * same tool call is executed again under the same call id, the ids it mints
 * repeat, and **nothing on the write path notices**: the batch is appended as
 * built.
 *
 * The uniqueness requirement lives in the Session v4 format instead, in
 * `assertReleasedV4Relationships` (`session-format-v3-to-v4/src/validation.ts`
 * ← `relationships.ts`), which keeps one map of PTC dispatches for the log and
 * throws `PTC dispatch repeats subCallId` on the second start carrying an id it
 * has already seen. The map entry is never removed, so the rule is not "one live
 * dispatch per id" but "one dispatch per id in the entire log" — and it is
 * reached only when the log is next read, where reading is all-or-nothing. One
 * repeat therefore costs the whole session: discussion #9677 reports a real
 * 3,569-event session made permanently unopenable, the duplicate written
 * happily and discovered only on the next load.
 *
 * ## What this plugin does
 *
 * There is no event on the append path and no hook in the dispatcher, so the
 * plugin uses the service instance. `SessionPersistence` is a cordis `Service`
 * (`name: 'sessionPersistence'`) whose `open` and `create` are **prototype**
 * methods, so one own-property write on the underlying instance shadows both for
 * every caller — the agent loop's own `persistence.create(…)`
 * (`core/agent-loop/src/index.ts:682`) and `persistence.open(id, 'write', …)`
 * (`:840`), each a call-time property lookup on a `ctx.get` result.
 *
 * On the write handle that call returns, `append` is wrapped: a batch whose
 * `tool/ptc-dispatch-start` carries an id this session already started is
 * rewritten before the original sees it, and the paired
 * `tool/ptc-dispatch` settle is carried along through a FIFO keyed by the id the
 * producer used. `read` is observed so the ids in the stored prefix — which the
 * resume path loads before it appends anything — prime the used-id set for free.
 * The rename keeps `rootCallId`, so a nested dispatch's parent lookup still
 * resolves, and the replacement lives in a namespace the producer cannot mint.
 *
 * The log stays complete and loadable; the collision is logged instead of being
 * written down as a session that will not open again.
 *
 * ## What it does not do
 *
 * It does not change what the producer mints, does not touch the format
 * validator, does not rewrite any event already on disk, and does not make an
 * existing unloadable session loadable — a log already carrying a duplicate is
 * repaired by nothing here. It cannot guard a session whose handle was obtained
 * before it was mounted, and its `observe` mode deliberately passes colliding
 * batches through, for measuring the shape before repairing it.
 *
 * @module @argszero/dsh-ptc-subcall-guard
 */

import { resolveConfig, type GuardConfig } from './config.ts'
import {
  resolvePersistenceInstance,
  shadowPersistence,
  wrapWriteHandle,
  type ContextLike,
  type PersistenceCall,
} from './install.ts'
import { SessionRegistry } from './registry.ts'
import type { RepairRecord } from './repair.ts'

export { DEFAULT_MAX_REPORTED_REPAIRS, DEFAULT_MAX_TRACKED_SESSIONS, resolveConfig } from './config.ts'
export type { GuardConfig, GuardMode, ResolvedConfig } from './config.ts'
export {
  OPEN_MARK,
  ORIGINAL,
  resolvePersistenceInstance,
  shadowPersistence,
  wrapWriteHandle,
} from './install.ts'
export type {
  ContextLike,
  PersistenceCall,
  PersistenceInstance,
  PersistenceInstanceSource,
  ShadowHandle,
  ShadowOutcome,
  WrapOutcome,
} from './install.ts'
export { SessionRegistry } from './registry.ts'
export type { ReportGrant } from './registry.ts'
export {
  PTC_DISPATCH_SETTLE,
  PTC_DISPATCH_START,
  REPAIR_INFIX,
  SubCallLedger,
  dispatchRole,
  subCallIdOf,
} from './repair.ts'
export type { EventLike, RepairOutcome, RepairRecord } from './repair.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'ptc-subcall-guard'

/**
 * The service whose instance carries the seam.
 *
 * Declared so `apply` runs after the persistence service is mounted: the shadow
 * is written to the instance, and an instance that does not exist yet cannot be
 * shadowed — a plugin that mounted first would mount, log nothing, and leave the
 * repeat unwatched.
 */
export const inject = ['sessionPersistence']

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'ptc-subcall-guard:'

/** The slice of a cordis logger this plugin uses. */
interface LoggerLike {
  warn(message: string): void
  debug(message: string): void
}

/** The plugin context: a service lookup, a logger, and disposal. */
type PluginContext = ContextLike & {
  logger: LoggerLike
  effect(register: () => () => void, label?: string): void
}

/**
 * The session a handle addresses, as a string, for keying and for the log.
 * @param call - the entry-point call that produced the handle.
 * @returns the session id, or `"<unidentified session>"` when the call carried none.
 */
export function sessionIdOf(call: PersistenceCall): string {
  return typeof call.id === 'string' && call.id.length > 0 ? call.id : '<unidentified session>'
}

/**
 * Whether a handle from this call may be written through.
 *
 * `open` is called with an access, and a `read` handle refuses `append`; wrapping
 * it would install a guard over a call that can never carry the collision.
 * @param call - the entry-point call.
 * @returns true when the handle is a write handle.
 */
export function isWriteHandle(call: PersistenceCall): boolean {
  return call.method === 'create' || call.access === 'write'
}

/**
 * Render one collision for the log.
 * @param sessionId - the session the collision was repaired in.
 * @param admitted - the records being reported.
 * @param suppressed - how many records this call withheld.
 * @param mode - what the guard did with the batch.
 * @returns one line.
 */
export function describeRepairs(
  sessionId: string,
  admitted: readonly RepairRecord[],
  suppressed: number,
  mode: 'repair' | 'observe',
): string {
  const renames = admitted.map((record) => `${record.original} -> ${record.replacement}`).join(', ')
  const action = mode === 'repair'
    ? 'rewrote it, and carried the paired settle'
    : 'appended it unchanged (mode "observe")'
  const more = suppressed === 0 ? '' : `; ${String(suppressed)} further repeat(s) in this session not reported`
  return `${LOG_PREFIX} session ${sessionId}: a PTC sub-call id repeated in this log `
    + `(${renames}); the write path accepts a repeat but the v4 format validator rejects the whole log on the next read, `
    + `so ${action}${more}.`
}

/**
 * Install the guard.
 * @param ctx - the plugin context; the shadow and every ledger are disposed with it.
 * @param config - the configuration as mounted, possibly empty. Defaults live in
 *   `resolveConfig` rather than in an exported object named `Config`, because the
 *   Loader reads that export as a schema and the plugin would then fail to mount.
 * @throws when the configuration is unusable; the plugin refuses to mount rather
 *   than guarding under rules it cannot honour.
 */
export function apply(ctx: PluginContext, config: GuardConfig = {}): void {
  const settings = resolveConfig(config)
  if (!settings.enabled) {
    ctx.logger.debug(`${LOG_PREFIX} disabled by configuration; a repeated PTC sub-call id stays unwatched`)
    return
  }
  const found = resolvePersistenceInstance(ctx)
  if (found.target === undefined) {
    ctx.logger.warn(`${LOG_PREFIX} the sessionPersistence service is not mounted, so nothing is guarded: `
      + 'a repeated PTC sub-call id will reach the log as written')
    return
  }

  const registry = new SessionRegistry(settings.maxTrackedSessions, settings.maxReportedRepairs)
  let active = true

  const shadow = shadowPersistence(found.target, (call, handle) => {
    if (!isWriteHandle(call)) return
    const sessionId = sessionIdOf(call)
    const outcome = wrapWriteHandle(
      handle,
      sessionId,
      registry.ledgerFor(sessionId),
      settings.mode,
      () => active,
      {
        onRepair: (records, id) => {
          const grant = registry.admit(id, records)
          if (grant.admitted.length === 0) return
          ctx.logger.warn(describeRepairs(id, grant.admitted, grant.suppressed, settings.mode))
        },
      },
    )
    if (outcome === 'no-append' || outcome === 'not-writable') {
      ctx.logger.warn(`${LOG_PREFIX} the ${call.method} handle for session ${sessionId} could not be guarded `
        + `(${outcome}), so a repeated PTC sub-call id there would reach the log as written`)
    }
  })

  switch (shadow.outcome) {
    case 'patched':
      ctx.logger.debug(`${LOG_PREFIX} guarding ${found.source === 'instance' ? 'the sessionPersistence instance' : 'the sessionPersistence view'} `
        + `in mode "${settings.mode}"`)
      break
    case 'partial':
      ctx.logger.debug(`${LOG_PREFIX} guarding ${found.source === 'instance' ? 'the sessionPersistence instance' : 'the sessionPersistence view'} `
        + `in mode "${settings.mode}"; one of open/create is absent, so it has nothing to guard`)
      break
    case 'no-methods':
      ctx.logger.warn(`${LOG_PREFIX} the sessionPersistence service carries neither open nor create, so nothing is guarded`)
      break
    /* v8 ignore next 4 -- the read-back check makes both write failures one outcome. */
    case 'not-writable':
      ctx.logger.warn(`${LOG_PREFIX} the sessionPersistence service refuses an own "open"/"create" property, so this plugin is `
        + 'NOT in force: a repeated PTC sub-call id will reach the log as written')
      break
    case 'already-patched':
      ctx.logger.debug(`${LOG_PREFIX} the sessionPersistence service is already shadowed by this plugin, leaving it in place`)
      break
  }

  ctx.effect(() => () => {
    active = false
    shadow.restore()
  }, `${LOG_PREFIX}restore()`)
}

export default { name, inject, apply }
