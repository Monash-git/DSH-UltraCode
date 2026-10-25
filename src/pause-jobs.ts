/**
 * Background-job capture, drain, and stop for a root pause.
 *
 * Workflow/bash/pwsh jobs have no pause primitive. Pause records what it can
 * and stops them after a bounded drain; a job that cannot be stopped is a
 * visible `stop-failed` outcome, never a paused or stopped claim.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  isLiveJobStatus,
  isTerminalJobStatus,
  type JobRegistryLike,
  type JobViewLike,
} from './state.js'
import { applyJobOutcomes, refreshPauseWorkflows } from './pause-workflows.js'
import { backgroundJobLabel, stoppedBashWarning } from './pause-warnings.js'
import type {
  PauseJobDisposition,
  PauseManifestEvent,
  PauseManifestJob,
} from './types.js'

/** Job kinds with no pause primitive; pause stops them or reports failure. */
const STOPPABLE_JOB_KINDS: ReadonlySet<string> = new Set(['workflow', 'bash', 'pwsh'])

function isStoppableKind(kind: string | undefined): boolean {
  return kind !== undefined && STOPPABLE_JOB_KINDS.has(kind)
}

function isBashKind(kind: string | undefined): boolean {
  return kind === 'bash' || kind === 'pwsh'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Capture every job owned by the root or one of its live descendants. */
export function collectPauseJobs(
  root: Agent,
  children: readonly Agent[],
  registry: JobRegistryLike | undefined,
): PauseManifestJob[] {
  if (registry === undefined) return []
  const record = (
    view: JobViewLike,
    ownerKind: 'root' | 'child',
    owner: string | undefined,
  ): PauseManifestJob | undefined => {
    if (view.id === undefined) return undefined
    const label = asString(view.label)
    const kind = asString(view.kind)
    const outputs = view.output?.spillPaths?.filter(
      (path): path is string => typeof path === 'string' && path !== '')
    return {
      id: String(view.id),
      ...kind === undefined ? {} : { kind },
      ...label === undefined ? {} : { label },
      ...owner === undefined ? {} : { owner },
      ownerKind,
      ...view.status === undefined ? {} : { status: view.status },
      ...outputs === undefined || outputs.length === 0 ? {} : { outputs: [...outputs] },
      disposition: isTerminalJobStatus(view.status) ? 'settled' : 'recorded',
    }
  }
  const result: PauseManifestJob[] = []
  const seen = new Set<string>()
  const add = (job: PauseManifestJob | undefined): void => {
    if (job === undefined || seen.has(job.id)) return
    seen.add(job.id)
    result.push(job)
  }
  const rootId = String(root.session.id)
  for (const view of registry.list(root.session.id)) {
    if (view.owner !== undefined && String(view.owner) !== rootId) continue
    add(record(view, 'root', view.owner === undefined ? undefined : rootId))
  }
  for (const child of children) {
    const childId = String(child.session.id)
    for (const view of registry.list(child.session.id)) {
      if (view.owner !== undefined && String(view.owner) !== childId) continue
      add(record(view, 'child', childId))
    }
  }
  return result
}

/** Merge jobs registered during the pause drain into the manifest. */
export function refreshPauseJobs(
  manifest: PauseManifestEvent,
  root: Agent,
  registry: JobRegistryLike | undefined,
  children: readonly Agent[],
): void {
  const current = new Map(manifest.jobs.map(job => [job.id, job]))
  for (const view of collectPauseJobs(root, children, registry)) {
    const existing = current.get(view.id)
    if (existing === undefined) {
      manifest.jobs.push(view)
      current.set(view.id, view)
      continue
    }
    // Never rewrite an outcome that was already applied to this job.
    if (existing.disposition !== 'recorded' && existing.disposition !== 'settled') continue
    // Optional fields must be deleted, not assigned `undefined`: plugin
    // records reject any non-JSON value, including an explicit undefined.
    if (view.kind === undefined) delete existing.kind
    else existing.kind = view.kind
    if (view.label === undefined) delete existing.label
    else existing.label = view.label
    if (view.owner === undefined) delete existing.owner
    else existing.owner = view.owner
    existing.ownerKind = view.ownerKind
    existing.status = view.status
    if (view.outputs === undefined) delete existing.outputs
    else existing.outputs = view.outputs
    existing.disposition = view.disposition
  }
}

/** Everything one stop pass needs; callbacks keep it independent of the coordinator. */
export interface PauseJobStopOptions {
  readonly root: Agent
  readonly manifest: PauseManifestEvent
  /** Live descendants, re-read immediately before the stop pass. */
  readonly children: readonly Agent[]
  readonly registry: JobRegistryLike | undefined
  readonly drainMs: number
  /** True when the plugin was disposed; nothing more can be recorded then. */
  readonly disposed: () => boolean
  /** Drop the park latch of a workflow child whose job was stopped. */
  readonly forgetChild: (childId: string) => void
}

/**
 * Stop every live workflow/bash/pwsh job after the child park drain. A job
 * that settles during the drain needs no kill; a job that cannot be stopped
 * is recorded as a visible failure and is never reported as paused/stopped.
 */
export async function stopPauseJobs(options: PauseJobStopOptions): Promise<void> {
  const { manifest, registry } = options
  if (registry === undefined) return
  // A running child can register a job between the initial snapshot and the
  // stop, and the workflow script can start a member in the same window.
  // Re-read both so no background work is left spending silently and the
  // saved plan captures every child id before the job is cancelled.
  refreshPauseJobs(manifest, options.root, registry, options.children)
  refreshPauseWorkflows(manifest, options.root)
  // Unowned jobs are not this session's background spend; record them but
  // never kill them from one root's pause.
  const targets = manifest.jobs.filter(job =>
    job.owner !== undefined
    && isStoppableKind(job.kind)
    && isLiveJobStatus(job.status))
  if (targets.length > 0) {
    const drained = await Promise.all(targets.map(job =>
      waitJobView(registry, job, options.drainMs)))
    if (options.disposed()) return
    const pending: PauseManifestJob[] = []
    targets.forEach((job, index) => {
      const view = drained[index]
      if (view !== undefined && isTerminalJobStatus(view.status)) {
        settleJob(job, view, 'settled')
      } else {
        pending.push(job)
      }
    })
    await Promise.all(pending.map(job => stopJob(registry, job, options.drainMs)))
    if (options.disposed()) return
  }
  for (const childId of applyJobOutcomes(manifest)) options.forgetChild(childId)
}

/** Request one job kill, then confirm a terminal state within the drain bound. */
async function stopJob(
  registry: JobRegistryLike,
  job: PauseManifestJob,
  drainMs: number,
): Promise<void> {
  try {
    if (registry.kill === undefined) throw new Error('the host has no job stop API')
    const result = registry.kill(job.id, job.owner, 'paused by user')
    if (result === 'already-finished') {
      const view = await waitJobView(registry, job, drainMs)
      if (view !== undefined && isTerminalJobStatus(view.status)) {
        settleJob(job, view, 'settled')
      } else {
        failJob(job, 'could not be confirmed stopped')
      }
      return
    }
  } catch (error: unknown) {
    failJob(job, `could not be stopped: ${errorMessage(error)}`)
    return
  }
  const view = await waitJobView(registry, job, drainMs)
  if (view !== undefined && isTerminalJobStatus(view.status)) {
    settleJob(job, view, 'stopped')
    return
  }
  const status = view?.status ?? 'unknown'
  failJob(job, `did not stop within ${drainMs} ms (status: ${status})`)
}

async function waitJobView(
  registry: JobRegistryLike,
  job: PauseManifestJob,
  timeoutMs: number,
): Promise<JobViewLike | undefined> {
  if (registry.wait === undefined) return undefined
  try {
    return await registry.wait(job.id, timeoutMs, job.owner)
  } catch {
    return undefined
  }
}

function settleJob(
  job: PauseManifestJob,
  view: JobViewLike,
  disposition: PauseJobDisposition,
): void {
  job.status = view.status
  const kind = asString(view.kind)
  if (kind !== undefined) job.kind = kind
  const label = asString(view.label)
  if (label !== undefined) job.label = label
  const outputs = view.output?.spillPaths?.filter(
    (path): path is string => typeof path === 'string' && path !== '')
  if (outputs !== undefined && outputs.length > 0) job.outputs = [...outputs]
  delete job.warning
  if (disposition === 'stopped') {
    job.stoppedAt = Date.now()
    if (isBashKind(job.kind)) job.warning = stoppedBashWarning(job)
  }
  job.disposition = disposition
}

function failJob(job: PauseManifestJob, reason: string): void {
  job.disposition = 'stop-failed'
  job.warning = `${backgroundJobLabel(job)} ${reason}. `
    + 'It may still be running and spending; stop it manually.'
}
