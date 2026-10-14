/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is **caught**. An arm whose mutation leaves the suite green is
 * SILENT — the promise it removes is untested, which is a finding about the
 * suite rather than a pass.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with `tsc`
 * first. A mutation that does not compile proves nothing either and is reported
 * as TYPEFAIL rather than counted.
 *
 * Each arm removes **one distinction this plugin exists to make**, chosen from
 * the promises the README and the module docs make: the instance seam, the
 * read-back that confirms a write, the unwind that reveals the prototype method,
 * the repeat detection, the rename namespace, the settle carried through the
 * FIFO, the prefix priming, the write-handle test, the two bounds, the four
 * configuration knobs.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=seam    # arms whose name matches
 * ```
 *
 * The harness restores the source in a `finally` **and rebuilds afterwards**:
 * the last arm leaves its mutation compiled into `lib/`, so a checkout that ran
 * this and then published would ship the last mutant.
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/**
 * One arm per distinction.
 *
 * `equivalent` marks a mutant kept in the list although no fixture can kill it,
 * with the measurement that makes it equivalent — recorded rather than hidden,
 * because "we tried to make this arm bite and could not" is a fact about the
 * arm.
 */
const MUTATIONS = [
  {
    // The seam is the instance: a write on the view is a write on a tracker
    // proxy, which every later `get` may hand back as a different object.
    name: 'seam: the shadow is written to the view instead of the instance',
    file: 'src/install.ts',
    edits: [["  if (original !== null && typeof original === 'object') {", '  if (false) {']],
  },
  {
    // A prototype method must be revealed by deleting the shadow, not frozen as
    // an own property forever.
    name: 'seam: restore freezes the prototype method as an own property',
    file: 'src/install.ts',
    edits: [[
      '        if (shadow.hadOwn) mutable[shadow.key] = shadow.original\n        else delete mutable[shadow.key]',
      '        mutable[shadow.key] = shadow.original',
    ]],
  },
  {
    // The read-back is not redundant with the `try`: a proxy can answer `true`
    // to the write and store nothing, and then the read-back is the only thing
    // that notices.
    name: 'seam: the read-back after writing `open` is not confirmed',
    file: 'src/install.ts',
    edits: [['      written = mutable[shadow.key] === shadow.wrapper', '      written = true']],
  },
  {
    // Two copies of the plugin in one process must not wrap one another. Both
    // entry points carry the check, so an arm that removes one of them is
    // equivalent — the other still recognises the mount.
    name: 'seam: an already-shadowed service is wrapped a second time',
    file: 'src/install.ts',
    edits: [
      ['  if (hasOpen && isLive(open, OPEN_MARK) && liveActive(open, OPEN_ACTIVE)) {', '  if (false) {'],
      ['  if (hasCreate && isLive(create, CREATE_MARK) && liveActive(create, CREATE_ACTIVE)) {', '  if (false) {'],
    ],
  },
  {
    // A wrapper left behind by an unwound mount is not a guard in force: a
    // second mount must wrap it rather than recognise it, or the handle stays
    // unguarded for the rest of its life.
    name: 'seam: a stale wrapper from an unloaded mount counts as a live guard',
    file: 'src/install.ts',
    edits: [['  return flag === true', '  return flag !== undefined']],
  },
  {
    // Unwinding a half-installed shadow restores the ownership each key was
    // seen with; the shape of one key is not the shape of the other.
    name: 'handle: the unwind writes an own property where the handle had none',
    file: 'src/install.ts',
    edits: [[
      '        if (back.hadOwn) mutable[back.key] = back.original\n        else delete mutable[back.key]\n      }\n      return \'not-writable\'',
      '        if (!back.hadOwn) mutable[back.key] = back.original\n        else delete mutable[back.key]\n      }\n      return \'not-writable\'',
    ]],
  },
  {
    // A handle with no `append` is not a write handle, and wrapping it would
    // report a guard that can never fire.
    name: 'handle: a handle carrying no `append` is wrapped anyway',
    file: 'src/install.ts',
    edits: [["  if (typeof currentAppend !== 'function') return 'no-append'", "  if (false) return 'no-append'"]],
  },
  {
    // The headline: the batch the original sees is the rewritten one.
    name: 'handle: the repaired batch is not the batch that is appended',
    file: 'src/install.ts',
    edits: [['      if (mode === \'repair\') args = [outcome.events, ...args.slice(1)]', '      if (false) args = [outcome.events, ...args.slice(1)]']],
  },
  {
    // An observation that could not be made is a missing report, never a failed
    // append.
    name: 'handle: an observer failure becomes the append\'s failure',
    file: 'src/install.ts',
    edits: [[
      '        try {\n          hooks.onRepair?.(outcome.repairs, sessionId)\n        } catch {\n          // Reporting is auxiliary; the append it reported on is not.\n        }',
      '        hooks.onRepair?.(outcome.repairs, sessionId)',
    ]],
  },
  {
    // The prefix a resumed session reads is what primes the used set; without it
    // a guard mounted mid-session renames against only what it has seen.
    name: 'prime: the stored prefix a resume reads does not prime the ledger',
    file: 'src/install.ts',
    edits: [['    if (Array.isArray(events)) ledger.prime(events as Record<string, unknown>[])', '    if (false) ledger.prime(events as Record<string, unknown>[])']],
  },
  {
    // An append that settles a renamed dispatch carries it, and that is not the
    // same as "this batch found a new collision".
    name: 'handle: a carried settle is dropped when the batch repaired nothing new',
    file: 'src/install.ts',
    edits: [['      if (mode === \'repair\') args = [outcome.events, ...args.slice(1)]', '      if (mode === \'repair\' && outcome.repairs.length > 0) args = [outcome.events, ...args.slice(1)]']],
  },
  {
    // The invariant is "one dispatch per id in the entire log", so a second
    // start of a used id is exactly what the reader will throw on.
    name: 'ledger: a repeat is not detected, so nothing is renamed',
    file: 'src/repair.ts',
    edits: [['        const repeated = this.started.has(id)', '        const repeated = false']],
  },
  {
    // The guard's namespace must be one the producer cannot mint, or a renamed
    // id can collide with a producer id and the rename repairs nothing.
    name: 'ledger: a renamed id lives in the producer\'s own namespace',
    file: 'src/repair.ts',
    edits: [['      const candidate = `${original}${REPAIR_INFIX}${n}`', '      const candidate = original']],
  },
  {
    // A settle-only id is not in the reader's map, so counting it would rename a
    // start that never collided.
    name: 'prime: a settle-only id counts as one the log already started',
    file: 'src/repair.ts',
    edits: [["      if (dispatchRole(event['type']) !== 'start') continue", "      if (dispatchRole(event['type']) === undefined) continue"]],
  },
  {
    // The settle arrives under the producer's id, so the written id is what has
    // to be carried to it.
    name: 'ledger: the paired settle is not carried to the renamed id',
    file: 'src/repair.ts',
    edits: [['      const written = queue === undefined ? undefined : queue.shift()', '      const written = undefined']],
  },
  {
    // Two dispatches of one id must keep their order, or a settle lands on the
    // wrong write.
    name: 'ledger: the per-id queue forgets its earlier writes',
    file: 'src/repair.ts',
    edits: [[
      '        if (queue === undefined) this.open.set(id, [written])\n        else queue.push(written)',
      '        this.open.set(id, [written])',
    ]],
  },
  {
    // Renaming a start without renaming its own batch entry writes the duplicate
    // down anyway.
    name: 'ledger: the rewritten id is recorded but the event is appended unchanged',
    file: 'src/repair.ts',
    edits: [[
      '          copy ??= [...events]\n          copy[index] = { ...event, data: { ...data, subCallId: written } }\n          rewritten += 1\n        }\n        continue',
      '          copy ??= [...events]\n          rewritten += 1\n        }\n        continue',
    ]],
  },
  {
    // Nothing was installed, so nothing may rewrite.
    name: 'config: a disabled plugin still shadows the service',
    file: 'src/index.ts',
    edits: [['  if (!settings.enabled) {', '  if (false) {']],
  },
  {
    // A `read` handle refuses `append`; wrapping it installs a guard over a call
    // that can never carry the collision.
    name: 'index: a read handle is wrapped as if it were a write handle',
    file: 'src/index.ts',
    edits: [["  return call.method === 'create' || call.access === 'write'", '  return true']],
  },
  {
    // The collision is only worth a line when one has not already been spent.
    name: 'index: the reporting budget is not consulted',
    file: 'src/index.ts',
    edits: [['          if (grant.admitted.length === 0) return', '          if (false) return']],
  },
  {
    // A mount with no service guards nothing, and silence is how an operator
    // comes to believe the log is protected.
    name: 'index: a missing service is reported at debug instead of as a warning',
    file: 'src/index.ts',
    edits: [[
      '    ctx.logger.warn(`${LOG_PREFIX} the sessionPersistence service is not mounted, so nothing is guarded: `',
      '    ctx.logger.debug(`${LOG_PREFIX} the sessionPersistence service is not mounted, so nothing is guarded: `',
    ]],
  },
  {
    // An unknown key is refused rather than ignored: a misspelled `mode` that
    // mounts and guards nothing is the failure this exists to prevent.
    name: 'config: an unknown key is ignored instead of refused',
    file: 'src/config.ts',
    edits: [['    if (!KNOWN_KEYS.includes(key)) {', '    if (false) {']],
  },
  {
    // The default rewrites; `observe` passes the collision through, and is the
    // mode an operator would silently get.
    name: 'config: `mode` defaults to observe',
    file: 'src/config.ts',
    edits: [["  const mode = raw.mode ?? 'repair'", "  const mode = raw.mode ?? 'observe'"]],
  },
  {
    // The default is the one that keeps a quiet deployment quiet.
    name: 'config: the reporting bound defaults to zero',
    file: 'src/config.ts',
    edits: [['    maxReportedRepairs: positiveInteger(\'maxReportedRepairs\', raw.maxReportedRepairs, DEFAULT_MAX_REPORTED_REPAIRS)', '    maxReportedRepairs: positiveInteger(\'maxReportedRepairs\', raw.maxReportedRepairs, 0)']],
  },
  {
    // The bound is what keeps a deployment from growing a ledger per session it
    // has ever seen.
    name: 'registry: the tracked-session bound is not enforced',
    file: 'src/registry.ts',
    // `while (false)` would not compile: the body becomes unreachable, the
    // `if (oldest === undefined) break` inside it stops narrowing, and
    // `this.ledgers.delete(oldest)` reports TS2345. An opaque predicate keeps
    // the body reachable for the checker while never running.
    edits: [['    while (this.ledgers.size > this.maxTrackedSessions) {', '    while (this.ledgers.size > this.maxTrackedSessions && (false as boolean)) {']],
  },
  {
    // Recency is read at lookup time; without the re-insert the least recently
    // *created* is evicted while a live session is dropped instead.
    name: 'registry: the memo hit does not mark the session most recently used',
    file: 'src/registry.ts',
    edits: [[
      '      this.ledgers.delete(sessionId)\n      this.ledgers.set(sessionId, existing)\n      return existing',
      '      return existing',
    ]],
  },
  {
    // A session that collides forever must not write forever into the log it is
    // protecting.
    name: 'registry: the reporting budget admits every collision',
    file: 'src/registry.ts',
    edits: [['    const room = Math.max(0, this.maxReportedRepairs - already)', '    const room = records.length']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: a mutant that never terminates is a mutant the
 * suite cannot report on, and it is killed here rather than hanging the gate.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns whether it succeeded, and the text it produced.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
let malformed = 0
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  if (!Array.isArray(mutation.edits) || mutation.edits.length === 0
    || !mutation.edits.every(edit => Array.isArray(edit) && edit.length === 2
      && typeof edit[0] === 'string' && typeof edit[1] === 'string')) {
    // A flat array of strings would be destructured into single characters and
    // rewrite nothing — a silent no-op, reported here instead.
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'every edit must be a [from, to] pair of strings' })
    malformed += 1
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  if (mutated === original) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the edit left the file byte-identical' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The `finally` above restores the *source*; the build output
// is whatever the last arm compiled, so it is rebuilt here whether or not every
// arm was evaluated.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 && malformed === 0 ? 0 : 1
