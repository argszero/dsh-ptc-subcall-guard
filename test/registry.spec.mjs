/**
 * The registry: one ledger per session, a bounded number of them, and a bounded
 * number of log lines per session. Both bounds exist because a guard that grows
 * without bound is a slower version of the failure it prevents.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionRegistry } from '../lib/registry.js'
import { settle, start } from './harness.mjs'

/** One repair record as the ledger mints it. */
const record = (n) => ({ original: `x${String(n)}`, replacement: `x${String(n)}::r1`, settleCarried: false })

describe('one ledger per session', () => {
  it('hands the same ledger back for the same session', () => {
    const registry = new SessionRegistry(4, 4)
    assert.equal(registry.ledgerFor('a'), registry.ledgerFor('a'))
    assert.equal(registry.trackedSessions, 1)
  })

  it('keeps a different ledger per session, because the invariant is per log', () => {
    const registry = new SessionRegistry(4, 4)
    registry.ledgerFor('a').repair([start(0, 'x')])
    const other = registry.ledgerFor('b')
    assert.equal(other.repair([start(0, 'x')]).rewritten, 0)
  })

  it('drops the least recently used session once it is past its bound', () => {
    const registry = new SessionRegistry(2, 4)
    registry.ledgerFor('a').repair([start(0, 'x')])
    registry.ledgerFor('b').repair([start(0, 'y')])
    // Touching `a` makes `b` the least recently used one.
    registry.ledgerFor('a')
    registry.ledgerFor('c')
    assert.equal(registry.trackedSessions, 2)
    // `a` was touched, so it is still there and still knows what it saw.
    assert.equal(registry.ledgerFor('a').repair([start(1, 'x')]).rewritten, 1)
    // `b` is gone, so its ledger starts empty again — which costs only what a
    // re-open of that session re-learns from its own prefix.
    assert.equal(registry.ledgerFor('b').repair([start(1, 'y')]).rewritten, 0)
  })

  it('counts the repairs across every tracked session', () => {
    const registry = new SessionRegistry(4, 4)
    registry.ledgerFor('a').repair([start(0, 'x'), start(1, 'x')])
    registry.ledgerFor('b').repair([start(0, 'y'), start(1, 'y')])
    assert.equal(registry.repairCount, 2)
  })

  it('carries a settle for a session whose ledger was dropped without inventing one', () => {
    const registry = new SessionRegistry(1, 4)
    const first = registry.ledgerFor('a')
    first.repair([start(0, 'x'), start(1, 'x')])
    registry.ledgerFor('b')
    const second = registry.ledgerFor('a')
    assert.notEqual(second, first)
    assert.equal(second.repair([settle(2, 'x')]).rewritten, 0)
  })
})

describe('the reporting budget', () => {
  it('releases records up to the session\'s budget', () => {
    const registry = new SessionRegistry(4, 2)
    const grant = registry.admit('a', [record(1), record(2)])
    assert.equal(grant.admitted.length, 2)
    assert.equal(grant.suppressed, 0)
  })

  it('spends the budget across calls rather than refreshing it', () => {
    const registry = new SessionRegistry(4, 2)
    registry.admit('a', [record(1)])
    const grant = registry.admit('a', [record(2), record(3)])
    assert.equal(grant.admitted.length, 1)
    assert.equal(grant.suppressed, 1)
  })

  it('reports nothing once the budget is spent, and counts what it withheld', () => {
    const registry = new SessionRegistry(4, 1)
    registry.admit('a', [record(1)])
    const grant = registry.admit('a', [record(2)])
    assert.deepEqual(grant.admitted, [])
    assert.equal(grant.suppressed, 1)
  })

  it('keeps a separate budget per session', () => {
    const registry = new SessionRegistry(4, 1)
    registry.admit('a', [record(1)])
    assert.equal(registry.admit('b', [record(2)]).admitted.length, 1)
  })
})
