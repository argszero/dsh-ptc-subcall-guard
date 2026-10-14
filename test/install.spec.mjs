/**
 * The seam: where the shadow lands, when it refuses, and what it unwinds.
 *
 * The two facts under test are the ones the whole plugin rests on — the write is
 * an own property on the **instance**, so every view sees it, and it is removed
 * again rather than frozen in place, so an unloaded plugin leaves the prototype
 * method behind exactly as it found it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APPEND_ACTIVE, APPEND_MARK, CREATE_MARK, OPEN_ACTIVE, OPEN_MARK, ORIGINAL,
  resolvePersistenceInstance, shadowPersistence, wrapWriteHandle,
} from '../lib/install.js'
import { SubCallLedger } from '../lib/repair.js'
import { FakeHandle, FakePersistence, other, settle, start } from './harness.mjs'

/** A service view as cordis builds one: the instance is reachable through the symbol. */
function viewOf(instance) {
  return { [ORIGINAL]: instance }
}

describe('finding the object to shadow', () => {
  it('prefers the underlying instance behind a view, because a view is made fresh per get', () => {
    const instance = { open() {}, create() {} }
    const found = resolvePersistenceInstance({ get: () => viewOf(instance) })
    assert.equal(found.source, 'instance')
    assert.equal(found.target, instance)
  })

  it('falls back to the view when it does not carry the symbol', () => {
    const view = { open() {}, create() {} }
    const found = resolvePersistenceInstance({ get: () => view })
    assert.equal(found.source, 'view')
    assert.equal(found.target, view)
  })

  it('finds nothing for a service that is not mounted', () => {
    for (const service of [undefined, null, 'x', 7]) {
      const found = resolvePersistenceInstance({ get: () => service })
      assert.equal(found.source, 'none')
      assert.equal(found.target, undefined)
    }
  })

  it('reads the property spelling when the context offers no get', () => {
    const instance = { open() {}, create() {} }
    const found = resolvePersistenceInstance({ sessionPersistence: viewOf(instance) })
    assert.equal(found.source, 'instance')
    assert.equal(found.target, instance)
  })
})

describe('shadowing the two entry points', () => {
  it('writes own properties on the instance and unwinds them back to the prototype', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const seen = []
    const shadow = shadowPersistence(persistence, (call) => seen.push(call.method))
    assert.equal(shadow.outcome, 'patched')
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'open'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'create'), true)
    assert.equal(Object.getOwnPropertyDescriptor(persistence, 'open')[OPEN_MARK], undefined)
    assert.equal(typeof persistence.open, 'function')
    assert.equal(OPEN_MARK in persistence.open, true)
    assert.equal(CREATE_MARK in persistence.create, true)

    shadow.restore()
    // A prototype method must be revealed by deleting the shadow, not frozen as
    // an own property forever.
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'open'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'create'), false)
    assert.equal(FakePersistence.prototype.open, persistence.open)
    assert.equal(FakePersistence.prototype.create, persistence.create)
  })

  it('reports a partial shadow when only one entry point is present', () => {
    const original = () => Promise.resolve(undefined)
    const target = { open: original }
    const shadow = shadowPersistence(target, () => {})
    assert.equal(shadow.outcome, 'partial')
    assert.notEqual(target.open, original)
    shadow.restore()
    assert.equal(target.open, original)
  })

  it('refuses a target that carries neither entry point', () => {
    const shadow = shadowPersistence({}, () => {})
    assert.equal(shadow.outcome, 'no-methods')
    shadow.restore()
  })

  it('reports not-writable when the write reports success and stores nothing', () => {
    // A proxy's `set` trap can answer `true` and keep the old value, so the
    // read-back — not the `try` — is what notices.
    const persistence = new FakePersistence(() => new FakeHandle())
    const lying = new Proxy(persistence, {
      set: (target, key, value) => {
        if (key === 'open') return true
        return Reflect.set(target, key, value)
      },
    })
    const shadow = shadowPersistence(lying, () => {})
    assert.equal(shadow.outcome, 'not-writable')
    // And the entry point that did land was taken back out.
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'create'), false)
    assert.equal(FakePersistence.prototype.create, persistence.create)
  })

  it('recognises a live shadow of its own and leaves it in place', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const first = shadowPersistence(persistence, () => {})
    const second = shadowPersistence(persistence, () => {})
    assert.equal(first.outcome, 'patched')
    assert.equal(second.outcome, 'already-patched')
    second.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(persistence, 'open'), true)
  })

  it('allows a fresh shadow after the first was unwound, because a stale mark is not a guard', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const calls = []
    const first = shadowPersistence(persistence, () => calls.push('first'))
    first.restore()
    const second = shadowPersistence(persistence, () => calls.push('second'))
    assert.equal(second.outcome, 'patched')
    second.restore()
  })

  it('stops observing once unwound, even for a wrapper a caller held on to', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const calls = []
    const shadow = shadowPersistence(persistence, (call) => calls.push(call))
    const held = persistence.open
    shadow.restore()
    await held.call(persistence, 's1', 'write')
    assert.deepEqual(calls, [])
  })

  it('reports the call facts a session is keyed by', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const calls = []
    shadowPersistence(persistence, (call) => calls.push(call))
    await persistence.open('s1', 'write')
    await persistence.create({ id: 's2' })
    assert.deepEqual(calls, [
      { method: 'open', id: 's1', access: 'write' },
      { method: 'create', id: 's2', access: 'write' },
    ])
  })

  it('observes a backend whose methods answer synchronously too', () => {
    const calls = []
    const handle = new FakeHandle()
    const synchronous = { open: () => handle }
    shadowPersistence(synchronous, (call) => calls.push(call))
    synchronous.open('s1', 'write')
    assert.deepEqual(calls, [{ method: 'open', id: 's1', access: 'write' }])
  })

  it('never lets an observer failure become the caller\'s failure', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    shadowPersistence(persistence, () => { throw new Error('observer is broken') })
    const handle = await persistence.open('s1', 'write')
    assert.ok(handle instanceof FakeHandle)
  })
})

describe('guarding one write handle', () => {
  const active = () => true

  it('rewrites the batch before the handle sees it', async () => {
    const handle = new FakeHandle()
    const seen = []
    const outcome = wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active, {
      onRepair: (records, id) => seen.push({ records, id }),
    })
    assert.equal(outcome, 'wrapped')
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x::r1')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 's1')
    assert.equal(seen[0].records[0].replacement, 'x::r1')
  })

  it('passes the batch through unchanged in observe mode, which is the point of having it', async () => {
    const handle = new FakeHandle()
    const seen = []
    wrapWriteHandle(handle, 's1', new SubCallLedger(), 'observe', active, { onRepair: (r) => seen.push(r) })
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x')
    assert.equal(seen.length, 1)
  })

  it('leaves a handle with no append alone and says so', () => {
    assert.equal(wrapWriteHandle({}, 's1', new SubCallLedger(), 'repair', active), 'no-append')
    assert.equal(wrapWriteHandle(null, 's1', new SubCallLedger(), 'repair', active), 'no-append')
    assert.equal(wrapWriteHandle({ append: 7 }, 's1', new SubCallLedger(), 'repair', active), 'no-append')
  })

  it('reports an append-only handle as such, because no prefix is learned from it', () => {
    const handle = { append: () => Promise.resolve() }
    assert.equal(wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active), 'wrapped-append-only')
  })

  it('unwinds what it wrote and reports not-writable when `read` refuses the write', async () => {
    const handle = new FakeHandle()
    Object.defineProperty(handle, 'read', { value: FakeHandle.prototype.read, writable: false, configurable: true })
    const outcome = wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active)
    assert.equal(outcome, 'not-writable')
    // The half-wrapped handle would rewrite appends under a guard the caller
    // believes absent — and the original `append` was a prototype method, so the
    // unwind must delete rather than assign.
    assert.equal(Object.prototype.hasOwnProperty.call(handle, 'append'), false)
    assert.equal(FakeHandle.prototype.append, handle.append)
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x')
  })

  it('recognises a live wrapper of its own and leaves it in place', () => {
    const handle = new FakeHandle()
    const ledger = new SubCallLedger()
    assert.equal(wrapWriteHandle(handle, 's1', ledger, 'repair', active), 'wrapped')
    assert.equal(APPEND_MARK in handle.append, true)
    assert.equal(wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active), 'already-wrapped')
  })

  it('stops rewriting once the plugin is unwound', async () => {
    const handle = new FakeHandle()
    let mounted = true
    wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', () => mounted)
    assert.equal(APPEND_ACTIVE in handle.append, true)
    mounted = false
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x')
  })

  it('does not mistake a stale wrapper from an unwound mount for a guard in force', async () => {
    const handle = new FakeHandle()
    let firstMounted = true
    wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', () => firstMounted)
    firstMounted = false
    // The wrapper is still on the handle, but the mount that installed it is
    // gone, so it rewrites nothing and is not a guard. A second mount must wrap
    // it rather than recognise it, or the handle stays unguarded for good.
    assert.equal(wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', () => true), 'wrapped')
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x::r1')
  })

  it('primes the used-id set from a read, so a resumed session renames against its whole log', async () => {
    const handle = new FakeHandle([other(0), start(1, 'p:ptc:1')])
    const ledger = new SubCallLedger()
    wrapWriteHandle(handle, 's1', ledger, 'repair', active)
    await handle.read()
    await handle.append([start(2, 'p:ptc:1')])
    assert.equal(handle.appended[0][0].data.subCallId, 'p:ptc:1::r1')
  })

  it('ignores a read that answers something other than a log', async () => {
    const handle = new FakeHandle()
    handle.read = () => Promise.resolve({ events: 'not an array' })
    const ledger = new SubCallLedger()
    wrapWriteHandle(handle, 's1', ledger, 'repair', active)
    await handle.read()
    assert.equal(ledger.repairCount, 0)
  })

  it('never lets a reporting failure become the append\'s failure', async () => {
    const handle = new FakeHandle()
    wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active, {
      onRepair: () => { throw new Error('reporting is broken') },
    })
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x::r1')
  })

  it('rewrites a settle that arrives later, on a batch of its own', async () => {
    const handle = new FakeHandle()
    wrapWriteHandle(handle, 's1', new SubCallLedger(), 'repair', active)
    await handle.append([start(0, 'x'), start(1, 'x'), settle(2, 'x')])
    await handle.append([settle(3, 'x')])
    assert.equal(handle.appended[1][0].data.subCallId, 'x::r1')
  })
})
