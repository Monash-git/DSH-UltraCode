/** Model- and user-visible labels and warnings for pause outcomes. */

import type { PauseManifestChild, PauseManifestJob, PauseManifestWorkflow } from './types.js'

/** The shared label for one child: its catalog label plus durable id. */
export function childLabel(child: PauseManifestChild): string {
  return child.label === undefined ? child.id : `${child.label} (${child.id})`
}

export function workflowLabel(workflow: PauseManifestWorkflow): string {
  return `Workflow "${workflow.name}" (run ${workflow.runId})`
}

export function workflowRestartWarning(workflow: PauseManifestWorkflow): string {
  return `${workflowLabel(workflow)} was stopped with its job; restart its workflow from the saved plan and artifacts. `
    + 'Run-level resume is not available.'
}

export function workflowStopFailedWarning(
  workflow: PauseManifestWorkflow,
  jobs: readonly PauseManifestJob[],
): string {
  const ids = jobs.map(job => job.id).join(', ')
  return `${workflowLabel(workflow)} could not be stopped (job ${ids}); it may still be running and spending.`
}

export function workflowChildStopWarning(child: PauseManifestChild): string {
  return `Workflow subagent ${childLabel(child)} was stopped with its workflow job; restart its workflow from the saved plan and artifacts.`
}

export function backgroundJobLabel(job: PauseManifestJob): string {
  const suffix = job.label === undefined ? '' : ` (${job.label})`
  return `Background ${job.kind ?? 'background'} job ${job.id}${suffix}`
}

export function stoppedBashWarning(job: PauseManifestJob): string {
  return `${backgroundJobLabel(job)} was stopped at pause and has no checkpoint; `
    + 'Play will restart it. This is a restart, not a resume.'
}

export function restartWarning(child: PauseManifestChild): string {
  return `Subagent ${childLabel(child)} could not be resumed; restart it from its checkpoint.`
}

export function workflowWarning(child: PauseManifestChild): string {
  return `Workflow subagent ${childLabel(child)} is job-owned; restart its workflow from the saved plan or checkpoint.`
}
