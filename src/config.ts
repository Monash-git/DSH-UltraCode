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
  /** Bounded wait for local child pause acknowledgments before forcing a stop. */
  readonly pauseTimeoutMs?: number
  /** Bounded drain before and after stopping a non-pausable workflow/bash job. */
  readonly pauseDrainMs?: number
}

export interface ResolvedConfig {
  readonly maxRounds: number
  readonly maxDurationMs: number
  readonly noProgressRounds: number
  readonly busyEnterDefault: BusyEnterDefault
  readonly ultraEffort: boolean
  readonly ultraReminder: boolean
  readonly fanoutLimit: number
  readonly pauseTimeoutMs: number
  readonly pauseDrainMs: number
}

const DEFAULT_MAX_ROUNDS = 120
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000
const DEFAULT_NO_PROGRESS_ROUNDS = 3
const DEFAULT_FANOUT_LIMIT = 8
const DEFAULT_PAUSE_TIMEOUT_MS = 60_000
const DEFAULT_PAUSE_DRAIN_MS = 2_000
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
    pauseTimeoutMs: positiveInteger('pauseTimeoutMs', config.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS),
    pauseDrainMs: positiveInteger('pauseDrainMs', config.pauseDrainMs ?? DEFAULT_PAUSE_DRAIN_MS),
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

interface SkillBudget {
  readonly rounds: number
  readonly longRun: boolean
}

const DEFAULT_BUDGET: SkillBudget = { rounds: 40, longRun: false }

const SKILL_BUDGETS: Readonly<Record<string, SkillBudget>> = {
  wayfinder: { rounds: 120, longRun: true },
  implement: { rounds: 120, longRun: true },
  ultra: { rounds: 120, longRun: true },
  tdd: { rounds: 60, longRun: false },
  'code-review': { rounds: 40, longRun: false },
  'to-spec': { rounds: 40, longRun: false },
  'to-tickets': { rounds: 40, longRun: false },
  research: { rounds: 30, longRun: false },
  'setup-matt-pocock-skills': { rounds: 30, longRun: false },
}

function budgetFor(skill: string): SkillBudget {
  return SKILL_BUDGETS[skill] ?? DEFAULT_BUDGET
}

/** Resolve the effective elapsed-time cap for one run. */
export function maxDurationFor(skill: string, config: ResolvedConfig): number {
  const requested = budgetFor(skill).longRun ? DEFAULT_MAX_DURATION_MS : SHORT_SKILL_DURATION_MS
  return Math.min(config.maxDurationMs, requested)
}

function defaultRoundsFor(skill: string): number {
  return budgetFor(skill).rounds
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
