import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { PauseController } from '../src/pause.js'
import { PauseCoordinator, type PauseCoordinatorDeps } from '../src/pause-coordinator.js'
import {
  CHECKPOINT_RECORD,
  PAUSE_MANIFEST_RECORD,
  createRunState,
  latestPauseManifest,
  latestRunEvent,
  sessionKey,
  type JobRegistryLike,
} from '../src/state.js'
import type { PauseManifestEvent } from '../src/types.js'

/** One fake child Agent plus the turn machinery the park gate needs. */
class FakeChild {
  readonly agent: Agent
  readonly inbox = { nextStep: [] as UserMessage[], nextTurn: [] as UserMessage[] }
  readonly batches: UserMessage[][] = []
  readonly cancelCalls: Array<[unknown, unknown]> = []
  live = true
  /** When false the child is stuck inside a tool and never reaches pre-step. */
  autoPump = true
  status: 'idle' | 'running' = 'idle'
  private step = 0
  private pumping = false
  private controller = new AbortController()
  private pumpTask: Promise<void> | undefined
  onSteer: ((child: FakeChild) => void) | undefined

  constructor(
    readonly id: string,
    parentId: string,
    private readonly coordinator: () => PauseCoordinator,
    readonly label: string,
  ) {
    const sessionId = SessionId(id)
    const session = Session.create(sessionId, [], {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 0,
      isSeeded: false,
      parentSession: SessionId(parentId),
      origin: 'subagent',
      delegationDepth: 1,
    }, 0)
    const self = this
    this.agent = {
      id: sessionId,
      session,
      inbox: this.inbox,
      get status() { return self.status },
      steer(message: UserMessage) {
        if (self.status === 'idle' && self.controller.signal.aborted) self.controller = new AbortController()
        self.inbox.nextStep.push(message)
        self.onSteer?.(self)
      },
      cancel(cause: unknown, options: unknown) {
        self.cancelCalls.push([cause, options])
        self.controller.abort({ kind: 'user' })
        if (self.status !== 'running') self.status = 'idle'
      },
      followup(message: UserMessage) {
        self.agent.steer(message)
      },
      async whenIdle() {
        await self.settled()
      },
    } as unknown as Agent
  }

  /** Wait for any turn currently parked in pre-step. */
  settled(): Promise<void> {
    return this.pumpTask ?? Promise.resolve()
  }

  /** Simulate the child reaching a pre-step boundary and claiming its inbox. */
  pump(): Promise<void> {
    if (this.pumping) return this.pumpTask ?? Promise.resolve()
    this.pumping = true
    this.status = 'running'
    const coordinator = this.coordinator()
    const messages = this.inbox.nextStep.splice(0)
    const turn = 1
    const step = this.step += 1
    const signal = this.controller.signal
    this.pumpTask = (async () => {
      try {
        const decision = await coordinator.onPreStep(
          { agent: this.agent, messages, turn, step, signal },
          async (): Promise<PreStepDecision> => ({ kind: 'enter', messages }),
        )
        if (decision.kind === 'enter') this.batches.push(decision.messages)
      } catch {
        // The loop treats an aborted park as an aborted turn.
      } finally {
        this.status = 'idle'
        this.pumping = false
      }
    })()
    return this.pumpTask
  }

  /** Mark this child as no longer resident. */
  dispose(): void {
    this.live = false
    this.controller.abort({ kind: 'disposed' })
  }
}

/** One job view the fake registry hands out. */
interface FakeJobView {
  id: string
  kind: string
  label: string
  owner?: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  startedAt: number
  output: { total: number; earliest: number; spillPaths?: string[] }
  detail?: string
}

/**
 * Fake jobs registry covering the host job surface the pause coordinator
 * uses: list/kill/wait with owner isolation. `refuseToSettle` models a
 * producer that acknowledges the kill request but never reaches a terminal
 * state; `killError` models a registry that cannot stop the job at all.
 */
class FakeJobs implements JobRegistryLike {
  readonly views: FakeJobView[] = []
  readonly kills: Array<{ id: string; caller?: unknown; reason?: string }> = []
  readonly waits: Array<{ id: string; timeoutMs: number; caller?: unknown }> = []
  killError: Error | undefined
  readonly refuseToSettle = new Set<string>()
  onKill: ((id: string) => void) | undefined
  onList: (() => void) | undefined

  list(caller?: unknown): readonly FakeJobView[] {
    this.onList?.()
    return this.views.filter(view =>
      view.owner === undefined || String(view.owner) === String(caller))
  }

  get(id: string, caller?: unknown): FakeJobView {
    const view = this.views.find(candidate => candidate.id === id)
    if (view === undefined) throw new Error(`unknown job ${id}`)
    if (view.owner !== undefined && String(view.owner) !== String(caller)) {
      throw new Error(`job ${id} belongs to another session`)
    }
    return view
  }

  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished' {
    this.kills.push({ id, caller, reason })
    if (this.killError !== undefined) throw this.killError
    const view = this.get(id, caller)
    if (view.status === 'completed' || view.status === 'killed' || view.status === 'failed') {
      return 'already-finished'
    }
    this.onKill?.(id)
    view.status = this.refuseToSettle.has(id) ? 'stopping' : 'killed'
    return 'requested'
  }

  async wait(id: string, timeoutMs: number, caller?: unknown): Promise<FakeJobView> {
    this.waits.push({ id, timeoutMs, caller })
    const view = this.get(id, caller)
    if (view.status === 'running' || view.status === 'stopping') {
      await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 5)))
    }
    return { ...view }
  }

  add(overrides: Partial<FakeJobView> & Pick<FakeJobView, 'kind' | 'label'>): FakeJobView {
    const view: FakeJobView = {
      id: overrides.id ?? `job-${this.views.length + 1}`,
      kind: overrides.kind,
      label: overrides.label,
      ...overrides.owner === undefined ? {} : { owner: overrides.owner },
      status: overrides.status ?? 'running',
      startedAt: overrides.startedAt ?? Date.now(),
      output: overrides.output ?? { total: 0, earliest: 0 },
      ...overrides.detail === undefined ? {} : { detail: overrides.detail },
    }
    this.views.push(view)
    return view
  }
}

interface World {
  readonly root: Agent
  readonly children: FakeChild[]
  readonly coordinator: PauseCoordinator
  readonly pause: PauseController
  readonly runs: Map<string, ReturnType<typeof createRunState>>
  readonly config: ReturnType<typeof resolveConfig>
  readonly flushes: Session[]
  readonly sent: Array<{ readonly target: string; readonly content: readonly unknown[] }>
  readonly subagents: {
    listDescendants: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
    interrupt: ReturnType<typeof vi.fn>
  }
  addChild(label?: string): FakeChild
  child(id: string): FakeChild | undefined
}

function createWorld(options: {
  timeoutMs?: number
  drainMs?: number
  jobs?: JobRegistryLike
  coldResumeFails?: boolean
} = {}): World {
  const config = resolveConfig({
    pauseTimeoutMs: options.timeoutMs ?? 1_000,
    ...options.drainMs === undefined ? {} : { pauseDrainMs: options.drainMs },
  })
  const runs = new Map<string, ReturnType<typeof createRunState>>()
  const children: FakeChild[] = []
  const flushes: Session[] = []
  const sent: World['sent'] = []
  let coordinator!: PauseCoordinator

  const rootId = SessionId('root-session')
  const rootSession = Session.create(rootId, [], {
    version: SESSION_FORMAT_VERSION,
    id: rootId,
    createdAt: 0,
    isSeeded: false,
  }, 0)
  const root = {
    id: rootId,
    session: rootSession,
    status: 'running',
    inbox: { nextStep: [], nextTurn: [] },
    cancel: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    followup: vi.fn(),
    whenIdle: async () => {},
  } as unknown as Agent

  const liveAgents = () => ({
    list: () => [root, ...children.filter(child => child.live).map(child => child.agent)],
    get: (id: SessionId | string) => {
      if (String(id) === String(rootId)) return root
      return children.find(child => child.live && child.id === String(id))?.agent
    },
  })

  const subagents = {
    listDescendants: vi.fn(async () => children
      .filter(child => child.live)
      .map(child => ({
        kind: 'child' as const,
        id: child.agent.id,
        parentId: rootId,
        depth: 1,
        mode: 'continuable' as const,
        label: child.label,
        activity: 'running' as const,
        hasChildren: false,
      }))),
    sendMessage: vi.fn(async (_sender: Agent, target: SessionId, content: readonly unknown[]) => {
      if (options.coldResumeFails === true) throw new Error('NOT_RESUMABLE')
      sent.push({ target: String(target), content })
      return 'message-1'
    }),
    interrupt: vi.fn((target: SessionId) => {
      const child = children.find(candidate => candidate.id === String(target))
      child?.agent.cancel({ kind: 'parent' }, { keepInbox: true })
    }),
  }

  const deps: PauseCoordinatorDeps = {
    timeoutMs: config.pauseTimeoutMs,
    drainMs: config.pauseDrainMs,
    agents: liveAgents,
    subagents: () => subagents,
    sessions: () => ({
      flush: async session => { flushes.push(session); return true },
    }),
    jobs: () => options.jobs,
  }
  coordinator = new PauseCoordinator(deps)
  const pause = new PauseController(config, runs, coordinator)

  return {
    root,
    children,
    coordinator,
    pause,
    runs,
    config,
    flushes,
    sent,
    subagents,
    addChild(label = 'child') {
      const child = new FakeChild(`child-${children.length + 1}`, String(rootId), () => coordinator, label)
      child.onSteer = () => {
        if (child.autoPump) void child.pump()
      }
      children.push(child)
      return child
    },
    child(id) {
      return children.find(child => child.id === id)
    },
  }
}

function manifestEvents(agent: Agent): PauseManifestEvent[] {
  return agent.session.snapshotEvents()
    .map(event => pluginRecordOf(event))
    .filter(record => record?.type === PAUSE_MANIFEST_RECORD)
    .map(record => record!.data as PauseManifestEvent)
}

function latestManifest(agent: Agent): PauseManifestEvent | undefined {
  return latestPauseManifest(agent.session.snapshotEvents())
}

function checkpointEvents(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .map(event => pluginRecordOf(event))
    .filter(record => record?.type === CHECKPOINT_RECORD)
    .map(record => record!.data as Record<string, unknown>)
}

async function waitFor(predicate: () => boolean, label: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('root pause protocol for local subagents', () => {
  it('parks an acknowledging child, records its checkpoint, and enters paused with progress', async () => {
    const world = createWorld()
    const child = world.addChild('implement child')
    child.autoPump = true
    child.status = 'running'
    const run = createRunState('tdd', world.config)
    run.phase = 'running'
    world.runs.set(sessionKey(world.root), run)

    const outcome = world.pause.pause(world.root)
    expect(outcome.ok).toBe(true)
    // The pausing phase is durable before the command returns, so the primary
    // control never flashes Play while children are still acknowledging.
    expect(latestManifest(world.root)?.phase).toBe('pausing')
    expect(latestRunEvent(world.root.session.snapshotEvents())?.phase).toBe('paused_user')
    expect(world.root.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'manifest paused')
    const manifest = latestManifest(world.root)!
    expect(manifest.rootId).toBe(String(world.root.session.id))
    expect(manifest.forced).toBe(0)
    expect(manifest.children).toEqual([
      expect.objectContaining({
        id: child.id,
        label: 'implement child',
        state: 'parked',
        forced: false,
      }),
    ])
    expect(manifestEvents(world.root).some(event =>
      event.phase === 'pausing' && event.children.length === 1)).toBe(true)

    // The control message is host-side only: the model never sees it.
    expect(child.batches).toEqual([])
    // The child flushed and recorded a durable pause checkpoint.
    expect(checkpointEvents(child.agent)).toEqual([
      expect.objectContaining({
        pauseId: manifest.pauseId,
        childId: child.id,
        turn: 1,
        step: 1,
        forced: false,
      }),
    ])
    expect(world.flushes).toContain(child.agent.session)
    expect(world.flushes).toContain(world.root.session)
    expect(checkpointEvents(world.root)).toEqual([
      expect.objectContaining({
        pauseId: manifest.pauseId,
        childId: String(world.root.session.id),
        forced: false,
      }),
    ])

    // No work resumes without Play.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(child.batches).toEqual([])
    expect(latestManifest(world.root)?.phase).toBe('paused')

    world.pause.resume(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'resumed', 'manifest resumed')
    await child.settled()
    expect(child.batches).toEqual([[]])
    expect(latestPauseManifest(world.root.session.snapshotEvents())?.children[0]?.state).toBe('resumed')
  })

  it('forces a non-acknowledging child after the timeout and keeps the forced result visible', async () => {
    const world = createWorld({ timeoutMs: 20 })
    const child = world.addChild('stuck child')
    child.autoPump = false // stuck inside a tool: its next pre-step never arrives
    child.status = 'running'

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'manifest paused after timeout')

    const manifest = latestManifest(world.root)!
    expect(manifest.forced).toBe(1)
    expect(manifest.children[0]).toMatchObject({
      id: child.id,
      state: 'forced',
      forced: true,
    })
    expect(checkpointEvents(child.agent).at(-1)).toMatchObject({
      pauseId: manifest.pauseId,
      forced: true,
    })
    expect(child.cancelCalls).toEqual([[{ kind: 'parent' }, { keepInbox: true }]])
    expect(world.subagents.interrupt).toHaveBeenCalledWith(
      child.agent.session.id,
      { kind: 'ancestor', agent: world.root },
    )
    // Forced means stopped: no model batch was admitted.
    expect(child.batches).toEqual([])

    child.autoPump = true
    world.pause.resume(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'resumed', 'manifest resumed after forced stop')
    await waitFor(() => child.batches.length > 0, 'forced child warm resume')
    const visible = child.batches.at(-1)!
    expect(JSON.stringify(visible)).toContain('root session resumed')
    // The stale host control from the timed-out park never reaches the model.
    expect(JSON.stringify(visible)).not.toContain('checkpoint and park')
    expect(latestManifest(world.root)?.children[0]?.state).toBe('resumed')
  })

  it('cold-resumes a disposed child through the subagent service on Play', async () => {
    const world = createWorld({ timeoutMs: 15 })
    const child = world.addChild('disposed child')
    child.autoPump = false
    child.status = 'running'

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'paused before disposal')
    child.dispose()

    world.pause.resume(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'resumed', 'resumed after cold resume')
    const manifest = latestManifest(world.root)!
    expect(manifest.children[0]).toMatchObject({ id: child.id, state: 'cold-resumed' })
    expect(world.subagents.sendMessage).toHaveBeenCalledWith(
      world.root,
      child.agent.session.id,
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const call = world.subagents.sendMessage.mock.calls.at(-1)!
    expect(JSON.stringify(call[2])).toContain('root session resumed')
  })

  it('marks the child as restarted from checkpoint with a warning when cold resume is unavailable', async () => {
    const world = createWorld({ timeoutMs: 15, coldResumeFails: true })
    const child = world.addChild('unresumable child')
    child.autoPump = false
    child.status = 'running'

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'paused before failed cold resume')
    child.dispose()

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('restart it from its checkpoint')
    await waitFor(() => latestManifest(world.root)?.phase === 'resumed', 'resumed after failure')
    const manifest = latestManifest(world.root)!
    expect(manifest.children[0]).toMatchObject({ id: child.id, state: 'restarted' })
    expect(manifest.children[0]?.warning).toContain('restart it from its checkpoint')
    expect(manifest.warning).toContain('restart it from its checkpoint')
    // Nothing silently restarted.
    expect(child.batches).toEqual([])
  })

  it('parks acknowledging children and forces only the stragglers', async () => {
    const world = createWorld({ timeoutMs: 20 })
    const acked = world.addChild('acking child')
    acked.status = 'running'
    const stuck = world.addChild('stuck child')
    stuck.status = 'running'
    stuck.autoPump = false

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'mixed pause settled')

    const manifest = latestManifest(world.root)!
    expect(manifest.children).toEqual([
      expect.objectContaining({ id: acked.id, state: 'parked', forced: false }),
      expect.objectContaining({ id: stuck.id, state: 'forced', forced: true }),
    ])
    expect(manifest.forced).toBe(1)
    expect(acked.batches).toEqual([])
    expect(stuck.cancelCalls).toHaveLength(1)
    // The acknowledged child stays parked: no auto-release on timeout.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(acked.batches).toEqual([])
  })

  it('parks and releases a workflow child through the host gate without a finish message', async () => {
    const world = createWorld()
    const child = world.addChild('parked workflow child')
    child.status = 'running'
    ;(world.root.session as unknown as { append(type: string, data: unknown): unknown }).append(
      'tool-workflow/agent-start',
      { runId: 'run-1', seq: 1, label: 'parked workflow child', childId: child.agent.session.id },
    )

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'workflow park settled')
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      workflow: true,
      state: 'parked',
    })
    // The hidden host control is the only pause signal; no finish prompt.
    expect(child.batches).toEqual([])

    await world.pause.resumeAsync(world.root)
    await child.settled()
    expect(child.batches).toEqual([[]])
    expect(world.subagents.sendMessage).not.toHaveBeenCalled()
    expect(latestManifest(world.root)?.children[0]?.state).toBe('resumed')
  })

  it('leaves a stopped workflow child to its workflow run instead of independently resuming it', async () => {
    const world = createWorld({ timeoutMs: 15 })
    const child = world.addChild('workflow child')
    child.status = 'running'
    child.autoPump = false
    ;(world.root.session as unknown as { append(type: string, data: unknown): unknown }).append(
      'tool-workflow/agent-start',
      { runId: 'run-1', seq: 1, label: 'workflow child', childId: child.agent.session.id },
    )

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'workflow pause settled')
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      workflow: true,
      state: 'forced',
    })

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.text).toContain('job-owned')
    expect(world.subagents.sendMessage).not.toHaveBeenCalled()
    expect(child.batches).toEqual([])
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      state: 'restart-required',
    })
    expect(latestManifest(world.root)?.warning).toContain('restart its workflow')
  })

  it('never steers a live workflow child on Play; it is left to the workflow restart', async () => {
    const world = createWorld()
    const child = world.addChild('idle workflow child')
    child.status = 'idle'
    ;(world.root.session as unknown as { append(type: string, data: unknown): unknown }).append(
      'tool-workflow/agent-start',
      { runId: 'run-1', seq: 1, label: 'idle workflow child', childId: child.agent.session.id },
    )

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'idle workflow child paused')
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      workflow: true,
      state: 'idle',
    })

    await world.pause.resumeAsync(world.root)
    expect(child.batches).toEqual([])
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      state: 'restart-required',
    })
    expect(latestManifest(world.root)?.warning).toContain('restart its workflow')
  })

  it('stops a running workflow job after parking its children and records its plan, artifacts, and child ids', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 10, jobs })
    const child = world.addChild('audit child 1')
    child.status = 'running'
    const rootId = String(world.root.session.id)
    world.root.session.append('tool-workflow/run-start', { runId: 'run-1', name: 'audit' })
    world.root.session.append('tool-workflow/agent-start', {
      runId: 'run-1',
      seq: 1,
      label: 'audit child 1',
      childId: child.agent.session.id,
    })
    world.root.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'workflow',
      arguments: JSON.stringify({
        meta: { name: 'audit' },
        script: 'phase("scan")\nawait agent("inspect")',
      }),
    } as never)
    const job = jobs.add({
      kind: 'workflow',
      label: 'audit',
      owner: rootId,
      output: { total: 10, earliest: 0, spillPaths: ['C:/tmp/audit.log'] },
    })
    jobs.onKill = () => child.agent.cancel({ kind: 'parent' }, { keepInbox: true })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'workflow job stopped')

    const manifest = latestManifest(world.root)!
    expect(manifest.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        kind: 'workflow',
        label: 'audit',
        disposition: 'stopped',
        status: 'killed',
      }),
    ])
    expect(manifest.workflows).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        name: 'audit',
        jobId: job.id,
        childIds: [child.id],
        plan: expect.stringContaining('phase("scan")'),
        artifacts: ['C:/tmp/audit.log'],
        state: 'stopped',
      }),
    ])
    expect(jobs.kills).toEqual([{ id: job.id, caller: rootId, reason: 'paused by user' }])
    expect(manifest.children[0]).toMatchObject({
      id: child.id,
      workflow: true,
      state: 'stopped',
    })
    expect(manifest.warning).toContain('restart its workflow')
    // The workflow child is only ever parked through the hidden host control;
    // no normal finish/pause message is sent to it.
    expect(world.subagents.sendMessage).not.toHaveBeenCalled()
    expect(child.batches).toEqual([])

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.text).toMatch(/Workflow "audit" restarts from its saved plan/)
    expect(outcome.text).toMatch(/run-level resume is not available/i)
    const resumed = latestManifest(world.root)!
    expect(resumed.jobs[0]?.disposition).toBe('restart-required')
    expect(resumed.workflows?.[0]).toMatchObject({ runId: 'run-1', state: 'restart-required' })
    expect(resumed.restartInstruction).toContain('C:/tmp/audit.log')
    expect(resumed.restartInstruction).toContain(child.id)
    // The saved plan is handed to the model, not just described in prose.
    expect(resumed.restartInstruction).toContain('phase("scan")')
    expect(resumed.restartInstruction).toContain('await agent("inspect")')
    expect(resumed.restartInstruction).toMatch(/run-level resume/i)
    const injected = (world.root.inject as unknown as {
      mock: { calls: unknown[][] }
    }).mock.calls.map(call => JSON.stringify(call[0]))
    expect(injected.some(text => text.includes('saved_workflow_plan'))).toBe(true)
    expect(child.batches).toEqual([])
  })

  it('stops a child-owned bash job with the owning child as the kill caller', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 5, jobs })
    const child = world.addChild('job owner')
    child.status = 'idle'
    const job = jobs.add({ kind: 'bash', label: 'child build', owner: child.id })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'child-owned job stopped')

    expect(latestManifest(world.root)?.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        kind: 'bash',
        owner: child.id,
        ownerKind: 'child',
        disposition: 'stopped',
      }),
    ])
    expect(jobs.kills).toEqual([{ id: job.id, caller: child.id, reason: 'paused by user' }])
  })

  it('records an idle child and a non-workflow job without stopping either', async () => {
    const rootId = 'root-session'
    const jobs: JobRegistryLike = {
      list(caller) {
        return String(caller) === rootId
          ? [{ id: 'job-root-1', kind: 'research', owner: rootId, status: 'running' }]
          : []
      },
      kill: vi.fn(),
    }
    const world = createWorld({ jobs })
    const idle = world.addChild('idle child')
    idle.status = 'idle'

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'paused with idle child')

    const manifest = latestManifest(world.root)!
    expect(manifest.children[0]).toMatchObject({ id: idle.id, state: 'idle', forced: false })
    expect(manifest.forced).toBe(0)
    expect(manifest.jobs).toEqual([{
      id: 'job-root-1',
      kind: 'research',
      owner: rootId,
      ownerKind: 'root',
      status: 'running',
      disposition: 'recorded',
    }])
    // Only workflow/bash/pwsh work has a pause stop policy.
    expect(jobs.kill).not.toHaveBeenCalled()
    expect(idle.cancelCalls).toEqual([])
  })

  it('does not resume parked work when the plugin unloads', async () => {
    const world = createWorld()
    const child = world.addChild('parked child')
    child.status = 'running'

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'paused before unload')
    expect(child.batches).toEqual([])

    world.coordinator.dispose()
    await child.settled()

    // The parked turn is stopped, not released back to the model.
    expect(child.batches).toEqual([])
    expect(child.cancelCalls).toContainEqual([{ kind: 'parent' }, { keepInbox: true }])
  })

  it('stops a bash job, then Play instructs the root to restart it rather than resuming it', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 10, jobs })
    const rootId = String(world.root.session.id)
    const job = jobs.add({ kind: 'bash', label: 'pnpm test', owner: rootId })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'bash job stopped')

    const paused = latestManifest(world.root)!
    expect(paused.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        kind: 'bash',
        label: 'pnpm test',
        disposition: 'stopped',
        status: 'killed',
      }),
    ])
    expect(paused.warning).toContain('Play will restart it')
    expect(paused.warning).toContain('not a resume')

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toMatch(/restart/i)
    expect(outcome.text).toMatch(/run-level resume/i)

    const resumed = latestManifest(world.root)!
    expect(resumed.phase).toBe('resumed')
    expect(resumed.jobs[0]?.disposition).toBe('restart-required')
    expect(resumed.restartInstruction).toContain('pnpm test')
    expect(resumed.restartInstruction).toMatch(/restart/i)
    expect(resumed.restartInstruction).toMatch(/run-level resume/i)
    // The restart instruction is for the root session only.
    expect(world.subagents.sendMessage).not.toHaveBeenCalled()
    const injected = (world.root.inject as unknown as {
      mock: { calls: unknown[][] }
    }).mock.calls.map(call => JSON.stringify(call[0]))
    expect(injected.some(text => text.includes('pnpm test'))).toBe(true)
  })

  it('records a visible stop failure and never reports an unstopped job as paused or restartable', async () => {
    const jobs = new FakeJobs()
    jobs.killError = new Error('producer refused to cancel')
    const world = createWorld({ drainMs: 5, jobs })
    const rootId = String(world.root.session.id)
    world.root.session.append('tool-workflow/run-start', { runId: 'run-1', name: 'audit' })
    const job = jobs.add({ kind: 'workflow', label: 'audit', owner: rootId })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'failed stop recorded')

    const manifest = latestManifest(world.root)!
    expect(manifest.jobs[0]).toMatchObject({
      id: job.id,
      kind: 'workflow',
      disposition: 'stop-failed',
      status: 'running',
    })
    expect(manifest.jobs[0]?.warning).toContain('could not be stopped')
    expect(manifest.jobs[0]?.warning).toContain('may still be running')
    expect(manifest.warning).toContain('producer refused to cancel')
    expect(manifest.workflows?.[0]).toMatchObject({
      runId: 'run-1',
      state: 'stop-failed',
    })
    expect(manifest.workflows?.[0]?.warning).toContain('could not be stopped')
    // No silent spend: the job is not claimed stopped or paused.
    expect(manifest.jobs[0]?.disposition).not.toBe('stopped')

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.text).toContain('could not be stopped')
    const resumed = latestManifest(world.root)!
    expect(resumed.jobs[0]?.disposition).toBe('stop-failed')
    expect(resumed.restartInstruction).toContain('could not be stopped')
    expect(resumed.restartInstruction).not.toContain('Re-run its command')
  })

  it('lets a workflow job finish during the drain instead of killing and restarting it', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 20, jobs })
    const rootId = String(world.root.session.id)
    world.root.session.append('tool-workflow/run-start', { runId: 'run-1', name: 'audit' })
    const job = jobs.add({ kind: 'workflow', label: 'audit', owner: rootId })
    setTimeout(() => { job.status = 'completed' }, 2)

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'drain settlement recorded')

    const manifest = latestManifest(world.root)!
    expect(manifest.jobs[0]).toMatchObject({ id: job.id, disposition: 'settled', status: 'completed' })
    expect(jobs.kills).toEqual([])
    expect(manifest.workflows?.[0]).toMatchObject({ runId: 'run-1', state: 'settled' })
    expect(manifest.warning).toBeUndefined()

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.text).not.toMatch(/restart/i)
    expect(latestManifest(world.root)?.restartInstruction).toBeUndefined()
    expect(latestManifest(world.root)?.jobs[0]?.disposition).toBe('settled')
  })

  it('still instructs a restart for a workflow job with no durable run record', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 5, jobs })
    const rootId = String(world.root.session.id)
    const job = jobs.add({ kind: 'workflow', label: 'ad-hoc audit', owner: rootId })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'workflow job stopped')

    const outcome = await world.pause.resumeAsync(world.root)
    expect(outcome.text).toContain('ad-hoc audit')
    expect(outcome.text).toMatch(/restart/i)
    expect(outcome.text).toMatch(/run-level resume/i)
    const resumed = latestManifest(world.root)!
    expect(resumed.jobs[0]?.disposition).toBe('restart-required')
    expect(resumed.restartInstruction).toContain('ad-hoc audit')
    expect(resumed.restartInstruction).toMatch(/saved plan/i)
  })

  it('stops a job registered while the pause is draining', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 5, jobs })
    const rootId = String(world.root.session.id)
    const late: FakeJobView = {
      id: 'job-late',
      kind: 'bash',
      label: 'late build',
      owner: rootId,
      status: 'running',
      startedAt: Date.now(),
      output: { total: 0, earliest: 0 },
    }
    let lists = 0
    jobs.onList = () => {
      lists += 1
      // The first listing is the initial snapshot; a tool step can register a
      // new job before the pause drain finishes. The stop pass re-lists.
      if (lists > 1 && !jobs.views.some(view => view.id === late.id)) jobs.views.push(late)
    }

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'late job stopped')

    expect(latestManifest(world.root)?.jobs).toEqual([
      expect.objectContaining({ id: late.id, kind: 'bash', disposition: 'stopped' }),
    ])
    expect(jobs.kills).toEqual([{ id: late.id, caller: rootId, reason: 'paused by user' }])
  })

  it('records but does not stop an unowned job', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ drainMs: 5, jobs })
    const job = jobs.add({ kind: 'bash', label: 'shared build' })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'unowned job recorded')

    expect(latestManifest(world.root)?.jobs).toEqual([
      expect.objectContaining({ id: job.id, kind: 'bash', disposition: 'recorded' }),
    ])
    expect(jobs.kills).toEqual([])
  })

  it('cancels the pause and stops parked children when the user starts a new direction', async () => {
    const world = createWorld()
    const child = world.addChild('parked child')
    child.status = 'running'
    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'paused before user direction')

    const cleared = await world.pause.onPreStep(world.root, [user('new direction')])
    expect(cleared.kind).toBe('released')
    expect(world.pause.isPaused(world.root)).toBe(false)
    await waitFor(() => latestManifest(world.root)?.phase === 'cancelled', 'manifest cancelled by user text')
    await child.settled()
    // Old child work must not continue: the parked turn is aborted and the
    // child is stopped, so the model sees no batch from the cancelled pause.
    expect(child.batches).toEqual([])
    expect(child.cancelCalls).toContainEqual([{ kind: 'parent' }, { keepInbox: true }])
    expect(latestManifest(world.root)?.children[0]?.state).toBe('cancelled')
  })

  it('stops owned jobs when a pausing pause is cancelled before its drain finishes', async () => {
    const jobs = new FakeJobs()
    const world = createWorld({ timeoutMs: 200, drainMs: 5, jobs })
    const child = world.addChild('slow child')
    child.autoPump = false
    child.status = 'running'
    const rootId = String(world.root.session.id)
    const job = jobs.add({ kind: 'bash', label: 'long build', owner: rootId })

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'pausing', 'pause still pausing')
    expect(latestManifest(world.root)?.jobs[0]).toMatchObject({ id: job.id, disposition: 'recorded' })

    const released = await world.coordinator.release(world.root, 'cancel')
    expect(released.children[0]).toMatchObject({ id: child.id, state: 'cancelled' })
    // The cancel must own the stop once begin() is on its way out.
    expect(jobs.kills).toEqual([{ id: job.id, caller: rootId, reason: 'paused by user' }])
    expect(latestManifest(world.root)?.jobs[0]).toMatchObject({
      id: job.id,
      disposition: 'cancelled',
      status: 'killed',
    })
    // The child never reached its park point; it is stopped, not resumed.
    expect(child.batches).toEqual([])
    expect(child.cancelCalls).toContainEqual([{ kind: 'parent' }, { keepInbox: true }])
    await waitFor(() => latestManifest(world.root)?.phase === 'cancelled', 'cancel settles')
  })

  it('captures artifact paths from the child session in the checkpoint and manifest', async () => {
    const world = createWorld()
    const child = world.addChild('presenting child')
    child.status = 'running'
    const present = (path: string): void => {
      ;(child.agent.session as unknown as { append(type: string, data: unknown): unknown }).append(
        'deliverables/presented',
        { turn: 1, callId: `present-${path}`, files: [{ path }] },
      )
    }
    present('C:/tmp/child-report.md')
    present('C:/tmp/child-summary.json')

    world.pause.pause(world.root)
    await waitFor(() => latestManifest(world.root)?.phase === 'paused', 'artifact checkpoint paused')

    expect(checkpointEvents(child.agent).at(-1)).toMatchObject({
      artifacts: ['C:/tmp/child-report.md', 'C:/tmp/child-summary.json'],
    })
    expect(latestManifest(world.root)?.children[0]).toMatchObject({
      id: child.id,
      state: 'parked',
      artifacts: ['C:/tmp/child-report.md', 'C:/tmp/child-summary.json'],
    })
  })
})

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
