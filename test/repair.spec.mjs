/**
 * The ledger: what it renames, what it leaves alone, and the pairing it keeps.
 *
 * Every case here is one of the promises the module doc and the README make, and
 * the injection harness removes each of them in turn to check that this file is
 * what makes the promise true.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REPAIR_INFIX, SubCallLedger, dispatchRole, subCallIdOf } from '../lib/repair.js'
import { other, settle, start } from './harness.mjs'

describe('reading one event', () => {
  it('tells a start from a settle and nothing else', () => {
    assert.equal(dispatchRole('tool/ptc-dispatch-start'), 'start')
    assert.equal(dispatchRole('tool/ptc-dispatch'), 'settle')
    for (const type of ['turn/start', 'tool/call', undefined, 7, null]) {
      assert.equal(dispatchRole(type), undefined)
    }
  })

  it('reads a subCallId only from a data record that carries a string', () => {
    assert.equal(subCallIdOf({ data: { subCallId: 'x' } }), 'x')
    for (const event of [{}, { data: null }, { data: 'x' }, { data: { subCallId: 7 } }, { data: {} }]) {
      assert.equal(subCallIdOf(event), undefined)
    }
  })
})

describe('a batch with no repeat', () => {
  it('returns the caller\'s own array, so an ordinary append costs no copy', () => {
    const events = [other(0), start(1, 'a'), settle(2, 'a')]
    const outcome = new SubCallLedger().repair(events)
    assert.equal(outcome.events, events)
    assert.deepEqual(outcome.repairs, [])
    assert.equal(outcome.rewritten, 0)
  })

  it('leaves a settle with no start alone', () => {
    const events = [settle(0, 'never-started')]
    const outcome = new SubCallLedger().repair(events)
    assert.equal(outcome.events, events)
    assert.equal(outcome.rewritten, 0)
  })
})

describe('a batch that repeats an id', () => {
  it('renames the second start and reports the collision', () => {
    const ledger = new SubCallLedger()
    const events = [other(0), start(1, 'call-1:ptc:1'), settle(2, 'call-1:ptc:1'), start(3, 'call-1:ptc:1')]
    const outcome = ledger.repair(events)
    assert.notEqual(outcome.events, events)
    assert.equal(outcome.events[3].data.subCallId, `call-1:ptc:1${REPAIR_INFIX}1`)
    assert.deepEqual(outcome.repairs, [{
      original: 'call-1:ptc:1',
      replacement: `call-1:ptc:1${REPAIR_INFIX}1`,
      settleCarried: false,
    }])
    assert.equal(outcome.rewritten, 1)
    assert.equal(ledger.repairCount, 1)
  })

  it('does not mutate the caller\'s events or the data objects it read', () => {
    const first = start(1, 'x')
    const second = start(2, 'x')
    const events = [first, second]
    const outcome = new SubCallLedger().repair(events)
    assert.equal(first.data.subCallId, 'x')
    assert.equal(second.data.subCallId, 'x')
    assert.equal(outcome.events[1].data.subCallId, `x${REPAIR_INFIX}1`)
    // A copy of the event, and a copy of its `data`: the session holds the
    // originals and the same objects reach the in-memory log.
    assert.notEqual(outcome.events[1], second)
    assert.notEqual(outcome.events[1].data, second.data)
  })

  it('keeps rootCallId and parentCallId, so a nested dispatch still resolves its parent', () => {
    const ledger = new SubCallLedger()
    const events = [start(0, 'root'), start(1, 'root'), settle(2, 'root')]
    const outcome = ledger.repair(events)
    for (const event of outcome.events) {
      assert.equal(event.data.rootCallId, 'call-1')
      assert.equal(event.data.parentCallId, 'call-1')
    }
  })

  it('renames past the first replacement when a third start repeats as well', () => {
    const ledger = new SubCallLedger()
    const outcome = ledger.repair([start(0, 'x'), start(1, 'x'), start(2, 'x')])
    assert.deepEqual(outcome.events.map((event) => event.data.subCallId), ['x', `x${REPAIR_INFIX}1`, `x${REPAIR_INFIX}2`])
  })

  it('stays in its own namespace, so a rename can never collide with a minted id', () => {
    const ledger = new SubCallLedger()
    // An id the producer would have minted, sitting exactly where a rename of
    // `x` would land: the guard must skip past it.
    const outcome = ledger.repair([start(0, 'x'), start(1, `x${REPAIR_INFIX}1`), start(2, 'x')])
    assert.equal(outcome.events[2].data.subCallId, `x${REPAIR_INFIX}2`)
  })
})

describe('a repeat carried across batches', () => {
  it('sees an id the stored prefix already started', () => {
    const ledger = new SubCallLedger()
    ledger.prime([other(0), start(1, 'p:ptc:1')])
    const outcome = ledger.repair([start(2, 'p:ptc:1')])
    assert.equal(outcome.events[0].data.subCallId, `p:ptc:1${REPAIR_INFIX}1`)
    assert.equal(outcome.repairs.length, 1)
  })

  it('ignores a settle-only id in the prefix, because the reader\'s map is only written on a start', () => {
    const ledger = new SubCallLedger()
    ledger.prime([settle(0, 'only-a-settle')])
    const events = [start(1, 'only-a-settle')]
    const outcome = ledger.repair(events)
    assert.equal(outcome.events, events)
    assert.equal(outcome.rewritten, 0)
  })

  it('skips junk in the prefix rather than throwing on it', () => {
    const ledger = new SubCallLedger()
    ledger.prime([null, 'x', { type: 'tool/ptc-dispatch-start' }])
    assert.equal(ledger.repair([start(0, 'a')]).rewritten, 0)
  })
})

describe('carrying the settle of a renamed dispatch', () => {
  it('rewrites the settle that belongs to the renamed start', () => {
    const ledger = new SubCallLedger()
    // The first start keeps its id; the second is renamed. The producer knows
    // nothing of the rename, so both settles arrive under the original id and
    // are handed out in start order.
    const first = ledger.repair([start(0, 'x')])
    const second = ledger.repair([start(1, 'x'), settle(2, 'x')])
    assert.equal(first.rewritten, 0)
    assert.equal(second.events[1].data.subCallId, 'x')
    const third = ledger.repair([settle(3, 'x')])
    assert.equal(third.events[0].data.subCallId, `x${REPAIR_INFIX}1`)
    assert.equal(ledger.repairs[0].settleCarried, true)
  })

  it('leaves the paired settle unrenamed until it actually arrives', () => {
    const ledger = new SubCallLedger()
    ledger.repair([start(0, 'x'), start(1, 'x')])
    assert.equal(ledger.repairs[0].settleCarried, false)
    ledger.repair([settle(2, 'x'), settle(3, 'x')])
    assert.equal(ledger.repairs[0].settleCarried, true)
  })

  it('heals a nested dispatch whose id repeats with its parent', () => {
    const ledger = new SubCallLedger()
    // The parent repeats, and the nested id derives from the parent's original
    // spelling — so the nested id is one the ledger has already seen and is
    // renamed in turn, with no special case for nesting.
    const outcome = ledger.repair([
      start(0, 'p'),
      start(1, 'p:ptc:1', { parentCallId: 'p' }),
      start(2, 'p'),
      start(3, 'p:ptc:1', { parentCallId: 'p' }),
    ])
    assert.deepEqual(outcome.events.map((event) => event.data.subCallId), [
      'p', 'p:ptc:1', `p${REPAIR_INFIX}1`, `p:ptc:1${REPAIR_INFIX}1`,
    ])
    // The parent link is the original spelling even after the rename: the
    // reader compares roots, and the first start of `p` keeps that spelling.
    assert.deepEqual(outcome.events.map((event) => event.data.parentCallId), ['call-1', 'p', 'call-1', 'p'])
  })
})
