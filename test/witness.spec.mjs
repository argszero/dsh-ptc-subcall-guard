/**
 * The witness: the plugin against the shipped backend and the shipped validator.
 *
 * A stub can only ever agree with itself. This file mounts the guard over a real
 * cordis `Context` and the real JSONL `SessionPersistence`, writes through it,
 * and re-opens the session with the same reader the harness uses — so what is
 * asserted is the reported failure itself, reproduced and then prevented, not a
 * model of it.
 *
 * The unguarded arm is the control: it is what the discussion reports, and if it
 * ever stopped failing, the guarded arm would prove nothing.
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../lib/index.js'
import { ORIGINAL } from '../lib/install.js'
import { headerFor, other, realBackend, start } from './harness.mjs'

/** The batch the discussion's session grew out of: one id, started twice. */
const COLLIDING = [other(0), start(1, 'call-1:ptc:1'), start(2, 'call-1:ptc:1')]

/**
 * Create one session, append one batch, close the write handle.
 * @returns the session id.
 */
async function writeOnce(persistence, id, batch, cwd, readFirst = false) {
  const created = await persistence.create(headerFor(id, cwd, SESSION_FORMAT_VERSION))
  if (readFirst) await created.read()
  try {
    await created.append(batch)
  } finally {
    await created.close()
  }
}

/** Read one session back through the shipped reader, and close. */
async function readBack(persistence, id) {
  const handle = await persistence.open(id, 'read')
  try {
    return await handle.read()
  } finally {
    await handle.close()
  }
}

/** Stop the context and drop the scratch tree it wrote into. */
async function closeDown(backend) {
  await backend.cleanup()
  rmSync(backend.root, { recursive: true, force: true })
}

describe('the reported failure, against the shipped backend', () => {
  it('accepts the repeat on the write path and then refuses to open the session', async () => {
    const backend = await realBackend()
    try {
      const persistence = backend.ctx.get('sessionPersistence')
      const id = SessionId('witness-unguarded')
      await writeOnce(persistence, id, COLLIDING, backend.root)

      // The write succeeded: the two starts were appended as built. Nothing on
      // the write path looked at the id.
      await assert.rejects(
        () => readBack(persistence, id),
        (error) => {
          assert.match(String(error.message), /PTC dispatch repeats subCallId/)
          return true
        },
      )
    } finally {
      await closeDown(backend)
    }
  })

  it('the same shipment mounts and keeps the session readable, with the delete-free rename intact', async () => {
    const backend = await realBackend()
    try {
      const persistence = backend.ctx.get('sessionPersistence')
      const warned = []
      apply({
        get: (name) => backend.ctx.get(name),
        logger: { warn: (line) => warned.push(line), debug: () => {} },
        effect: (register) => { register() },
      }, {})
      const id = SessionId('witness-guarded')
      await writeOnce(persistence, id, COLLIDING, backend.root)

      const read = await readBack(persistence, id)
      assert.equal(read.events.length, 3)
      assert.deepEqual(read.events.map((event) => event.data?.subCallId).filter(Boolean), [
        'call-1:ptc:1', 'call-1:ptc:1::r1',
      ])
      assert.equal(warned.length, 1)
      assert.match(warned[0], /call-1:ptc:1 -> call-1:ptc:1::r1/)
    } finally {
      await closeDown(backend)
    }
  })

  it('renames against the stored prefix a resumed session reads, not only against what it appends', async () => {
    const backend = await realBackend()
    try {
      const persistence = backend.ctx.get('sessionPersistence')
      apply({
        get: (name) => backend.ctx.get(name),
        logger: { warn: () => {}, debug: () => {} },
        effect: (register) => { register() },
      }, {})
      const id = SessionId('witness-resumed')
      await writeOnce(persistence, id, [other(0), start(1, 'call-1:ptc:1')], backend.root)

      // The resume path: a write handle reads the prefix it is about to
      // continue, which is where the already-used ids come from.
      const resumed = await persistence.open(id, 'write')
      try {
        await resumed.read()
        await resumed.append([start(2, 'call-1:ptc:1')])
      } finally {
        await resumed.close()
      }

      const read = await readBack(persistence, id)
      assert.equal(read.events.length, 3)
      assert.equal(read.events[2].data.subCallId, 'call-1:ptc:1::r1')
    } finally {
      await closeDown(backend)
    }
  })
})

describe('the seam, against the shipped cordis context', () => {
  it('is an own write on the instance, so every fresh view of the service sees it', async () => {
    const backend = await realBackend()
    try {
      const first = backend.ctx.get('sessionPersistence')
      const instance = first[ORIGINAL]
      assert.notEqual(instance, undefined, 'the service view must expose its instance')
      assert.notEqual(instance, first, 'and must not be the instance itself')
      apply({
        get: (name) => backend.ctx.get(name),
        logger: { warn: () => {}, debug: () => {} },
        effect: (register) => { register() },
      }, {})

      // A second `get` is a different view of the same instance; if the write
      // had landed on the first view, this one would not carry it.
      const second = backend.ctx.get('sessionPersistence')
      assert.notEqual(second, first)
      assert.equal(Object.prototype.hasOwnProperty.call(instance, 'open'), true)
      assert.notEqual(second.open, Object.getPrototypeOf(instance).open)
    } finally {
      await closeDown(backend)
    }
  })

  it('unwinds back to the prototype methods the shipped class declares', async () => {
    const backend = await realBackend()
    try {
      const persistence = backend.ctx.get('sessionPersistence')
      const instance = persistence[ORIGINAL]
      const prototypeOpen = Object.getPrototypeOf(instance).open
      const disposers = []
      apply({
        get: (name) => backend.ctx.get(name),
        logger: { warn: () => {}, debug: () => {} },
        effect: (register) => { disposers.push(register()) },
      }, {})
      assert.notEqual(instance.open, prototypeOpen)

      for (const dispose of disposers.reverse()) dispose()
      // The prototype method must be *revealed* again, not frozen as an own
      // property: the instance is read without going through a view here, so
      // this is the raw prototype chain and a reference comparison is exact.
      assert.equal(Object.prototype.hasOwnProperty.call(instance, 'open'), false)
      assert.equal(Object.prototype.hasOwnProperty.call(instance, 'create'), false)
      assert.equal(instance.open, prototypeOpen)
      assert.equal(backend.ctx.get('sessionPersistence')[ORIGINAL], instance)
    } finally {
      await closeDown(backend)
    }
  })

  it('stops preventing the failure once it is unwound, so an unloaded guard guards nothing', async () => {
    const backend = await realBackend()
    try {
      const disposers = []
      apply({
        get: (name) => backend.ctx.get(name),
        logger: { warn: () => {}, debug: () => {} },
        effect: (register) => { disposers.push(register()) },
      }, {})
      for (const dispose of disposers) dispose()

      const persistence = backend.ctx.get('sessionPersistence')
      const id = SessionId('witness-unwound')
      await writeOnce(persistence, id, COLLIDING, backend.root)
      await assert.rejects(() => readBack(persistence, id), /PTC dispatch repeats subCallId/)
    } finally {
      await closeDown(backend)
    }
  })

  it('declares the service it shadows, so a profile mounts it after that service', async () => {
    const module = await import('../lib/index.js')
    assert.deepEqual(module.inject, ['sessionPersistence'])
    assert.equal(module.name, 'ptc-subcall-guard')
    assert.equal(module.default.inject, module.inject)
    assert.equal(module.default.apply, module.apply)
  })
})
