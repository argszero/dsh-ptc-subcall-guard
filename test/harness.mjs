/**
 * Shared fixtures: a stub plugin context, event builders, and a real backend.
 *
 * The witness spec mounts the plugin over a real cordis `Context` and the real
 * JSONL backend, so the fixtures here keep the stub and the real one behind the
 * same shape — a spec that only ever used the stub could not tell a seam that
 * works from one that merely reads back its own write.
 *
 * @module test/harness
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

/** One PTC dispatch start. */
export function start(seq, subCallId, extra = {}) {
  return {
    seq,
    time: seq + 1,
    type: 'tool/ptc-dispatch-start',
    data: { subCallId, rootCallId: 'call-1', parentCallId: 'call-1', name: 'run_code', arguments: {}, ...extra },
  }
}

/** The settle paired with {@link start}. */
export function settle(seq, subCallId, extra = {}) {
  return {
    seq,
    time: seq + 1,
    type: 'tool/ptc-dispatch',
    data: { subCallId, rootCallId: 'call-1', parentCallId: 'call-1', name: 'run_code', arguments: {}, ...extra },
  }
}

/** An event that is neither a start nor a settle. */
export function other(seq, type = 'turn/start') {
  return { seq, time: seq + 1, type, data: type === 'turn/start' ? { turn: 1 } : {} }
}

/**
 * A plugin context that records what the plugin logged and installed.
 *
 * `effect` runs the registration immediately, as cordis does, and returns a
 * disposer — so a spec can drive the real disposal path rather than guess at it.
 * @param options - `service` is what `get('sessionPersistence')` answers.
 * @returns the context, the captured log lines, and disposal.
 */
export function stubContext({ service } = {}) {
  const logs = { warn: [], debug: [] }
  const disposers = []
  const ctx = {
    logger: {
      warn: (message) => logs.warn.push(message),
      debug: (message) => logs.debug.push(message),
    },
    effect: (register, label) => { disposers.push({ label, dispose: register() }) },
    get: (name) => (name === 'sessionPersistence' ? service : undefined),
  }
  return {
    ctx,
    logs,
    disposers,
    /** Run every registered disposer, newest first, as cordis unwinding does. */
    disposeAll: () => { for (const entry of [...disposers].reverse()) entry.dispose() },
  }
}

/** A persistence object whose `open`/`create` are prototype methods, like the shipped one. */
export class FakePersistence {
  /** @param build - called with the call facts; returns the handle. */
  constructor(build) {
    this.build = build
    this.calls = []
  }

  open(id, access, options) {
    this.calls.push({ method: 'open', id, access, options })
    return Promise.resolve(this.build({ method: 'open', id, access }))
  }

  create(header, options) {
    this.calls.push({ method: 'create', id: header?.id, access: 'write', options })
    return Promise.resolve(this.build({ method: 'create', id: header?.id, access: 'write' }))
  }
}

/** A write handle shaped like the shipped one: `append`/`read`/`close` on the prototype. */
export class FakeHandle {
  constructor(events = []) {
    this.stored = [...events]
    /** Every batch `append` was called with, after the guard had its say. */
    this.appended = []
  }

  append(events) {
    this.appended.push(events)
    this.stored.push(...events)
    return Promise.resolve()
  }

  read() {
    return Promise.resolve({ events: this.stored, eventState: 'shared-frozen' })
  }

  close() {
    return Promise.resolve()
  }
}

/**
 * Mount the real JSONL backend on a real cordis context.
 * @returns the context, the scratch root, and a cleanup that stops the context.
 */
export async function realBackend() {
  const root = mkdtempSync(join(tmpdir(), 'ptc-subcall-guard-'))
  const ctx = new Context()
  const { default: jsonl } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  ctx.plugin(jsonl, { root, compression: 'none' })
  // The service mounts on the context's own tick; waiting for it is what makes
  // `ctx.get` answer.
  for (let attempt = 0; attempt < 100 && ctx.get('sessionPersistence') === undefined; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  return { ctx, root, cleanup: async () => { await ctx.stop?.() } }
}

/** A session header the real backend accepts. */
export function headerFor(id, cwd, version) {
  return { version, id, createdAt: 1_800_000_000_000, cwd, isSeeded: false }
}
