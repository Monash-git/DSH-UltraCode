/** Validated plugin configuration and per-skill budget resolution. */
export type BusyEnterDefault = 'steer' | 'queue' | 'preserve';
export interface PluginConfig {
    /** Global round ceiling; a skill's metadata can only lower it. */
    readonly maxRounds?: number;
    /** Global elapsed ceiling in milliseconds. */
    readonly maxDurationMs?: number;
    /** Identical-progress rounds before the run stops. */
    readonly noProgressRounds?: number;
    /** One-time default written when the user has not chosen a busy-enter mode. */
    readonly busyEnterDefault?: BusyEnterDefault;
    /** Offer the selector-level Ultra tier on supported DeepSeek models. */
    readonly ultraEffort?: boolean;
    /** Re-assert the Ultra standing mode on each human turn. */
    readonly ultraReminder?: boolean;
    /** Fan-out guidance written into the playbook; the host cap still applies. */
    readonly fanoutLimit?: number;
    /** Bounded wait for local child pause acknowledgments before forcing a stop. */
    readonly pauseTimeoutMs?: number;
    /** Bounded drain before and after stopping a non-pausable workflow/bash job. */
    readonly pauseDrainMs?: number;
}
export interface ResolvedConfig {
    readonly maxRounds: number;
    readonly maxDurationMs: number;
    readonly noProgressRounds: number;
    readonly busyEnterDefault: BusyEnterDefault;
    readonly ultraEffort: boolean;
    readonly ultraReminder: boolean;
    readonly fanoutLimit: number;
    readonly pauseTimeoutMs: number;
    readonly pauseDrainMs: number;
}
/** Resolve and validate the plugin configuration. */
export declare function resolveConfig(config?: PluginConfig): ResolvedConfig;
/** Resolve the effective round cap for one run. */
export declare function maxRoundsFor(skill: string, metadataMaxRounds: number | undefined, config: ResolvedConfig): number;
/** Resolve the effective elapsed-time cap for one run. */
export declare function maxDurationFor(skill: string, config: ResolvedConfig): number;
//# sourceMappingURL=config.d.ts.map