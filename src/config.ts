/** Validated plugin configuration and per-skill budget resolution. */

export type BusyEnterDefault = 'steer' | 'queue' | 'preserve'

export interface PluginConfig {
  /** Global round ceiling; a skill's metadata can only lower it. */
  readonly maxRounds?: number
  /** Global elapsed ceiling in milliseconds. */
  readonly maxDurationMs?: number
  /** Identical-progress rounds before the run stops. */
  readonly noProgressRounds?: number
  /** One-time default written when the user has not chosen a busy-enter mode. */
  readonly busyEnterDefault?: BusyEnterDefault
  /** Offer the selector-level Ultra tier on supported DeepSeek models. */
  readonly ultraEffort?: boolean
  /** Re-assert the Ultra standing mode on each human turn. */
  readonly ultraReminder?: boolean
  /** Fan-out guidance written into the playbook; the host cap still applies. */
  readonly fanoutLimit?: number
}

export interface ResolvedConfig {
  readonly maxRounds: number
  readonly maxDurationMs: number
  readonly noProgressRounds: number
  readonly busyEnterDefault: BusyEnterDefault
  readonly ultraEffort: boolean
  readonly ultraReminder: boolean
  readonly fanoutLimit: number
}

const DEFAULT_MAX_ROUNDS = 120
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000
const DEFAULT_NO_PROGRESS_ROUNDS = 3
const DEFAULT_FANOUT_LIMIT = 8
const SHORT_SKILL_DURATION_MS = 30 * 60 * 1000

/** Resolve and validate the plugin configuration. */
export function resolveConfig(config: PluginConfig = {}): ResolvedConfig {
  const busyEnterDefault = config.busyEnterDefault ?? 'steer'
  if (busyEnterDefault !== 'steer' && busyEnterDefault !== 'queue' && busyEnterDefault !== 'preserve') {
    throw new Error('busyEnterDefault must be steer, queue, or preserve')
  }
  return {
    maxRounds: positiveInteger('maxRounds', config.maxRounds ?? DEFAULT_MAX_ROUNDS),
    maxDurationMs: positiveInteger('maxDurationMs', config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS),
    noProgressRounds: positiveInteger('noProgressRounds', config.noProgressRounds ?? DEFAULT_NO_PROGRESS_ROUNDS),
    busyEnterDefault,
    ultraEffort: config.ultraEffort ?? true,
    ultraReminder: config.ultraReminder ?? true,
    fanoutLimit: positiveInteger('fanoutLimit', config.fanoutLimit ?? DEFAULT_FANOUT_LIMIT),
  }
}

/** Resolve the effective round cap for one run. */
export function maxRoundsFor(
  skill: string,
  metadataMaxRounds: number | undefined,
  config: ResolvedConfig,
): number {
  const requested = metadataMaxRounds ?? defaultRoundsFor(skill)
  return Math.min(config.maxRounds, requested)
}

/** Resolve the effective elapsed-time cap for one run. */
export function maxDurationFor(skill: string, config: ResolvedConfig): number {
  const requested = skill === 'wayfinder' || skill === 'implement' || skill === 'ultra'
    ? DEFAULT_MAX_DURATION_MS
    : SHORT_SKILL_DURATION_MS
  return Math.min(config.maxDurationMs, requested)
}

function defaultRoundsFor(skill: string): number {
  switch (skill) {
    case 'wayfinder':
    case 'implement':
    case 'ultra':
      return 120
    case 'tdd':
      return 60
    case 'code-review':
    case 'to-spec':
    case 'to-tickets':
      return 40
    case 'research':
    case 'setup-matt-pocock-skills':
      return 30
    default:
      return 40
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
