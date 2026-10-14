/**
 * Mounting: what the plugin installs, what it refuses, and what it says.
 *
 * A guard that mounts and says nothing is the failure this file is about — every
 * refusal below logs a line naming the consequence, so an operator reading the
 * log can tell "nothing collided" from "nothing was watched".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, describeRepairs, isWriteHandle, sessionIdOf } from '../lib/index.js'
import { ORIGINAL } from '../lib/install.js'
import { FakeHandle, FakePersistence, other, settle, start, stubContext } from './harness.mjs'

/** A service as a cordis `get` hands one over: a view carrying the instance. */
const view = (instance) => ({ [ORIGINAL]: instance })

describe('the state the plugin refuses to mount into', () => {
  it('installs nothing at all when it is disabled, and says so', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, { enabled: false })
    assert.equal(hasOwn(persistence, 'open'), false)
    assert.equal(hasOwn(persistence, 'create'), false)
    assert.equal(logs.warn.length, 0)
    assert.match(logs.debug[0], /disabled by configuration/)
  })

  it('warns when the service is not mounted, rather than mounting silently', () => {
    const { ctx, logs } = stubContext({ service: undefined })
    apply(ctx, {})
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /sessionPersistence service is not mounted/)
    assert.match(logs.warn[0], /as written/)
  })

  it('warns when the service carries neither entry point', () => {
    const { ctx, logs } = stubContext({ service: view({}) })
    apply(ctx, {})
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /neither open nor create/)
  })

  it('warns when the service refuses an own property, because then it is not in force', () => {
    const frozen = Object.freeze({ open() {}, create() {} })
    const { ctx, logs } = stubContext({ service: view(frozen) })
    apply(ctx, {})
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /refuses an own "open"\/"create" property/)
    assert.match(logs.warn[0], /NOT in force/)
  })

  it('refuses a configuration it cannot honour rather than mounting', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx } = stubContext({ service: view(persistence) })
    assert.throws(() => apply(ctx, { mode: 'rewrite' }), /"mode" must be one of/)
    assert.equal(hasOwn(persistence, 'open'), false)
  })
})

describe('the state the plugin mounts into', () => {
  it('shadows both entry points and reports the mode it guards in', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, { mode: 'observe' })
    assert.equal(hasOwn(persistence, 'open'), true)
    assert.equal(hasOwn(persistence, 'create'), true)
    assert.match(logs.debug[0], /guarding the sessionPersistence instance in mode "observe"/)
  })

  it('says which one is missing when the service carries only one entry point', () => {
    const { ctx, logs } = stubContext({ service: view({ open() {} }) })
    apply(ctx, {})
    assert.match(logs.debug[0], /one of open\/create is absent/)
  })

  it('leaves an existing shadow of its own in place', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, {})
    apply(ctx, {})
    assert.match(logs.debug[1], /already shadowed by this plugin/)
  })
})

describe('what the mounted guard does to a handle', () => {
  it('rewrites a colliding batch appended through a created session, and logs it once', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, {})
    const handle = await persistence.create({ id: 's1' })
    await handle.append([other(0), start(1, 'call-1:ptc:1'), start(2, 'call-1:ptc:1')])
    assert.equal(handle.appended[0][2].data.subCallId, 'call-1:ptc:1::r1')
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /session s1: a PTC sub-call id repeated in this log/)
    assert.match(logs.warn[0], /call-1:ptc:1 -> call-1:ptc:1::r1/)
    assert.match(logs.warn[0], /rejects the whole log on the next read/)
  })

  it('rewrites a colliding batch appended through a resumed session too', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx } = stubContext({ service: view(persistence) })
    apply(ctx, {})
    const handle = await persistence.open('s9', 'write')
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x::r1')
  })

  it('leaves a read handle alone, because a read handle can never carry the append', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, {})
    const handle = await persistence.open('s1', 'read')
    assert.equal(hasOwn(handle, 'append'), false)
    assert.equal(logs.warn.length, 0)
  })

  it('reports a handle it could not guard', async () => {
    const persistence = new FakePersistence(() => ({}))
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, {})
    await persistence.open('s2', 'write')
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /the open handle for session s2 could not be guarded \(no-append\)/)
  })

  it('names a session it could not identify rather than keying on nothing', () => {
    assert.equal(sessionIdOf({ method: 'open', id: value(undefined), access: 'write' }), '<unidentified session>')
    assert.equal(sessionIdOf({ method: 'open', id: '', access: 'write' }), '<unidentified session>')
    assert.equal(sessionIdOf({ method: 'open', id: 's1', access: 'write' }), 's1')
  })

  it('treats create as a write handle and an open as a write handle only when it asked for one', () => {
    assert.equal(isWriteHandle({ method: 'create', id: 's', access: undefined }), true)
    assert.equal(isWriteHandle({ method: 'open', id: 's', access: 'write' }), true)
    assert.equal(isWriteHandle({ method: 'open', id: 's', access: 'read' }), false)
    assert.equal(isWriteHandle({ method: 'open', id: 's', access: undefined }), false)
  })

  it('bounds how many collisions it repeats into the log for one session', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, { maxReportedRepairs: 1 })
    const handle = await persistence.create({ id: 's1' })
    await handle.append([start(0, 'x'), start(1, 'x'), start(2, 'x')])
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /1 further repeat\(s\) in this session not reported/)
  })

  it('reports nothing more once the budget is spent, rather than a line with no repair in it', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const { ctx, logs } = stubContext({ service: view(persistence) })
    apply(ctx, { maxReportedRepairs: 1 })
    const handle = await persistence.create({ id: 's1' })
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(logs.warn.length, 1)
    // A second batch brings a collision this session has not spent against
    // nothing yet — but the budget is gone, so it is counted, not repeated.
    await handle.append([start(2, 'y'), start(3, 'y')])
    assert.equal(logs.warn.length, 1)
    assert.equal(handle.appended[1][1].data.subCallId, 'y::r1')
  })

  it('drops the rewrite when the plugin is unloaded, so an unloaded guard guards nothing', async () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const harness = stubContext({ service: view(persistence) })
    apply(harness.ctx, {})
    const handle = await persistence.create({ id: 's1' })
    harness.disposeAll()
    await handle.append([start(0, 'x'), start(1, 'x')])
    assert.equal(handle.appended[0][1].data.subCallId, 'x')
    assert.equal(hasOwn(persistence, 'open'), false)
    assert.equal(hasOwn(persistence, 'create'), false)
  })

  it('registers its disposal under a label an operator can find', () => {
    const persistence = new FakePersistence(() => new FakeHandle())
    const harness = stubContext({ service: view(persistence) })
    apply(harness.ctx, {})
    assert.deepEqual(harness.disposers.map((entry) => entry.label), ['ptc-subcall-guard:restore()'])
  })
})

describe('rendering one collision', () => {
  it('says what it did with the batch, in each mode', () => {
    const repairs = [{ original: 'x', replacement: 'x::r1', settleCarried: true }]
    assert.match(describeRepairs('s1', repairs, 0, 'repair'), /rewrote it, and carried the paired settle/)
    assert.match(describeRepairs('s1', repairs, 0, 'observe'), /appended it unchanged \(mode "observe"\)/)
    assert.doesNotMatch(describeRepairs('s1', repairs, 0, 'repair'), /not reported/)
    assert.match(describeRepairs('s1', repairs, 2, 'repair'), /2 further repeat\(s\)/)
  })
})

/** A value that is not a string, without tripping the linter's preference for one. */
function value(input) {
  return input
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}
