/**
 * The plugin's configuration, validated where it is read.
 *
 * The defaults are applied here rather than in an exported object named
 * `Config`, because the Loader reads a `Config` export as a schema: a plain
 * object there makes the plugin fail to mount with
 * `Cannot read properties of undefined (reading 'validate')`, and a plugin that
 * does not mount is a guard that is not in force.
 *
 * An unknown key is refused rather than ignored. A misspelled `mode` that
 * mounts and silently guards nothing is how an operator comes to believe the
 * session log is protected when it is not.
 *
 * @module @argszero/dsh-ptc-subcall-guard/config
 */

/** How the guard treats a colliding `subCallId`. */
export type GuardMode =
  /** Rewrite it to a session-unique id, so the batch stays complete and the log stays loadable. */
  | 'repair'
  /** Report the collision and append the batch unchanged — for measuring, before repairing. */
  | 'observe'

/** What the plugin accepts, every field optional. */
export interface GuardConfig {
  /** `false` disables the guard entirely; the plugin still mounts and logs nothing. */
  enabled?: boolean
  /** What to do with a colliding id. */
  mode?: GuardMode
  /** Bound on the collisions reported into the log, per session. */
  maxReportedRepairs?: number
  /** Bound on how many sessions keep a ledger; the least recently opened is dropped. */
  maxTrackedSessions?: number
}

/** The configuration after defaults and validation. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly mode: GuardMode
  readonly maxReportedRepairs: number
  readonly maxTrackedSessions: number
}

/** Collisions reported per session before the plugin stops repeating itself. */
export const DEFAULT_MAX_REPORTED_REPAIRS = 20

/**
 * Sessions that keep a ledger.
 *
 * A dropped ledger costs nothing that cannot be re-learned: a session opened
 * again is primed from the prefix its own resume reads, so the bound trades a
 * little memory for a re-read that the harness performs anyway.
 */
export const DEFAULT_MAX_TRACKED_SESSIONS = 128

const MODES: readonly GuardMode[] = ['repair', 'observe']

const KNOWN_KEYS = ['enabled', 'mode', 'maxReportedRepairs', 'maxTrackedSessions']

function positiveInteger(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`ptc-subcall-guard: "${name}" must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Apply defaults and validate one mounted configuration.
 * @param raw - the configuration as mounted; empty uses every default.
 * @returns the resolved configuration.
 * @throws when a key is unknown or a value is unusable — the plugin refuses to
 *   mount rather than guard under rules it cannot honour.
 */
export function resolveConfig(raw: GuardConfig = {}): ResolvedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`ptc-subcall-guard: configuration must be an object, got ${JSON.stringify(raw)}`)
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`ptc-subcall-guard: unknown configuration key "${key}"; known keys are ${KNOWN_KEYS.join(', ')}`)
    }
  }
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new Error(`ptc-subcall-guard: "enabled" must be a boolean, got ${JSON.stringify(enabled)}`)
  }
  const mode = raw.mode ?? 'repair'
  if (!MODES.includes(mode)) {
    throw new Error(`ptc-subcall-guard: "mode" must be one of ${MODES.join(', ')}, got ${JSON.stringify(mode)}`)
  }
  return {
    enabled,
    mode,
    maxReportedRepairs: positiveInteger('maxReportedRepairs', raw.maxReportedRepairs, DEFAULT_MAX_REPORTED_REPAIRS),
    maxTrackedSessions: positiveInteger('maxTrackedSessions', raw.maxTrackedSessions, DEFAULT_MAX_TRACKED_SESSIONS),
  }
}
