/**
 * The instance seam: shadow the persistence service's two write entry points.
 *
 * There is no event on the append path and no hook in the PTC dispatcher: the
 * sub-call id is minted inside `ToolRegistry`'s `run_code` binding
 * (`packages/core/tools/src/ptc.ts`) and the append goes straight to the
 * session, which hands the batch to persistence. What the plugin does have is
 * the service instance itself.
 *
 * `ctx.get('sessionPersistence')` returns a tracking proxy; the proxy answers
 * `Symbol.for('cordis.original')` with the underlying object
 * (`vendor/cordis/src/utils.ts`), and `SessionPersistence.open` / `.create` are
 * **prototype** methods (`packages/session/session-persistence/src/index.ts`),
 * so one own-property write on that object shadows them for every caller — the
 * agent loop's own `persistence.open(id, 'write', …)`
 * (`packages/core/agent-loop/src/index.ts:840`) and `persistence.create(…)`
 * (`:682`), both call-time property lookups on a `ctx.get` result.
 *
 * Both are shadowed because both produce write handles: `create` opens a fresh
 * session's log, `open` resumes one. A guard on only one of them would leave
 * the reported shape — a re-issued call inside a resumed session — uncovered.
 *
 * @module @argszero/dsh-ptc-subcall-guard/install
 */

import { SubCallLedger, type RepairRecord } from './repair.ts'

/** The cordis symbol that exposes a service view's underlying instance. */
export const ORIGINAL = Symbol.for('cordis.original')

/** Marks carrying this plugin's identity, so a second mount recognises the first. */
export const OPEN_MARK = Symbol.for('argszero.dsh-ptc-subcall-guard/open-shadowed')
export const CREATE_MARK = Symbol.for('argszero.dsh-ptc-subcall-guard/create-shadowed')
export const APPEND_MARK = Symbol.for('argszero.dsh-ptc-subcall-guard/append-guarded')
export const APPEND_ACTIVE = Symbol.for('argszero.dsh-ptc-subcall-guard/append-active')

/** The liveness flags, one per shadowed entry point. */
export const OPEN_ACTIVE = Symbol.for('argszero.dsh-ptc-subcall-guard/open-active')
export const CREATE_ACTIVE = Symbol.for('argszero.dsh-ptc-subcall-guard/create-active')

/** The narrowest shape the shadow needs from a caller's context. */
export interface ContextLike {
  /** The service lookup every cordis context offers. */
  get?: (name: string) => unknown
  /** The property-read spelling of the same lookup. */
  sessionPersistence?: unknown
}

/** Which object the shadow was written to. */
export type PersistenceInstanceSource = 'instance' | 'view' | 'none'

/** Where the persistence service was found, and what was found. */
export interface PersistenceInstance {
  /** The object to write the shadows on; absent when the service is not mounted. */
  readonly target: object | undefined
  /** `instance` is the underlying object, `view` a tracking proxy, `none` nothing at all. */
  readonly source: PersistenceInstanceSource
}

/**
 * Resolve the object the shadows must be written to.
 *
 * The underlying instance is preferred: cordis returns a fresh tracking proxy
 * from every `get`, and a proxy is not a stable place to hang state. The proxy
 * is used as a fallback so a service that does not carry the symbol still gets
 * a working — if narrower — shadow.
 * @param ctx - the plugin context.
 * @returns the target and where it came from.
 */
export function resolvePersistenceInstance(ctx: ContextLike): PersistenceInstance {
  const view = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : ctx.sessionPersistence
  if (view === null || typeof view !== 'object') return { target: undefined, source: 'none' }
  const original = (view as Record<symbol, unknown>)[ORIGINAL]
  if (original !== null && typeof original === 'object') {
    return { target: original as object, source: 'instance' }
  }
  return { target: view as object, source: 'view' }
}

/** How one shadowed entry point was called. */
export interface PersistenceCall {
  /** Which entry point produced the handle. */
  readonly method: 'open' | 'create'
  /** The session the handle addresses: `open`'s first argument, or `create`'s header id. */
  readonly id: unknown
  /** `open` only: the access it was opened with. `create` always yields a write handle. */
  readonly access: unknown
}

/** What {@link shadowPersistence} did. */
export type ShadowOutcome =
  /** Both entry points are shadowed and confirmed by a read-back. */
  | 'patched'
  /** One entry point is shadowed; the other is missing from the object. */
  | 'partial'
  /** The object carries neither entry point. */
  | 'no-methods'
  /** A write threw, or a read-back shows it did not take. */
  | 'not-writable'
  /** This object already carries live shadows installed by this plugin. */
  | 'already-patched'

/** An installed shadow and how to unwind it. */
export interface ShadowHandle {
  /** What happened. */
  readonly outcome: ShadowOutcome
  /** Unwind the shadows. Idempotent, and a no-op unless this handle installed them. */
  readonly restore: () => void
}

const NOOP_RESTORE = (): void => { /* nothing was installed, so there is nothing to unwind. */ }

function isLive(value: unknown, mark: symbol): boolean {
  if (typeof value !== 'function') return false
  return (value as unknown as Record<symbol, unknown>)[mark] === true
}

function adoptPromise(result: unknown, onResolved: (value: unknown) => void): unknown {
  if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
    return (result as PromiseLike<unknown>).then((value) => {
      onResolved(value)
      return value
    })
  }
  // The abstract contract returns a promise; a backend that does not still gets
  // its handle observed rather than silently unguarded.
  onResolved(result)
  return result
}

/**
 * Shadow `open` and `create` on one persistence object.
 *
 * The callback runs after the original settled and its failure is swallowed: an
 * observation that could not be made is a guard that is not in force, never a
 * session that fails to open. The wrapper's return value is the original's own
 * handle once it resolves, so the caller's handle is the caller's own object.
 * @param target - the object carrying `open` / `create` (the service instance, or its view).
 * @param onHandle - called with the call facts and the handle it produced.
 * @returns the outcome and an undo that also deactivates every installed wrapper.
 */
export function shadowPersistence(
  target: object,
  onHandle: (call: PersistenceCall, handle: unknown) => void,
): ShadowHandle {
  const mutable = target as Record<string, unknown>
  const hasOpen = typeof mutable['open'] === 'function'
  const hasCreate = typeof mutable['create'] === 'function'

  if (!hasOpen && !hasCreate) return { outcome: 'no-methods', restore: NOOP_RESTORE }
  const open = mutable['open']
  const create = mutable['create']
  if (hasOpen && isLive(open, OPEN_MARK) && liveActive(open, OPEN_ACTIVE)) {
    return { outcome: 'already-patched', restore: NOOP_RESTORE }
  }
  if (hasCreate && isLive(create, CREATE_MARK) && liveActive(create, CREATE_ACTIVE)) {
    return { outcome: 'already-patched', restore: NOOP_RESTORE }
  }

  let active = true
  const installed: Array<{
    key: 'open' | 'create'
    wrapper: (...args: unknown[]) => unknown
    original: (...args: unknown[]) => unknown
    hadOwn: boolean
  }> = []

  const build = (
    key: 'open' | 'create',
    mark: symbol,
    activeKey: symbol,
    callOf: (args: unknown[]) => PersistenceCall,
  ): void => {
    const original = mutable[key] as (...args: unknown[]) => unknown
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key)
    const wrapper = function guardedEntry(this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(original, this === undefined ? target : this, args)
      if (!active) return result
      const call = callOf(args)
      return adoptPromise(result, (handle) => {
        try {
          onHandle(call, handle)
        } catch {
          // The observation is auxiliary; the session it observed is not.
        }
      })
    }
    Object.defineProperty(wrapper, mark, { value: true, enumerable: false })
    // Liveness is read at check time, so a wrapper left behind by an unloaded
    // mount is not mistaken for a guard that is in force.
    Object.defineProperty(wrapper, activeKey, {
      get: () => active,
      enumerable: false,
    })
    installed.push({ key, wrapper, original, hadOwn })
  }

  if (hasOpen) {
    build('open', OPEN_MARK, OPEN_ACTIVE, (args) => ({ method: 'open', id: args[0], access: args[1] }))
  }
  if (hasCreate) {
    build('create', CREATE_MARK, CREATE_ACTIVE, (args) => {
      const header = args[0]
      const id = header !== null && typeof header === 'object'
        ? (header as Record<string, unknown>)['id']
        : undefined
      return { method: 'create', id, access: 'write' }
    })
  }

  const done: typeof installed = []
  for (const shadow of installed) {
    let written = false
    try {
      mutable[shadow.key] = shadow.wrapper
      // A write that reports success and stores nothing: a proxy's `set` trap
      // can answer `true` and keep the old value, so only a read-back notices.
      written = mutable[shadow.key] === shadow.wrapper
    } catch {
      written = false
    }
    if (!written) {
      for (const back of done) {
        if (mutable[back.key] !== back.wrapper) continue
        if (back.hadOwn) mutable[back.key] = back.original
        else delete mutable[back.key]
      }
      return { outcome: 'not-writable', restore: NOOP_RESTORE }
    }
    done.push(shadow)
  }

  return {
    outcome: installed.length === 2 ? 'patched' : 'partial',
    restore: () => {
      if (!active) return
      active = false
      for (const shadow of installed) {
        if (mutable[shadow.key] !== shadow.wrapper) continue
        if (shadow.hadOwn) mutable[shadow.key] = shadow.original
        else delete mutable[shadow.key]
      }
    },
  }
}

/**
 * Whether a guarded entry point is still rewriting.
 * @param value - the property currently installed under the key.
 * @param activeKey - that entry point's liveness flag.
 * @returns true when the installed wrapper belongs to a mounted plugin.
 */
function liveActive(value: unknown, activeKey: symbol): boolean {
  const flag = (value as unknown as Record<symbol, unknown>)[activeKey]
  return flag === true
}

/** Hooks the handle wrapper reports through. */
export interface HandleHooks {
  /** Called once per batch that carried at least one collision. */
  readonly onRepair?: (records: readonly RepairRecord[], sessionId: string) => void
  /** Called when a handle could not be wrapped. */
  readonly onUnwrappable?: (reason: WrapOutcome, sessionId: string) => void
}

/** What {@link wrapWriteHandle} did. */
export type WrapOutcome =
  /** Both `append` and `read` are wrapped and confirmed by a read-back. */
  | 'wrapped'
  /** `append` is wrapped; the handle offers no `read`, so no prefix is learned from it. */
  | 'wrapped-append-only'
  /** Not an object, or it carries no `append` function. */
  | 'no-append'
  /** A write threw, or a read-back shows it did not take. */
  | 'not-writable'
  /** This handle already carries a live wrapper installed by this plugin. */
  | 'already-wrapped'

/**
 * Wrap one write handle so the batch it appends cannot carry a repeated id.
 *
 * `append` is rewritten before the original sees it; `read` is observed only,
 * to learn the prefix the resume path loads. Both are own-property writes on the
 * handle, which is a per-run object rather than a shared service, so the shadow
 * is exactly as long-lived as the handle.
 * @param handle - the handle the backend returned.
 * @param sessionId - the session it addresses, for reporting.
 * @param ledger - that session's ledger.
 * @param mode - `repair` rewrites the batch, `observe` reports and passes it through.
 * @param isActive - whether the plugin is still mounted; an unwound shadow stops rewriting.
 * @param hooks - reporting.
 * @returns what was installed.
 */
export function wrapWriteHandle(
  handle: unknown,
  sessionId: string,
  ledger: SubCallLedger,
  mode: 'repair' | 'observe',
  isActive: () => boolean,
  hooks: HandleHooks = {},
): WrapOutcome {
  if (handle === null || typeof handle !== 'object') return 'no-append'
  const mutable = handle as Record<string, unknown>
  const currentAppend = mutable['append']
  if (typeof currentAppend !== 'function') return 'no-append'
  if (isLive(currentAppend, APPEND_MARK) && liveActive(currentAppend, APPEND_ACTIVE)) return 'already-wrapped'

  const originalAppend = currentAppend as (...args: unknown[]) => unknown
  const originalRead = mutable['read']

  const prime = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    const events = (value as { events?: unknown }).events
    if (Array.isArray(events)) ledger.prime(events as Record<string, unknown>[])
  }

  const appendWrapper = function guardedAppend(this: unknown, ...args: unknown[]): unknown {
    const batch = args[0]
    if (isActive() && Array.isArray(batch)) {
      const outcome = ledger.repair(batch as Record<string, unknown>[])
      // The rewrite is applied whenever the batch came back different, which is
      // not the same as "this batch found a new collision": a settle carried for
      // a dispatch an *earlier* batch renamed has no record of its own, and
      // dropping it there would leave the log holding a settle for the original
      // id beside a start that no longer carries it.
      if (mode === 'repair') args = [outcome.events, ...args.slice(1)]
      if (outcome.repairs.length > 0) {
        try {
          hooks.onRepair?.(outcome.repairs, sessionId)
        } catch {
          // Reporting is auxiliary; the append it reported on is not.
        }
      }
    }
    return Reflect.apply(originalAppend, this === undefined ? handle : this, args)
  }
  Object.defineProperty(appendWrapper, APPEND_MARK, { value: true, enumerable: false })
  Object.defineProperty(appendWrapper, APPEND_ACTIVE, {
    get: () => isActive(),
    enumerable: false,
  })

  const wanted: Array<{
    key: 'append' | 'read'
    wrapper: (...args: unknown[]) => unknown
    original: (...args: unknown[]) => unknown
    hadOwn: boolean
  }> = [{
    key: 'append',
    wrapper: appendWrapper,
    original: originalAppend,
    hadOwn: Object.prototype.hasOwnProperty.call(handle, 'append'),
  }]

  if (typeof originalRead === 'function') {
    const read = originalRead as (...args: unknown[]) => unknown
    const readWrapper = function guardedRead(this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(read, this === undefined ? handle : this, args)
      if (!isActive()) return result
      return adoptPromise(result, (value) => {
        try {
          prime(value)
        } catch {
          // The observation is auxiliary; the read it observed is not.
        }
      })
    }
    wanted.push({
      key: 'read',
      wrapper: readWrapper,
      original: read,
      hadOwn: Object.prototype.hasOwnProperty.call(handle, 'read'),
    })
  }

  const done: typeof wanted = []
  for (const entry of wanted) {
    let written = false
    try {
      mutable[entry.key] = entry.wrapper
      written = mutable[entry.key] === entry.wrapper
    } catch {
      written = false
    }
    if (!written) {
      // Unwind what this call installed, then report: a half-wrapped handle
      // would rewrite appends under a guard the caller believes absent. Each
      // entry carries the ownership it saw, so the unwind restores the right
      // shape per key rather than one entry's shape for all of them.
      for (const back of done) {
        if (mutable[back.key] !== back.wrapper) continue
        if (back.hadOwn) mutable[back.key] = back.original
        else delete mutable[back.key]
      }
      return 'not-writable'
    }
    done.push(entry)
  }

  return typeof originalRead === 'function' ? 'wrapped' : 'wrapped-append-only'
}
