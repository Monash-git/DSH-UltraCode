/**
 * Root-mediated pause coordinator for local subagents.
 *
 * The root owns the durable manifest. Pause discovers live local descendants
 * by durable lineage, sends each running child a host pause control, and
 * waits a bounded time for the child's pre-step gate to acknowledge with a
 * flushed checkpoint. Children that do not acknowledge are stopped with the
 * existing interrupt/cancel path and marked forced. Play releases parked
 * children in place, warm-resumes resident children that were stopped, and
 * cold-resumes disposed children through `ctx.subagents`; when cold resume is
 * unavailable, the manifest carries an explicit restart-from-checkpoint
 * warning. Nothing releases a child without Play or an explicit user message.
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  ParkGate,
  isPauseControlMessage,
  pauseControlMessage,
  pauseResumeMessage,
  type ParkAcknowledgement,
  type ParkEntry,
} from './park.js'
import {
  appendCheckpointEvent,
  appendPauseManifest,
  catalogChildren,
  lastSeq,
  latestAssistantText,
  latestPauseManifest,
  latestTodos,
  openTurn,
  workflowChildIds,
  workflowPlan,
  workflowRuns,
  type JobRegistryLike,
  type JobViewLike,
} from './state.js'
import type {
  PauseChildState,
  PauseJobDisposition,
  PauseManifestChild,
  PauseManifestEvent,
  PauseManifestJob,
  PauseManifestWorkflow,
} from './types.js'

/** The subset of the live Agent registry used for lineage discovery. */
export interface LiveAgentRegistryLike {
  list(): readonly Agent[]
  get(id: Agent['id']): Agent | undefined
}

/** The subset of the session store used for durability barriers. */
export interface SessionStoreLike {
  flush(session: Session): Promise<boolean>
}

/** One recursive catalog row, loosely typed so the plugin needs no hard dependency. */
export interface SubagentRowLike {
  readonly kind?: string
  readonly id?: unknown
  readonly mode?: unknown
  readonly label?: unknown
}

/** The optional `ctx.subagents` surface used for discovery and cold resume. */
export interface SubagentServiceLike {
  listDescendants?(
    rootSessionId: Agent['session']['id'],
    signal?: AbortSignal,
  ): Promise<readonly SubagentRowLike[]>
  sendMessage?(
    sender: Agent,
    targetId: Agent['session']['id'],
    content: readonly ContentBlock[],
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>
  interrupt?(
    targetSessionId: Agent['session']['id'],
    authority: { readonly kind: 'ancestor'; readonly agent: Agent },
  ): void
}

/** Everything the coordinator reads from the host composition. */
export interface PauseCoordinatorDeps {
  readonly timeoutMs: number
  /** Bounded drain before and after stopping a non-pausable job. */
  readonly drainMs: number
  readonly agents?: () => LiveAgentRegistryLike | undefined
  readonly subagents?: () => SubagentServiceLike | undefined
  readonly sessions?: () => SessionStoreLike | undefined
  readonly jobs?: () => JobRegistryLike | undefined
}

/** The minimal `agent/pre-step` payload the gate consumes. */
export interface PausePreStepPayload {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Why the root released its children. */
export type PauseReleaseMode = 'resume' | 'cancel'

/** The restart instruction Play sent to the root after stopping background work. */
export interface PauseRestart {
  readonly instruction: string
  readonly summary: string
}

/** What one release did to the manifest. */
export interface PauseReleaseResult {
  readonly children: readonly PauseManifestChild[]
  readonly warnings: readonly string[]
  readonly restart?: PauseRestart
}

interface ActivePause {
  readonly root: Agent
  readonly pauseId: string
  readonly manifest: PauseManifestEvent
  released: boolean
}

type JobView = JobViewLike

/** Coordinate one root's pause across its live local descendants. */
export class PauseCoordinator {
  private readonly gate = new ParkGate()
  private readonly active = new Map<string, ActivePause>()
  private disposed = false

  constructor(private readonly deps: PauseCoordinatorDeps) {}

  /**
   * Start a pause: checkpoint the root, record the manifest, and park every
   * live local descendant. Acknowledgment waits are bounded by `timeoutMs`.
   */
  async begin(root: Agent, pauseId: string): Promise<void> {
    const rootKey = String(root.session.id)
    if (this.disposed || this.active.has(rootKey)) return

    const live = this.liveChildren(root)
    const events = root.session.snapshotEvents()
    const catalog = catalogChildren(events)
    const workflowChildren = workflowChildIds(events)
    const children = live.map(child => {
      const id = String(child.id)
      const catalogRow = catalog.get(id)
      return {
        id,
        ...catalogRow?.label === undefined ? {} : { label: catalogRow.label },
        mode: catalogRow?.mode ?? 'unknown',
        ...workflowChildren.has(id) ? { workflow: true } : {},
        state: child.status === 'running' ? 'pausing' as const : 'idle' as const,
        forced: false,
      }
    })
    const jobs = this.collectJobs(root, live)
    const manifest: PauseManifestEvent = {
      pauseId,
      rootId: rootKey,
      phase: 'pausing',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs: this.deps.timeoutMs,
      children,
      jobs,
      workflows: this.collectWorkflows(root, jobs),
      forced: 0,
    }
    const active: ActivePause = { root, pauseId, manifest, released: false }
    this.active.set(rootKey, active)

    // Record the pausing phase synchronously before any slow discovery or
    // durability barrier, so the primary control can show progress at once.
    await this.write(root, manifest)
    if (active.released || this.disposed) return

    // Catalog discovery is an enrichment: it names deeper children and can
    // replace a missing root-catalog label, but never adds park targets.
    const rows = await this.rowsById(root)
    if (active.released || this.disposed) return
    let enriched = false
    manifest.children = manifest.children.map(child => {
      const row = rows.get(child.id)
      const label = asString(row?.label)
      const mode = asString(row?.mode)
      if (label === undefined && mode === undefined) return child
      if (label === child.label && mode === child.mode) return child
      enriched = true
      return {
        ...child,
        ...label === undefined ? {} : { label },
        ...mode === undefined ? {} : { mode },
      }
    })
    if (enriched) await this.write(root, manifest)

    try {
      await this.checkpointRoot(root, pauseId, manifest)
    } catch {
      // The manifest itself is the durable pause record; a root checkpoint
      // failure must not prevent the children from being parked.
    }
    if (active.released || this.disposed) return
    await this.write(root, manifest)
    if (active.released || this.disposed) return

    const entries = new Map<string, ParkEntry>()
    for (const child of live) {
      const record = manifest.children.find(candidate => candidate.id === String(child.id))
      if (record?.state !== 'pausing' || active.released || this.disposed) continue
      const entry = this.gate.request(String(child.id), pauseId)
      entries.set(String(child.id), entry)
      try {
        child.steer(pauseControlMessage(pauseId))
      } catch {
        this.gate.forget(String(child.id))
        entries.delete(String(child.id))
        this.updateChild(active, String(child.id), { state: 'disposed' })
      }
      entry.acknowledged.then(ack => {
        if (!this.stillPausing(active, String(child.id))) return
        this.updateChild(active, String(child.id), {
          state: 'parked',
          acknowledgedAt: ack.checkpointAt,
          checkpointAt: ack.checkpointAt,
          checkpointSeq: ack.checkpointSeq,
        })
        void this.write(root, active.manifest)
      }).catch(() => undefined)
    }
    await this.write(root, manifest)

    await this.waitForAcknowledgements(entries)
    if (active.released || this.disposed || this.active.get(rootKey) !== active) return

    for (const [childId, entry] of entries) {
      if (!this.stillPausing(active, childId)) continue
      const child = this.liveChild(root, childId)
      await this.forceChild(active, childId, child)
      this.gate.forget(childId)
      entry.release('abort')
    }

    if (active.released || this.disposed || this.active.get(rootKey) !== active) return
    // Workflow and bash work has no pause primitive. The child park/force
    // step above is the drain: once every live child has reached a checkpoint
    // (or been stopped), stop the job rather than leave it spending silently.
    await this.stopJobs(active)
    if (active.released || this.disposed || this.active.get(rootKey) !== active) return
    this.refreshWarning(manifest)
    manifest.phase = 'paused'
    await this.write(root, manifest)
  }

  /**
   * Consume pause controls at any pre-step. A child with an active request
   * flushes, records a checkpoint, acknowledges, then parks until release;
   * a stale control is dropped so it can never reach a model.
   */
  async onPreStep(
    payload: PausePreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const controls = payload.messages.filter(isPauseControlMessage)
    const childId = String(payload.agent.id)
    const entry = this.gate.get(childId)
    const controlPauseId = controls
      .map(message => message.source.kind === 'ultracode' ? message.source.pauseId : undefined)
      .find(value => value !== undefined)
    const matches = entry !== undefined
      && (controlPauseId === undefined || controlPauseId === entry.pauseId)
    if (matches) {
      // Park before prompt assembly and downstream pre-step work: the child
      // must not prepare a model request it cannot send until Play. Blocking
      // here also keeps its turn open, so workflow results stay pending.
      const ack = await this.checkpointChild(payload.agent, entry.pauseId, payload.turn, payload.step, false)
      entry.acknowledge(ack)
      await entry.wait(payload.signal)
    }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const visible = decision.messages.filter(message => !isPauseControlMessage(message))
    return visible.length === decision.messages.length
      ? decision
      : { ...decision, messages: visible }
  }

  /**
   * Release every manifest child. `resume` releases parked turns in place,
   * warm-resumes resident children, and cold-resumes disposed children when
   * the subagent service can; `cancel` only releases parked turns and stops
   * the manifest without starting any new work.
   */
  async release(root: Agent, mode: PauseReleaseMode): Promise<PauseReleaseResult> {
    const rootKey = String(root.session.id)
    const active = this.active.get(rootKey)
    const manifest = active?.manifest ?? latestPauseManifest(root.session.snapshotEvents())
    if (manifest === undefined || manifest.phase === 'resumed' || manifest.phase === 'cancelled') {
      return { children: manifest?.children ?? [], warnings: [] }
    }
    if (active !== undefined) active.released = true
    manifest.phase = 'resuming'
    await this.write(root, manifest)

    const live = new Map(this.liveChildren(root).map(child => [String(child.id), child]))
    for (const record of [...manifest.children]) {
      // A workflow member stopped with its job is never re-driven on its own:
      // the saved plan/artifacts are the restart path, not a child resume.
      if (record.state === 'stopped' || record.state === 'restart-required') {
        this.setChildState(manifest, active, record.id, {
          state: mode === 'cancel' ? 'cancelled' : 'restart-required',
          warning: mode === 'cancel' ? undefined : workflowChildStopWarning(record),
        })
        continue
      }
      const entry = this.gate.get(record.id)
      if (entry !== undefined) {
        this.gate.release(record.id, 'resume')
        this.updateChild(active, record.id, {
          state: mode === 'cancel' ? 'cancelled' : 'resumed',
          warning: undefined,
        })
        continue
      }
      const child = live.get(record.id)
      if (child !== undefined) {
        if (mode === 'cancel') continue
        if (record.workflow === true) {
          // A workflow member is owned by its run, and a normal turn can
          // become that item's result. Never steer it on Play; only the
          // workflow restart from the saved plan may recreate the work.
          this.updateChild(active, record.id, {
            state: 'restart-required',
            warning: workflowWarning(record),
          })
          continue
        }
        try {
          child.steer(pauseResumeMessage())
          this.updateChild(active, record.id, { state: 'resumed', warning: undefined })
        } catch {
          this.updateChild(active, record.id, {
            state: 'restarted',
            warning: restartWarning(record),
          })
        }
        continue
      }
      if (mode === 'cancel') {
        this.updateChild(active, record.id, { state: 'cancelled' })
        continue
      }
      if (record.workflow === true) {
        this.updateChild(active, record.id, {
          state: 'unavailable',
          warning: workflowWarning(record),
        })
        continue
      }
      const resumed = await this.coldResume(root, record)
      this.updateChild(active, record.id, resumed
        ? { state: 'cold-resumed', warning: undefined }
        : { state: 'restarted', warning: restartWarning(record) })
    }

    let restart: PauseRestart | undefined
    let instructionWarning: string | undefined
    if (mode === 'cancel') {
      this.cancelStoppedJobs(manifest)
    } else {
      restart = this.prepareRestart(manifest)
      if (restart !== undefined) {
        try {
          // The root restarts workflow/bash work from the saved plan; children
          // never receive a "finish" message. This is a restart instruction,
          // not a run-level resume claim. Inject rather than steer: the pause
          // is still active, and the resume nudge must wake one batch that
          // includes this instruction instead of opening a separate turn.
          root.inject(createUserMessage({
            content: [{ type: 'text', text: restart.instruction }],
            source: {
              kind: 'ultracode',
              form: 'notice',
              summary: 'restart stopped background work',
            },
          }))
          manifest.restartInstruction = restart.instruction
        } catch (error: unknown) {
          instructionWarning = `Unable to send the restart instruction: ${errorMessage(error)}`
        }
      }
    }

    manifest.phase = mode === 'cancel' ? 'cancelled' : 'resumed'
    this.refreshWarning(manifest, instructionWarning === undefined ? [] : [instructionWarning])
    const warnings = this.manifestWarnings(manifest)
    await this.write(root, manifest)
    if (active !== undefined) this.active.delete(rootKey)
    return {
      children: manifest.children,
      warnings,
      ...restart === undefined ? {} : { restart },
    }
  }

  /** Mark stopped jobs/workflows as not auto-restarted after a user cancel. */
  private cancelStoppedJobs(manifest: PauseManifestEvent): void {
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
   * restarted from its saved plan, artifacts, and child checkpoints; bash
   * work has no checkpoint and is re-run only if still needed. A job that
   * could not be stopped is reported as a warning, never as a restart.
   */
  private prepareRestart(manifest: PauseManifestEvent): PauseRestart | undefined {
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

  /** Patch one child record in the live manifest even after a hot reload. */
  private setChildState(
    manifest: PauseManifestEvent,
    active: ActivePause | undefined,
    childId: string,
    patch: Partial<PauseManifestChild> & { state: PauseChildState },
  ): void {
    if (active === undefined) {
      manifest.children = manifest.children.map(child => {
        if (child.id !== childId) return child
        const next = { ...child }
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete (next as Record<string, unknown>)[key]
          else (next as Record<string, unknown>)[key] = value
        }
        return next
      })
      return
    }
    this.updateChild(active, childId, patch)
  }

  /** Release and forget everything owned by one root session. */
  disposeRoot(rootId: string): void {
    const active = this.active.get(rootId)
    if (active !== undefined) {
      active.released = true
      for (const child of active.manifest.children) this.gate.release(child.id, 'abort')
    }
    this.active.delete(rootId)
  }

  /** Unblock and forget one disposed child's park request. */
  abortChild(childId: string): void {
    this.gate.release(childId, 'abort')
  }

  /**
   * Stop every park wait on plugin unload so no child turn hangs forever.
   * A reload must not resume paused work: live parked children are cancelled
   * through the normal interrupt path (preserving their inbox), and any
   * not-yet-parked request is aborted. The durable pause record and manifest
   * still say paused; the reloaded instance can Play-release (warm-resume)
   * the children or report them.
   */
  dispose(): void {
    this.disposed = true
    for (const active of this.active.values()) {
      active.released = true
      for (const record of active.manifest.children) {
        const child = this.liveChild(active.root, record.id)
        if (child === undefined) continue
        try {
          child.cancel({ kind: 'parent' }, { keepInbox: true })
        } catch {
          // A child already leaving cannot be stopped again.
        }
      }
    }
    this.active.clear()
    this.gate.dispose('abort')
  }

  /** Live descendants by durable lineage (`origin: subagent`), direct or deeper. */
  private liveChildren(root: Agent): Agent[] {
    const registry = this.deps.agents?.()
    if (registry === undefined) return []
    const byParent = new Map<string, Agent[]>()
    for (const agent of registry.list()) {
      const { parentSession, origin } = agent.session.header
      if (parentSession === undefined || origin !== 'subagent') continue
      const siblings = byParent.get(String(parentSession)) ?? []
      siblings.push(agent)
      byParent.set(String(parentSession), siblings)
    }
    const result: Agent[] = []
    const pending = [String(root.session.id)]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const parentId = pending.shift() as string
      if (visited.has(parentId)) continue
      visited.add(parentId)
      for (const child of byParent.get(parentId) ?? []) {
        result.push(child)
        pending.push(String(child.id))
      }
    }
    return result
  }

  private liveChild(root: Agent, childId: string): Agent | undefined {
    return this.liveChildren(root).find(child => String(child.id) === childId)
  }

  private async rowsById(root: Agent): Promise<Map<string, SubagentRowLike>> {
    const result = new Map<string, SubagentRowLike>()
    const service = this.deps.subagents?.()
    if (service?.listDescendants === undefined) return result
    try {
      // Discovery is an enrichment. Never let a slow session catalog keep the
      // root from reaching its children's park points.
      const rows = await Promise.race([
        service.listDescendants(root.session.id, AbortSignal.timeout(2_000)),
        new Promise<readonly SubagentRowLike[]>(resolve => {
          setTimeout(() => resolve([]), 2_000).unref?.()
        }),
      ])
      for (const row of rows) {
        if (row.kind === 'diagnostic' || row.id === undefined) continue
        result.set(String(row.id), row)
      }
    } catch {
      // Catalog discovery is an enrichment, not a requirement.
    }
    return result
  }

  private collectJobs(root: Agent, children: readonly Agent[]): PauseManifestJob[] {
    const jobs = this.deps.jobs?.()
    if (jobs === undefined) return []
    const record = (
      view: JobView,
      ownerKind: 'root' | 'child',
      owner: string | undefined,
    ): PauseManifestJob | undefined => {
      if (view.id === undefined) return undefined
      const label = asString(view.label)
      const outputs = view.output?.spillPaths?.filter(
        (path): path is string => typeof path === 'string' && path !== '')
      return {
        id: String(view.id),
        ...asString(view.kind) === undefined ? {} : { kind: asString(view.kind) },
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
    for (const view of jobs.list(root.session.id) as readonly JobView[]) {
      if (view.owner !== undefined && String(view.owner) !== rootId) continue
      add(record(view, 'root', view.owner === undefined ? undefined : rootId))
    }
    for (const child of children) {
      const childId = String(child.session.id)
      for (const view of jobs.list(child.session.id) as readonly JobView[]) {
        if (view.owner !== undefined && String(view.owner) !== childId) continue
        add(record(view, 'child', childId))
      }
    }
    return result
  }

  /**
   * Capture the workflow runs recorded in this session. The workflow engine
   * has no journal, so the durable capture is the original script (the plan),
   * the job's retained output paths, and every member child Session id.
   */
  private collectWorkflows(
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

  /**
   * Stop every live workflow/bash job after the child park drain. A job that
   * settles during the drain needs no kill; a job that cannot be stopped is
   * recorded as a visible failure and is never reported as paused/stopped.
   */
  private async stopJobs(active: ActivePause): Promise<void> {
    const registry = this.deps.jobs?.()
    if (registry === undefined) return
    // A running child can register a job between the initial snapshot and the
    // stop, and the workflow script can start a member in the same window.
    // Re-read both so no background work is left spending silently and the
    // saved plan captures every child id before the job is cancelled.
    this.refreshJobs(active)
    this.refreshWorkflows(active)
    // Unowned jobs are not this session's background spend; record them but
    // never kill them from one root's pause.
    const targets = active.manifest.jobs.filter(job =>
      job.owner !== undefined
      && isStoppableKind(job.kind)
      && isLiveJobStatus(job.status))
    if (targets.length > 0) {
      const drained = await Promise.all(targets.map(job =>
        this.waitJobView(registry, job, this.deps.drainMs)))
      if (active.released || this.disposed) return
      const pending: PauseManifestJob[] = []
      targets.forEach((job, index) => {
        const view = drained[index]
        if (view !== undefined && isTerminalJobStatus(view.status)) {
          this.settleJob(job, view, 'settled')
        } else {
          pending.push(job)
        }
      })
      await Promise.all(pending.map(job => this.stopJob(registry, job)))
      if (active.released || this.disposed) return
    }
    this.applyJobOutcomes(active)
  }

  /** Merge jobs registered during the pause drain into the manifest. */
  private refreshJobs(active: ActivePause): void {
    const manifest = active.manifest
    const current = new Map(manifest.jobs.map(job => [job.id, job]))
    for (const view of this.collectJobs(active.root, this.liveChildren(active.root))) {
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

  /** Merge the latest durable workflow member records into the manifest. */
  private refreshWorkflows(active: ActivePause): void {
    const manifest = active.manifest
    const current = new Map((manifest.workflows ?? []).map(workflow => [workflow.runId, workflow]))
    const fresh = this.collectWorkflows(active.root, manifest.jobs)
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

  /** Request one job kill, then confirm a terminal state within the drain bound. */
  private async stopJob(registry: JobRegistryLike, job: PauseManifestJob): Promise<void> {
    try {
      if (registry.kill === undefined) throw new Error('the host has no job stop API')
      const result = registry.kill(job.id, job.owner, 'paused by user')
      if (result === 'already-finished') {
        const view = await this.waitJobView(registry, job, this.deps.drainMs)
        if (view !== undefined && isTerminalJobStatus(view.status)) {
          this.settleJob(job, view, 'settled')
        } else {
          this.failJob(job, 'could not be confirmed stopped')
        }
        return
      }
    } catch (error: unknown) {
      this.failJob(job, `could not be stopped: ${errorMessage(error)}`)
      return
    }
    const view = await this.waitJobView(registry, job, this.deps.drainMs)
    if (view !== undefined && isTerminalJobStatus(view.status)) {
      this.settleJob(job, view, 'stopped')
      return
    }
    const status = view?.status ?? 'unknown'
    this.failJob(job, `did not stop within ${this.deps.drainMs} ms (status: ${status})`)
  }

  private async waitJobView(
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

  private settleJob(
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

  private failJob(job: PauseManifestJob, reason: string): void {
    job.disposition = 'stop-failed'
    const label = job.label === undefined ? '' : ` (${job.label})`
    job.warning = `Background ${job.kind ?? 'background'} job ${job.id}${label} ${reason}. `
      + 'It may still be running and spending; stop it manually.'
  }

  /**
   * Fold job outcomes into the captured workflow runs and the member child
   * records. A stopped workflow disposes its children; they must be shown as
   * stopped and left to a workflow restart, never as resumed individually.
   */
  private applyJobOutcomes(active: ActivePause): void {
    const manifest = active.manifest
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
    if (stoppedChildren.size === 0) return
    manifest.children = manifest.children.map(child => {
      if (!stoppedChildren.has(child.id)) return child
      if (child.state === 'stopped' || child.state === 'restart-required') return child
      // The workflow job cancel aborts and disposes the parked child. The
      // park latch is not resumed; a workflow restart is the recovery path.
      this.gate.forget(child.id)
      return {
        ...child,
        state: 'stopped',
        warning: workflowChildStopWarning(child),
      }
    })
  }

  /** Recompute the single manifest warning from children, jobs, and workflows. */
  private refreshWarning(manifest: PauseManifestEvent, extra: readonly string[] = []): void {
    const unique = [...new Set([...this.manifestWarnings(manifest), ...extra])]
    if (unique.length === 0) delete manifest.warning
    else manifest.warning = unique.join(' ')
  }

  /** Every visible warning carried by the manifest. */
  private manifestWarnings(manifest: PauseManifestEvent): string[] {
    return [
      ...(manifest.restoredWarning === undefined ? [] : [manifest.restoredWarning]),
      ...manifest.children.map(child => child.warning),
      ...manifest.jobs.map(job => job.warning),
      ...(manifest.workflows ?? []).map(workflow => workflow.warning),
    ].filter((value): value is string => value !== undefined && value !== '')
  }

  private async checkpointRoot(
    root: Agent,
    pauseId: string,
    manifest: PauseManifestEvent,
  ): Promise<void> {
    const checkpoint = await this.checkpointChild(root, pauseId, openTurn(root), 0, false, true)
    manifest.rootCheckpointAt = checkpoint.checkpointAt
    manifest.rootCheckpointSeq = checkpoint.checkpointSeq
  }

  private async checkpointChild(
    agent: Agent,
    pauseId: string,
    turn: number,
    step: number,
    forced: boolean,
    root = false,
  ): Promise<ParkAcknowledgement> {
    await this.flush(agent.session)
    const atSeq = lastSeq(agent)
    const at = Date.now()
    const todos = latestTodos(agent)
    const text = latestAssistantText(agent)
    const checkpointSeq = appendCheckpointEvent(agent, {
      pauseId,
      childId: root ? String(agent.session.id) : String(agent.id),
      turn,
      step,
      atSeq,
      at,
      forced,
      ...todos === undefined ? {} : { todos },
      ...text === '' ? {} : { lastAssistantText: text.slice(0, 2_000) },
    })
    await this.flush(agent.session)
    return { pauseId, checkpointAt: at, checkpointSeq }
  }

  private async forceChild(
    active: ActivePause,
    childId: string,
    child: Agent | undefined,
  ): Promise<void> {
    if (active.released || this.disposed) return
    if (child !== undefined) {
      try {
        await this.checkpointChild(child, active.pauseId, openTurn(child), 0, true)
      } catch {
        // A child whose log is already closing is still stopped and marked
        // forced; the root manifest remains the durable record of the pause.
      }
      const service = this.deps.subagents?.()
      try {
        if (service?.interrupt !== undefined) {
          service.interrupt(child.session.id, { kind: 'ancestor', agent: active.root })
        } else {
          child.cancel({ kind: 'parent' }, { keepInbox: true })
        }
      } catch {
        try {
          child.cancel({ kind: 'parent' }, { keepInbox: true })
        } catch {
          // A child already leaving cannot be stopped again.
        }
      }
    }
    if (active.released || this.disposed) return
    this.updateChild(active, childId, { state: 'forced', forced: true })
    await this.write(active.root, active.manifest)
  }

  private async waitForAcknowledgements(entries: ReadonlyMap<string, ParkEntry>): Promise<void> {
    if (entries.size === 0) return
    await new Promise<void>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, this.deps.timeoutMs)
      void Promise.all([...entries.values()].map(entry => entry.acknowledged)).then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }, () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async coldResume(root: Agent, child: PauseManifestChild): Promise<boolean> {
    const service = this.deps.subagents?.()
    if (service?.sendMessage === undefined) return false
    try {
      const message = pauseResumeMessage()
      await service.sendMessage(
        root,
        SessionId(child.id),
        message.content,
        { signal: new AbortController().signal },
      )
      return true
    } catch {
      return false
    }
  }

  private stillPausing(active: ActivePause, childId: string): boolean {
    if (active.released || this.disposed) return false
    return active.manifest.children.some(child => child.id === childId && child.state === 'pausing')
  }

  private updateChild(
    active: ActivePause | undefined,
    childId: string,
    patch: Partial<PauseManifestChild> & { state: PauseChildState },
  ): void {
    if (active === undefined) return
    active.manifest.children = active.manifest.children.map(child => {
      if (child.id !== childId) return child
      const next = { ...child }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (next as Record<string, unknown>)[key]
        else (next as Record<string, unknown>)[key] = value
      }
      return next
    })
    active.manifest.forced = active.manifest.children.filter(child => child.forced === true).length
  }

  private async write(root: Agent, manifest: PauseManifestEvent): Promise<void> {
    if (this.disposed) return
    manifest.updatedAt = Date.now()
    appendPauseManifest(root, manifest)
    await this.flush(root.session)
  }

  private async flush(session: Session): Promise<void> {
    try {
      await this.deps.sessions?.()?.flush(session)
    } catch {
      // A durability barrier failure must not strand the pause protocol; the
      // manifest and checkpoint records remain in the live log.
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Job kinds with no pause primitive; pause stops them or reports failure. */
const STOPPABLE_JOB_KINDS: ReadonlySet<string> = new Set(['workflow', 'bash', 'pwsh'])

function isStoppableKind(kind: string | undefined): boolean {
  return kind !== undefined && STOPPABLE_JOB_KINDS.has(kind)
}

function isBashKind(kind: string | undefined): boolean {
  return kind === 'bash' || kind === 'pwsh'
}

function isLiveJobStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'stopping'
}

function isTerminalJobStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** Bound the saved plan so one manifest record cannot grow without limit. */
const MAX_PLAN_CHARS = 64_000

function boundPlan(plan: string): string {
  if (plan.length <= MAX_PLAN_CHARS) return plan
  return `${plan.slice(0, MAX_PLAN_CHARS)}\n…[plan truncated; the full script remains in the session tool call]`
}

function workflowLabel(workflow: PauseManifestWorkflow): string {
  return `Workflow "${workflow.name}" (run ${workflow.runId})`
}

function workflowRestartWarning(workflow: PauseManifestWorkflow): string {
  return `${workflowLabel(workflow)} was stopped with its job; restart its workflow from the saved plan and artifacts. `
    + 'Run-level resume is not available.'
}

function workflowStopFailedWarning(
  workflow: PauseManifestWorkflow,
  jobs: readonly PauseManifestJob[],
): string {
  const ids = jobs.map(job => job.id).join(', ')
  return `${workflowLabel(workflow)} could not be stopped (job ${ids}); it may still be running and spending.`
}

function workflowChildStopWarning(child: PauseManifestChild): string {
  const label = child.label === undefined ? child.id : `${child.label} (${child.id})`
  return `Workflow subagent ${label} was stopped with its workflow job; restart its workflow from the saved plan and artifacts.`
}

function backgroundJobLabel(job: PauseManifestJob): string {
  const suffix = job.label === undefined ? '' : ` (${job.label})`
  return `Background ${job.kind ?? 'background'} job ${job.id}${suffix}`
}

function stoppedBashWarning(job: PauseManifestJob): string {
  return `${backgroundJobLabel(job)} was stopped at pause and has no checkpoint; `
    + 'Play will restart it. This is a restart, not a resume.'
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
    + `Restart it from the saved plan (the original workflow script in this session) in ${workspace}; `
    + `reuse files already written and the captured output (${artifacts}), and inspect child checkpoints (${children}). `
    + 'This is a restart, not a run-level resume.'
}

function workflowJobRestartInstruction(job: PauseManifestJob): string {
  return `- ${backgroundJobLabel(job)} was stopped. Restart its workflow from the saved plan `
    + '(the original workflow script in this session); this is a restart, not a run-level resume.'
}

function workflowStopFailedInstruction(workflow: PauseManifestWorkflow): string {
  return `- Workflow "${workflow.name}" (run ${workflow.runId}) could not be stopped; `
    + 'it may still be running. Check it before starting any replacement work.'
}

function backgroundRestartInstruction(job: PauseManifestJob): string {
  return `- ${backgroundJobLabel(job)} was stopped and has no checkpoint. `
    + 'Re-run its command if it is still needed. This is a restart, not a resume.'
}

function backgroundStopFailedInstruction(job: PauseManifestJob): string {
  return `- ${backgroundJobLabel(job)} could not be stopped; it may still be running. `
    + 'Check it before restarting anything.'
}

function restartWarning(child: PauseManifestChild): string {
  const label = child.label === undefined ? child.id : `${child.label} (${child.id})`
  return `Subagent ${label} could not be resumed; restart it from its checkpoint.`
}

function workflowWarning(child: PauseManifestChild): string {
  const label = child.label === undefined ? child.id : `${child.label} (${child.id})`
  return `Workflow subagent ${label} is job-owned; restart its workflow from the saved plan or checkpoint.`
}
