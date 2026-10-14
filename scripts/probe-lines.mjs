#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable: for each line the range admits, it copies this
 * package into a scratch directory, pins **the whole line**, installs, and runs
 * the suite there.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is checking. Each `||`
 * segment of the `@deepseek-ai/dsh-session-persistence` range is one line, and
 * its **newest** published build is the representative: the earliest build of a
 * line is an alpha nobody is left on. The newest is read back from npm's own
 * resolver (`npm view "<name>@<range>"`), which is the reading a consumer gets,
 * rather than re-derived here with a second copy of the version algebra.
 *
 * This plugin's seam is two facts about shipped implementations — `open` and
 * `create` living on the persistence class's **prototype**, and cordis answering
 * a service view with the underlying instance — plus the v4 relationship the
 * session is validated against when it is read. The suite's witness spec asserts
 * all of that against whatever the line installed, so the probe is not a
 * formality. Four rules, because violating any of them measures the probe rather
 * than the line:
 *
 * 1. **The whole line is pinned, not the packages this plugin happens to
 *    import.** The set of harness packages a line carries grows between lines, so
 *    it is read from that line's own manifests — the peers of
 *    `@deepseek-ai/dsh-session-persistence` and
 *    `@deepseek-ai/dsh-session-persistence-jsonl` at that line — rather than
 *    written down here.
 * 2. **`--legacy-peer-deps`.** Without it npm derives peers transitively and can
 *    install a second line's copy of a package to satisfy them, which is again a
 *    tree that is not the line. There is no lockfile to honour: the pins *are*
 *    the specification.
 * 3. **Every pinned package's version is read back after install.** A pin that
 *    silently did not apply is the failure this whole script exists to prevent,
 *    so it is asserted before the suite runs and a mixed tree can never be
 *    reported as a passing line.
 * 4. **A pin set that came out empty is a FAIL, not a PASS.** Every pin is
 *    derived from the registry, so an unreachable registry yields an empty set,
 *    the install succeeds with the manifest's own dependencies, and the suite
 *    then runs against whatever tree happens to be there — a green line that
 *    measured nothing. The set is asserted non-empty *before* the install.
 *
 * `@deepseek-ai/cordis` does not follow the harness line numbering, so its exact
 * version comes from the constraint that line's own `dsh-session-persistence`
 * states; an unmatched constraint is reported rather than guessed.
 *
 * ```sh
 * node scripts/probe-lines.mjs                  # every line the range admits
 * node scripts/probe-lines.mjs -- 0.2.0-rc.2    # one line
 * node scripts/probe-lines.mjs --keep           # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * table in both) rather than left claimed. Development-only: not published.
 *
 * @module scripts/probe-lines
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The range this probe is about: this plugin's own peer on the persistence service. */
const RANGE_OF = '@deepseek-ai/dsh-session-persistence'

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/** The services this plugin needs the line to ship. */
const LOADED = ['@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl']

/** Harness packages the suite imports that a line's own peer list does not name. */
const EXTRA = ['@deepseek-ai/dsh-session-format-v3-to-v4', '@deepseek-ai/dsh-scope']

/**
 * The newest published build of a range, as npm's own resolver reads the range.
 * `npm view` answers with one string for a single match and a list otherwise,
 * ascending, so the newest is the last element either way.
 * @param name - the package to resolve.
 * @param range - the range to resolve it against.
 * @returns the version, or `undefined` when nothing published matches.
 */
function newestMatching(name, range) {
  const raw = view(`${name}@${range}`, 'version')
  if (raw === undefined) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  return list.length === 0 ? undefined : list[list.length - 1]
}

/**
 * The representative build of each `||` segment of a range.
 *
 * A segment's lower bound names the line it is about — `>=0.2.0-rc.1
 * <0.2.1-alpha.2` is the 0.2.0 line — and the representative is the newest build
 * **of that series**. The higher bound can admit a later prerelease (npm answers
 * `0.2.1-alpha.1` for that segment), and taking the numeric maximum of everything
 * a segment admits would then probe the next line under this line's name while
 * leaving the line the segment actually names unprobed. The series comes from the
 * segment's own `>=` comparator, so the rule reads the contract instead of
 * restating it.
 *
 * @param range - a semver range, composed of `||` segments.
 * @param name - the package whose versions the segments are read against.
 * @returns one entry per segment, in range order; `version` is undefined when nothing matched.
 */
function representativesOf(range, name) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => {
      const answer = view(`${name}@${segment}`, 'version')
      const admitted = answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]
      if (admitted.length === 0) return { segment, series: undefined, version: undefined }
      const series = /(?:^|\s)>=\s*(\d+\.\d+\.\d+)/.exec(segment)?.[1]
      const ofSeries = series === undefined
        ? []
        : admitted.filter(version => version === series || version.startsWith(`${series}-`))
      const pool = ofSeries.length > 0 ? ofSeries : admitted
      return { segment, series: series ?? pool[pool.length - 1].replace(/-.*$/, ''), version: pool[pool.length - 1] }
    })
}

/** Read one field of a published manifest, or `undefined` when it is unreachable. */
function view(specifier, field) {
  try {
    const raw = execFileSync(
      'npm', ['view', specifier, field, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return JSON.parse(raw || 'null')
  } catch {
    return undefined
  }
}

/**
 * Every `@deepseek-ai/dsh-*` package one line carries beside the two it mounts.
 * @param line - the line to read.
 * @returns the package names, or an empty array when neither manifest is reachable.
 */
function linePackages(line) {
  const names = new Set()
  for (const pkg of LOADED) {
    const peers = view(`${pkg}@${line}`, 'peerDependencies') ?? {}
    for (const name of Object.keys(peers)) if (name.startsWith('@deepseek-ai/dsh-')) names.add(name)
  }
  return [...names]
}

/** Whether one package has a build at exactly this line. */
function publishedAt(name, line) {
  return view(`${name}@${line}`, 'version') !== undefined
}

/**
 * The exact cordis version this line was published against.
 * @param line - the line to read.
 * @returns the version and the constraint it came from, either possibly undefined.
 */
function cordisPin(line) {
  const peers = view(`${RANGE_OF}@${line}`, 'peerDependencies') ?? {}
  const constraint = peers['@deepseek-ai/cordis']
  return {
    constraint,
    version: constraint === undefined
      ? undefined
      : newestMatching('@deepseek-ai/cordis', constraint),
  }
}

/**
 * Install the pinned tree, then assert that the pins are what was installed.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param pins - the exact versions the tree was supposed to get.
 */
function install(dir, log, pins) {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  const resolved = []
  for (const [name, wanted] of Object.entries(pins)) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
    resolved.push(`${name.replace('@deepseek-ai/', '')}@${installed}`)
    if (installed !== wanted) {
      throw new Error(`the pin did not apply: ${name} resolved to ${installed}, not ${wanted}`)
    }
  }
  log(`    pinned ${resolved.length} packages exactly: ${resolved.join(' ')}`)
}

/** Install one probe and run the suite in it. */
function probe(line, series) {
  const dir = mkdtempSync(join(tmpdir(), `ptc-subcall-guard-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line}${series === undefined ? '' : ` — the ${series} series`} — ${dir}`)
  const declared = [
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...LOADED,
    ...linePackages(line),
    ...EXTRA,
  ]
  const names = [...new Set(declared)]
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))
    // A package the line never shipped cannot be pinned to it. Dropped rather
    // than silently resolved from another line: the count is printed, because a
    // dropped name is one hole in "the whole line" the reader should see.
    .filter(name => publishedAt(name, line))
  const harness = [...new Set(declared)].filter(name => name.startsWith('@deepseek-ai/dsh-'))
  const cordis = cordisPin(line)
  const pins = Object.fromEntries([
    ...names.map(name => [name, line]),
    ...cordis.version === undefined ? [] : [['@deepseek-ai/cordis', cordis.version]],
  ])
  if (Object.keys(pins).length === 0) {
    // Rule 4: an empty pin set means the registry answered nothing, and an
    // install that follows would measure the machine rather than the line.
    log(`=== ${line}: FAIL — no pin could be derived, so nothing would be pinned`)
    rmSync(dir, { recursive: true, force: true })
    return false
  }
  log(`    pinning ${names.length} harness package(s) at this line${harness.length - names.length > 0 ? ` (${harness.length - names.length} of ${harness.length} not published at it, left unpinned)` : ''}`)
  log(`    line states cordis ${String(cordis.constraint)}${cordis.version === undefined ? ' — UNMATCHED, left to npm' : `; pinned ${cordis.version}`}`)

  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The pins live in `devDependencies` so the tree is exactly the line: the
    // peers are satisfied by it, and nothing else is installed for them.
    devDependencies: { ...manifest.devDependencies, ...pins },
    // No `probe-lines` script here: the probe must not be able to recurse.
    scripts: { test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)

  try {
    install(dir, log, pins)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies[RANGE_OF]
const representatives = representativesOf(range, RANGE_OF)
// A segment nothing published matches is a claim with no line behind it: it
// would never be probed, and the range would keep naming a line that does not
// exist. Reported with the same weight as a failing line.
const unmatched = representatives.filter(entry => entry.version === undefined)
const lines = requested.length > 0
  ? requested.map(version => ({ version, series: undefined }))
  : representatives.filter(entry => entry.version !== undefined)

const failed = lines.filter(entry => !probe(entry.version, entry.series)).map(entry => entry.version)
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
for (const entry of unmatched) {
  process.stdout.write(`unmatched segment: "${entry.segment}" matches no published build\n`)
}
if (failed.length > 0 || unmatched.length > 0) {
  if (failed.length > 0) process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and the patch\n`)
  process.exitCode = 1
}
