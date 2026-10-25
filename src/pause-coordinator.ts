/**
 * Root-mediated pause coordination.
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
 *
 * The child park, job stop, workflow capture, and warning helpers live in
 * focused sibling modules; this class only orchestrates the transition.
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
  checkpointAgent,
  liveChild as findLiveChild,
  liveChildren as findLiveChildren,
  stopChild,
  waitForAcknowledgements,
  type LiveAgentRegistryLike,
} from './pause-children.js'
import { collectPauseJobs, stopPauseJobs } from './pause-jobs.js'
import {
  manifestWarnings,
  patchManifestChild,
  refreshManifestWarning,
} from './pause-manifest.js'
import {
  cancelStoppedWork,
  collectPauseWorkflows,
  preparePauseRestart,
  type PauseRestart,
} from './pause-workflows.js'
import { restartWarning, workflowChildStopWarning, workflowWarning } from './pause-warnings.js'
import {
  appendPauseManifest,
  catalogChildren,
  latestPauseManifest,
  openTurn,
  workflowChildIds,
  type JobRegistryLike,
} from './state.js'
import type {
  PauseManifestChild,
  PauseManifestEvent,
} from './types.js'

export type { LiveAgentRegistryLike } from './pause-children.js'
export type { PauseRestart } from './pause-workflows.js'

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
  /** One stop pass per pause, shared by begin and release. */
  jobsStopped?: Promise<void>
}

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
    const jobs = collectPauseJobs(root, live, this.deps.jobs?.())
    const manifest: PauseManifestEvent = {
      pauseId,
      rootId: rootKey,
      phase: 'pausing',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs: this.deps.timeoutMs,
      children,
      jobs,
      workflows: collectPauseWorkflows(root, jobs),
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
        patchManifestChild(manifest, String(child.id), { state: 'disposed' })
      }
      entry.acknowledged.then(ack => {
        if (!this.stillPausing(active, String(child.id))) return
        patchManifestChild(manifest, String(child.id), {
          state: 'parked',
          acknowledgedAt: ack.checkpointAt,
          checkpointAt: ack.checkpointAt,
          checkpointSeq: ack.checkpointSeq,
          ...ack.artifacts === undefined || ack.artifacts.length === 0
            ? {}
            : { artifacts: ack.artifacts },
        })
        void this.write(root, active.manifest)
      }).catch(() => undefined)
    }
    await this.write(root, manifest)

    await waitForAcknowledgements(entries, this.deps.timeoutMs)
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
    await this.stopJobsOnce(root, manifest, active)
    if (active.released || this.disposed || this.active.get(rootKey) !== active) return
    refreshManifestWarning(manifest)
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
   * the subagent service can; `cancel` stops parked children and the manifest
   * without starting any new work. A release during the `pausing` phase stops
   * any owned workflow/bash work before the transition settles.
   */
  async release(root: Agent, mode: PauseReleaseMode): Promise<PauseReleaseResult> {
    const rootKey = String(root.session.id)
    const active = this.active.get(rootKey)
    const manifest = active?.manifest ?? latestPauseManifest(root.session.snapshotEvents())
    if (manifest === undefined || manifest.phase === 'resumed' || manifest.phase === 'cancelled') {
      return { children: manifest?.children ?? [], warnings: [] }
    }
    const wasPausing = manifest.phase === 'pausing'
    if (active !== undefined) active.released = true
    manifest.phase = 'resuming'
    await this.write(root, manifest)

    // A user direction or Play can arrive while the acknowledgment drain is
    // still running. begin() bails on `released`, so this path owns the stop:
    // leave no workflow/bash job spending after the pause transition ends.
    if (wasPausing) {
      await this.stopJobsOnce(root, manifest, active)
      if (this.disposed) return { children: manifest.children, warnings: [] }
    }

    const live = new Map(this.liveChildren(root).map(child => [String(child.id), child]))
    const stopService = this.deps.subagents?.()
    for (const record of [...manifest.children]) {
      // A workflow member stopped with its job is never re-driven on its own:
      // the saved plan/artifacts are the restart path, not a child resume.
      if (record.state === 'stopped' || record.state === 'restart-required') {
        patchManifestChild(manifest, record.id, {
          state: mode === 'cancel' ? 'cancelled' : 'restart-required',
          warning: mode === 'cancel' ? undefined : workflowChildStopWarning(record),
        })
        continue
      }
      const entry = this.gate.get(record.id)
      if (entry !== undefined) {
        if (mode === 'cancel') {
          // A parked turn is released as an abort, never resumed: old child
          // work must not continue after the user starts a new direction.
          this.gate.release(record.id, 'abort')
          const child = live.get(record.id)
          if (child !== undefined) stopChild(root, child, stopService)
          patchManifestChild(manifest, record.id, { state: 'cancelled', warning: undefined })
        } else {
          this.gate.release(record.id, 'resume')
          patchManifestChild(manifest, record.id, { state: 'resumed', warning: undefined })
        }
        continue
      }
      const child = live.get(record.id)
      if (child !== undefined) {
        if (mode === 'cancel') {
          if (child.status === 'running') stopChild(root, child, stopService)
          patchManifestChild(manifest, record.id, { state: 'cancelled', warning: undefined })
          continue
        }
        if (record.workflow === true) {
          // A workflow member is owned by its run, and a normal turn can
          // become that item's result. Never steer it on Play; only the
          // workflow restart from the saved plan may recreate the work.
          patchManifestChild(manifest, record.id, {
            state: 'restart-required',
            warning: workflowWarning(record),
          })
          continue
        }
        try {
          child.steer(pauseResumeMessage())
          patchManifestChild(manifest, record.id, { state: 'resumed', warning: undefined })
        } catch {
          patchManifestChild(manifest, record.id, {
            state: 'restarted',
            warning: restartWarning(record),
          })
        }
        continue
      }
      if (mode === 'cancel') {
        patchManifestChild(manifest, record.id, { state: 'cancelled' })
        continue
      }
      if (record.workflow === true) {
        patchManifestChild(manifest, record.id, {
          state: 'unavailable',
          warning: workflowWarning(record),
        })
        continue
      }
      const resumed = await this.coldResume(root, record)
      patchManifestChild(manifest, record.id, resumed
        ? { state: 'cold-resumed', warning: undefined }
        : { state: 'restarted', warning: restartWarning(record) })
    }

    let restart: PauseRestart | undefined
    let instructionWarning: string | undefined
    if (mode === 'cancel') {
      cancelStoppedWork(manifest)
    } else {
      restart = preparePauseRestart(manifest)
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
    refreshManifestWarning(manifest, instructionWarning === undefined ? [] : [instructionWarning])
    const warnings = manifestWarnings(manifest)
    await this.write(root, manifest)
    if (active !== undefined) this.active.delete(rootKey)
    return {
      children: manifest.children,
      warnings,
      ...restart === undefined ? {} : { restart },
    }
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
    return findLiveChildren(root, this.deps.agents?.())
  }

  private liveChild(root: Agent, childId: string): Agent | undefined {
    return findLiveChild(root, childId, this.deps.agents?.())
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

  /** Stop jobs at most once per pause so begin and release never race a kill. */
  private stopJobsOnce(
    root: Agent,
    manifest: PauseManifestEvent,
    active: ActivePause | undefined,
  ): Promise<void> {
    if (active?.jobsStopped !== undefined) return active.jobsStopped
    const task = stopPauseJobs({
      root,
      manifest,
      children: this.liveChildren(root),
      registry: this.deps.jobs?.(),
      drainMs: this.deps.drainMs,
      disposed: () => this.disposed,
      forgetChild: id => this.gate.forget(id),
    })
    if (active !== undefined) active.jobsStopped = task
    return task
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
    return await checkpointAgent(
      agent, pauseId, turn, step, forced, root,
      session => this.flush(session),
    )
  }

  private async forceChild(
    active: ActivePause,
    childId: string,
    child: Agent | undefined,
  ): Promise<void> {
    if (active.released || this.disposed) return
    let ack: ParkAcknowledgement | undefined
    if (child !== undefined) {
      try {
        ack = await this.checkpointChild(child, active.pauseId, openTurn(child), 0, true)
      } catch {
        // A child whose log is already closing is still stopped and marked
        // forced; the root manifest remains the durable record of the pause.
      }
      stopChild(active.root, child, this.deps.subagents?.())
    }
    if (active.released || this.disposed) return
    patchManifestChild(active.manifest, childId, {
      state: 'forced',
      forced: true,
      ...ack?.artifacts === undefined || ack.artifacts.length === 0
        ? {}
        : { artifacts: ack.artifacts },
    })
    await this.write(active.root, active.manifest)
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
