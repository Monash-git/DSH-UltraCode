/**
 * Durable workflow capture, stop outcomes, and Play restart instructions.
 *
 * The workflow engine has no journal, so the saved state is the original
 * script (the plan), the job's retained output paths, and every member child
 * Session id. Play restarts from that state; it never claims a run-level
 * resume.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PauseManifestEvent, PauseManifestJob, PauseManifestWorkflow } from './types.js';
/** The model-visible restart instruction Play delivered. */
export interface PauseRestart {
    readonly instruction: string;
    readonly summary: string;
}
/**
 * Capture the workflow runs recorded in this session. The workflow engine has
 * no journal, so the durable capture is the original script (the plan), the
 * job's retained output paths, and every member child Session id.
 */
export declare function collectPauseWorkflows(root: Agent, jobs: readonly PauseManifestJob[]): PauseManifestWorkflow[];
/** Merge the latest durable workflow member records into the manifest. */
export declare function refreshPauseWorkflows(manifest: PauseManifestEvent, root: Agent): void;
/**
 * Fold job outcomes into the captured workflow runs and the member child
 * records. A stopped workflow disposes its children; they must be shown as
 * stopped and left to a workflow restart, never resumed individually. Returns
 * the child ids whose park latch must be forgotten.
 */
export declare function applyJobOutcomes(manifest: PauseManifestEvent): string[];
/** Mark stopped jobs/workflows as not auto-restarted after a user cancel. */
export declare function cancelStoppedWork(manifest: PauseManifestEvent): void;
/**
 * Turn every stopped job into a root restart instruction. Workflow work is
 * restarted from its saved plan, artifacts, and child checkpoints; bash work
 * has no checkpoint and is re-run only if still needed. A job that could not
 * be stopped is reported as a warning, never as a restart.
 */
export declare function preparePauseRestart(manifest: PauseManifestEvent): PauseRestart | undefined;
//# sourceMappingURL=pause-workflows.d.ts.map