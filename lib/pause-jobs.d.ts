/**
 * Background-job capture, drain, and stop for a root pause.
 *
 * Workflow/bash/pwsh jobs have no pause primitive. Pause records what it can
 * and stops them after a bounded drain; a job that cannot be stopped is a
 * visible `stop-failed` outcome, never a paused or stopped claim.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type JobRegistryLike } from './state.js';
import type { PauseManifestEvent, PauseManifestJob } from './types.js';
/** Capture every job owned by the root or one of its live descendants. */
export declare function collectPauseJobs(root: Agent, children: readonly Agent[], registry: JobRegistryLike | undefined): PauseManifestJob[];
/** Merge jobs registered during the pause drain into the manifest. */
export declare function refreshPauseJobs(manifest: PauseManifestEvent, root: Agent, registry: JobRegistryLike | undefined, children: readonly Agent[]): void;
/** Everything one stop pass needs; callbacks keep it independent of the coordinator. */
export interface PauseJobStopOptions {
    readonly root: Agent;
    readonly manifest: PauseManifestEvent;
    /** Live descendants, re-read immediately before the stop pass. */
    readonly children: readonly Agent[];
    readonly registry: JobRegistryLike | undefined;
    readonly drainMs: number;
    /** True when the plugin was disposed; nothing more can be recorded then. */
    readonly disposed: () => boolean;
    /** Drop the park latch of a workflow child whose job was stopped. */
    readonly forgetChild: (childId: string) => void;
}
/**
 * Stop every live workflow/bash/pwsh job after the child park drain. A job
 * that settles during the drain needs no kill; a job that cannot be stopped
 * is recorded as a visible failure and is never reported as paused/stopped.
 */
export declare function stopPauseJobs(options: PauseJobStopOptions): Promise<void>;
//# sourceMappingURL=pause-jobs.d.ts.map