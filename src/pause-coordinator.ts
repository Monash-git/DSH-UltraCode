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
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
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
  type JobRegistryLike,
  type JobViewLike,
} from './state.js'
import type {
  PauseChildState,
  PauseManifestChild,
  PauseManifestEvent,
  PauseManifestJob,
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
}

interface ActivePause {
  readonly root: Agent
  readonly pauseId: string
  readonly manifest: PauseManifestEvent
  released: boolean
}

interface JobView extends JobViewLike {
  readonly kind?: unknown
  readonly label?: unknown
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
    const manifest: PauseManifestEvent = {
      pauseId,
      rootId: rootKey,
      phase: 'pausing',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs: this.deps.timeoutMs,
      children,
      jobs: this.collectJobs(root, live),
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
        if (record.workflow === true && record.state !== 'idle') {
          // A stopped workflow child is owned by its run; re-driving it here
          // would detach it from the script that consumed its result.
          this.updateChild(active, record.id, {
            state: 'unavailable',
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

    manifest.phase = mode === 'cancel' ? 'cancelled' : 'resumed'
    const warning = manifest.children
      .map(child => child.warning)
      .filter((value): value is string => value !== undefined)
      .join(' ')
    if (warning === '') delete manifest.warning
    else manifest.warning = warning
    await this.write(root, manifest)
    if (active !== undefined) this.active.delete(rootKey)
    return {
      children: manifest.children,
      warnings: manifest.children
        .map(child => child.warning)
        .filter((value): value is string => value !== undefined),
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
   * Release every park wait on plugin unload so no child turn hangs forever.
   * A hot reload leaves agents live, so parked turns continue in place rather
   * than ending as errors; the durable pause record and manifest still say
   * paused, and the reloaded instance can Play-release or report them.
   */
  dispose(): void {
    this.disposed = true
    for (const active of this.active.values()) active.released = true
    this.active.clear()
    this.gate.dispose('resume')
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
      return {
        id: String(view.id),
        ...asString(view.kind) === undefined ? {} : { kind: asString(view.kind) },
        ...owner === undefined ? {} : { owner },
        ownerKind,
        ...view.status === undefined ? {} : { status: view.status },
        disposition: 'recorded',
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

function restartWarning(child: PauseManifestChild): string {
  const label = child.label === undefined ? child.id : `${child.label} (${child.id})`
  return `Subagent ${label} could not be resumed; restart it from its checkpoint.`
}

function workflowWarning(child: PauseManifestChild): string {
  const label = child.label === undefined ? child.id : `${child.label} (${child.id})`
  return `Workflow subagent ${label} is job-owned; restart its workflow from the saved plan or checkpoint.`
}
