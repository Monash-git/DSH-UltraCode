/** Model- and user-visible labels and warnings for pause outcomes. */
import type { PauseManifestChild, PauseManifestJob, PauseManifestWorkflow } from './types.js';
/** The shared label for one child: its catalog label plus durable id. */
export declare function childLabel(child: PauseManifestChild): string;
export declare function workflowLabel(workflow: PauseManifestWorkflow): string;
export declare function workflowRestartWarning(workflow: PauseManifestWorkflow): string;
export declare function workflowStopFailedWarning(workflow: PauseManifestWorkflow, jobs: readonly PauseManifestJob[]): string;
export declare function workflowChildStopWarning(child: PauseManifestChild): string;
export declare function backgroundJobLabel(job: PauseManifestJob): string;
export declare function stoppedBashWarning(job: PauseManifestJob): string;
export declare function restartWarning(child: PauseManifestChild): string;
export declare function workflowWarning(child: PauseManifestChild): string;
//# sourceMappingURL=pause-warnings.d.ts.map