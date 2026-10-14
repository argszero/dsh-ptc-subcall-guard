/**
 * Configuration: the defaults, and the refusals that keep a mounted plugin from
 * quietly guarding nothing. A misspelled key that mounts is how an operator comes
 * to believe a session log is protected when it is not.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_MAX_REPORTED_REPAIRS, DEFAULT_MAX_TRACKED_SESSIONS, resolveConfig } from '../lib/config.js'

describe('defaults', () => {
  it('applies every default to an empty configuration', () => {
    assert.deepEqual(resolveConfig(), {
      enabled: true,
      mode: 'repair',
      maxReportedRepairs: DEFAULT_MAX_REPORTED_REPAIRS,
      maxTrackedSessions: DEFAULT_MAX_TRACKED_SESSIONS,
    })
    assert.deepEqual(resolveConfig({}), resolveConfig())
  })

  it('takes the mounted values over the defaults', () => {
    assert.deepEqual(resolveConfig({ enabled: false, mode: 'observe', maxReportedRepairs: 1, maxTrackedSessions: 2 }), {
      enabled: false,
      mode: 'observe',
      maxReportedRepairs: 1,
      maxTrackedSessions: 2,
    })
  })
})

describe('refusals', () => {
  it('refuses a configuration that is not an object', () => {
    for (const value of [null, 'x', 7, [], true]) {
      assert.throws(() => resolveConfig(value), /must be an object/)
    }
  })

  it('refuses an unknown key rather than ignoring it', () => {
    assert.throws(() => resolveConfig({ modes: 'observe' }), /unknown configuration key "modes"/)
    assert.throws(() => resolveConfig({ mode: 'repair', repair: true }), /unknown configuration key "repair"/)
  })

  it('names the keys it does know, so the message is usable', () => {
    assert.throws(() => resolveConfig({ nope: 1 }), /enabled, mode, maxReportedRepairs, maxTrackedSessions/)
  })

  it('refuses a non-boolean `enabled`', () => {
    assert.throws(() => resolveConfig({ enabled: 'yes' }), /"enabled" must be a boolean/)
  })

  it('refuses a mode it cannot honour', () => {
    assert.throws(() => resolveConfig({ mode: 'rewrite' }), /"mode" must be one of repair, observe/)
  })

  it('refuses a bound that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, '10', null]) {
      assert.throws(() => resolveConfig({ maxReportedRepairs: value }), /"maxReportedRepairs" must be a positive integer/)
      assert.throws(() => resolveConfig({ maxTrackedSessions: value }), /"maxTrackedSessions" must be a positive integer/)
    }
  })
})
