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
  jobs?: JobRegistryLike
  coldResumeFails?: boolean
} = {}): World {
  const config = resolveConfig({ pauseTimeoutMs: options.timeoutMs ?? 1_000 })
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
      state: 'unavailable',
    })
    expect(latestManifest(world.root)?.warning).toContain('restart its workflow')
  })

  it('records idle children as acknowledged and job ids for ticket 07 without stopping them', async () => {
    const rootId = 'root-session'
    const jobs: JobRegistryLike = {
      list(caller) {
        return String(caller) === rootId
          ? [{ id: 'job-root-1', kind: 'workflow', owner: rootId, status: 'running' }]
          : []
      },
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
      kind: 'workflow',
      owner: rootId,
      ownerKind: 'root',
      status: 'running',
      disposition: 'recorded',
    }])
    // Ticket 06 records jobs only; it never kills them.
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

  it('cancels the pause and releases parked children when the user starts a new direction', async () => {
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
    expect(child.batches).toEqual([[]])
    expect(latestManifest(world.root)?.children[0]?.state).toBe('cancelled')
  })
})

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
