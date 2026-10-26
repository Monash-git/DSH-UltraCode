/** Validated plugin configuration and per-skill budget resolution. */
const DEFAULT_MAX_ROUNDS = 120;
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_NO_PROGRESS_ROUNDS = 3;
const DEFAULT_FANOUT_LIMIT = 8;
const DEFAULT_PAUSE_TIMEOUT_MS = 60_000;
const DEFAULT_PAUSE_DRAIN_MS = 2_000;
const SHORT_SKILL_DURATION_MS = 30 * 60 * 1000;
/** Resolve and validate the plugin configuration. */
export function resolveConfig(config = {}) {
    const busyEnterDefault = config.busyEnterDefault ?? 'steer';
    if (busyEnterDefault !== 'steer' && busyEnterDefault !== 'queue' && busyEnterDefault !== 'preserve') {
        throw new Error('busyEnterDefault must be steer, queue, or preserve');
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
    };
}
/** Resolve the effective round cap for one run. */
export function maxRoundsFor(skill, metadataMaxRounds, config) {
    const requested = metadataMaxRounds ?? defaultRoundsFor(skill);
    return Math.min(config.maxRounds, requested);
}
const DEFAULT_BUDGET = { rounds: 40, longRun: false };
const SKILL_BUDGETS = {
    wayfinder: { rounds: 120, longRun: true },
    implement: { rounds: 120, longRun: true },
    ultra: { rounds: 120, longRun: true },
    tdd: { rounds: 60, longRun: false },
    'code-review': { rounds: 40, longRun: false },
    'to-spec': { rounds: 40, longRun: false },
    'to-tickets': { rounds: 40, longRun: false },
    research: { rounds: 30, longRun: false },
    'setup-matt-pocock-skills': { rounds: 30, longRun: false },
};
function budgetFor(skill) {
    return SKILL_BUDGETS[skill] ?? DEFAULT_BUDGET;
}
/** Resolve the effective elapsed-time cap for one run. */
export function maxDurationFor(skill, config) {
    const requested = budgetFor(skill).longRun ? DEFAULT_MAX_DURATION_MS : SHORT_SKILL_DURATION_MS;
    return Math.min(config.maxDurationMs, requested);
}
function defaultRoundsFor(skill) {
    return budgetFor(skill).rounds;
}
function positiveInteger(name, value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
//# sourceMappingURL=config.js.map