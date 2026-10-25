/**
 * Durable workflow capture, stop outcomes, and Play restart instructions.
 *
 * The workflow engine has no journal, so the saved state is the original
 * script (the plan), the job's retained output paths, and every member child
 * Session id. Play restarts from that state; it never claims a run-level
 * resume.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyChildPatch } from './pause-manifest.js'
import {
  backgroundJobLabel,
  workflowChildStopWarning,
  workflowLabel,
  workflowRestartWarning,
  workflowStopFailedWarning,
} from './pause-warnings.js'
import { workflowPlan, workflowRuns } from './state.js'
import type {
  PauseManifestEvent,
  PauseManifestJob,
  PauseManifestWorkflow,
} from './types.js'

/** The model-visible restart instruction Play delivered. */
export interface PauseRestart {
  readonly instruction: string
  readonly summary: string
}

/** Bound the saved plan so one manifest record cannot grow without limit. */
const MAX_PLAN_CHARS = 64_000
/** Bound the plan copied into a model-visible restart instruction. */
const MAX_RESTART_PLAN_CHARS = 20_000

function boundPlan(plan: string): string {
  if (plan.length <= MAX_PLAN_CHARS) return plan
  return `${plan.slice(0, MAX_PLAN_CHARS)}\n…[plan truncated; the full script remains in the session tool call]`
}

function restartPlan(workflow: PauseManifestWorkflow): string {
  if (workflow.plan === undefined) {
    return '(no saved plan was captured; reuse the original workflow script in this session)'
  }
  if (workflow.plan.length <= MAX_RESTART_PLAN_CHARS) return workflow.plan
  return `${workflow.plan.slice(0, MAX_RESTART_PLAN_CHARS)}\n…[plan truncated; the full script remains in the session tool call]`
}

/**
 * Capture the workflow runs recorded in this session. The workflow engine has
 * no journal, so the durable capture is the original script (the plan), the
 * job's retained output paths, and every member child Session id.
 */
export function collectPauseWorkflows(
  root: Agent,
  jobs: readonly PauseManifestJob[],
): PauseManifestWorkflow[] {
  const events = root.session.snapshotEvents()
  const assigned = new Set<string>()
  const workspace = root.session.header.cwd
  return workflowRuns(events).map(run => {
    const job = jobs.find(candidate =>
      candidate.kind === 'workflow'
      && candidate.label === run.name
      && !assigned.has(candidate.id))
    if (job !== undefined) assigned.add(job.id)
    const plan = workflowPlan(events, run.name)
    return {
      runId: run.runId,
      name: run.name,
      ...job === undefined ? {} : { jobId: job.id },
      childIds: [...run.childIds],
      ...plan === undefined ? {} : { plan: boundPlan(plan) },
      artifacts: job?.outputs === undefined ? [] : [...job.outputs],
      ...workspace === undefined ? {} : { workspace },
      state: run.finished ? 'finished' : 'running',
    }
  })
}

/** Merge the latest durable workflow member records into the manifest. */
export function refreshPauseWorkflows(manifest: PauseManifestEvent, root: Agent): void {
  const current = new Map((manifest.workflows ?? []).map(workflow => [workflow.runId, workflow]))
  const fresh = collectPauseWorkflows(root, manifest.jobs)
  manifest.workflows = fresh.map(run => {
    const existing = current.get(run.runId)
    if (existing === undefined) return run
    existing.name = run.name
    existing.childIds = run.childIds
    if (run.jobId !== undefined) existing.jobId = run.jobId
    if (run.plan !== undefined) existing.plan = run.plan
    existing.artifacts = run.artifacts
    if (run.workspace !== undefined) existing.workspace = run.workspace
    return existing
  })
}

/**
 * Fold job outcomes into the captured workflow runs and the member child
 * records. A stopped workflow disposes its children; they must be shown as
 * stopped and left to a workflow restart, never resumed individually. Returns
 * the child ids whose park latch must be forgotten.
 */
export function applyJobOutcomes(manifest: PauseManifestEvent): string[] {
  const workflows = manifest.workflows ?? []
  for (const workflow of workflows) {
    const jobs = manifest.jobs.filter(job =>
      job.kind === 'workflow'
      && (job.id === workflow.jobId
        || (workflow.jobId === undefined && job.label === workflow.name)))
    if (jobs.length === 0) continue
    if (jobs.some(job => job.disposition === 'stop-failed')) {
      workflow.state = 'stop-failed'
      workflow.warning = workflowStopFailedWarning(workflow, jobs)
    } else if (jobs.some(job =>
      job.disposition === 'stopped' || job.disposition === 'restart-required')) {
      workflow.state = 'stopped'
      workflow.warning = workflowRestartWarning(workflow)
    } else if (jobs.every(job => job.disposition === 'settled')) {
      workflow.state = 'settled'
      delete workflow.warning
    }
  }

  const stoppedChildren = new Set(
    workflows
      .filter(workflow => workflow.state === 'stopped')
      .flatMap(workflow => workflow.childIds),
  )
  if (stoppedChildren.size === 0) return []
  const forgotten: string[] = []
  manifest.children = manifest.children.map(child => {
    if (!stoppedChildren.has(child.id)) return child
    if (child.state === 'stopped' || child.state === 'restart-required') return child
    // The workflow job cancel aborts and disposes the parked child. The park
    // latch is not resumed; a workflow restart is the recovery path.
    forgotten.push(child.id)
    return applyChildPatch(child, {
      state: 'stopped',
      warning: workflowChildStopWarning(child),
    })
  })
  manifest.forced = manifest.children.filter(child => child.forced === true).length
  return forgotten
}

/** Mark stopped jobs/workflows as not auto-restarted after a user cancel. */
export function cancelStoppedWork(manifest: PauseManifestEvent): void {
  for (const job of manifest.jobs) {
    if (job.disposition === 'stopped' || job.disposition === 'restart-required') {
      job.disposition = 'cancelled'
      delete job.warning
    }
  }
  for (const workflow of manifest.workflows ?? []) {
    if (workflow.state === 'restart-required') workflow.state = 'stopped'
  }
}

/**
 * Turn every stopped job into a root restart instruction. Workflow work is
 * restarted from its saved plan, artifacts, and child checkpoints; bash work
 * has no checkpoint and is re-run only if still needed. A job that could not
 * be stopped is reported as a warning, never as a restart.
 */
export function preparePauseRestart(manifest: PauseManifestEvent): PauseRestart | undefined {
  const lines: string[] = []
  const summaries: string[] = []
  const coveredJobs = new Set<string>()
  for (const job of manifest.jobs) {
    if (job.disposition === 'stopped') job.disposition = 'restart-required'
  }
  for (const workflow of manifest.workflows ?? []) {
    if (workflow.jobId !== undefined) coveredJobs.add(workflow.jobId)
    if (workflow.state === 'stopped' || workflow.state === 'restart-required') {
      workflow.state = 'restart-required'
      workflow.warning = workflowRestartWarning(workflow)
      lines.push(workflowRestartInstruction(workflow))
      summaries.push(`Workflow "${workflow.name}" restarts from its saved plan; run-level resume is not available.`)
      continue
    }
    if (workflow.state === 'stop-failed') {
      lines.push(workflowStopFailedInstruction(workflow))
      summaries.push(`${workflowLabel(workflow)} could not be stopped; it may still be running.`)
    }
  }
  for (const job of manifest.jobs) {
    if (job.disposition === 'stop-failed') {
      lines.push(backgroundStopFailedInstruction(job))
      summaries.push(`${backgroundJobLabel(job)} could not be stopped and may still be running.`)
      continue
    }
    if (job.disposition !== 'restart-required' || coveredJobs.has(job.id)) continue
    if (job.kind === 'workflow') {
      lines.push(workflowJobRestartInstruction(job))
      summaries.push(`${backgroundJobLabel(job)} restarts from its saved plan; run-level resume is not available.`)
    } else {
      lines.push(backgroundRestartInstruction(job))
      summaries.push(`${backgroundJobLabel(job)} was stopped and will restart from its saved output; this is not a resume.`)
    }
  }
  if (lines.length === 0) return undefined
  return {
    instruction: [
      'Play resumed the root session. The following background work was stopped at pause. '
        + 'Restart it from the saved state below; this is not a run-level resume.',
      ...lines,
    ].join('\n'),
    summary: `${summaries.join(' ')} Run-level resume is not available.`,
  }
}

function workflowRestartInstruction(workflow: PauseManifestWorkflow): string {
  const job = workflow.jobId === undefined ? '' : `, job ${workflow.jobId}`
  const children = workflow.childIds.length === 0
    ? 'none recorded'
    : workflow.childIds.join(', ')
  const artifacts = workflow.artifacts.length === 0
    ? 'none recorded'
    : workflow.artifacts.join(', ')
  const workspace = workflow.workspace ?? 'the current workspace'
  return `- Workflow "${workflow.name}" (run ${workflow.runId}${job}) was stopped. `
    + `Restart it from this saved plan in ${workspace}:\n`
    + `<saved_workflow_plan>\n${restartPlan(workflow)}\n</saved_workflow_plan>\n`
    + `Reuse files already written and the captured output paths (${artifacts}); `
    + `inspect child checkpoints (${children}). This is a restart, not a run-level resume.`
}

function workflowJobRestartInstruction(job: PauseManifestJob): string {
  const artifacts = job.outputs === undefined || job.outputs.length === 0
    ? 'none recorded'
    : job.outputs.join(', ')
  return `- ${backgroundJobLabel(job)} was stopped. Restart its workflow from the saved plan `
    + `(the original workflow script in this session); captured output paths: ${artifacts}. `
    + 'This is a restart, not a run-level resume.'
}

function workflowStopFailedInstruction(workflow: PauseManifestWorkflow): string {
  return `- Workflow "${workflow.name}" (run ${workflow.runId}) could not be stopped; `
    + 'it may still be running. Check it before starting any replacement work.'
}

function backgroundRestartInstruction(job: PauseManifestJob): string {
  const artifacts = job.outputs === undefined || job.outputs.length === 0
    ? ''
    : ` Captured output paths: ${job.outputs.join(', ')}.`
  return `- ${backgroundJobLabel(job)} was stopped and has no checkpoint. `
    + `Re-run its command if it is still needed.${artifacts} This is a restart, not a resume.`
}

function backgroundStopFailedInstruction(job: PauseManifestJob): string {
  return `- ${backgroundJobLabel(job)} could not be stopped; it may still be running. `
    + 'Check it before restarting anything.'
}
