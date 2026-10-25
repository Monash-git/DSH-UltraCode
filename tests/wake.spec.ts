import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { PauseController } from '../src/pause.js'
import { ultracodeProjectionDefinition as projection } from '../src/projection.js'
import {
  appendPauseManifest,
  appendRunEvent,
  createRunState,
  fromRunEvent,
  latestPauseEvent,
  latestPauseManifest,
  latestRunEvent,
  sessionKey,
} from '../src/state.js'
import { WakeGate, WAKE_HOLD_RECORD, WAKE_RELEASE_RECORD } from '../src/wake.js'

class FakeInbox {
  nextStep: UserMessage[] = []
  nextTurn: UserMessage[] = []
  append(target: 'next-step' | 'next-turn', message: UserMessage): void {
    ;(target === 'next-step' ? this.nextStep : this.nextTurn).push(message)
  }
  remove(id: string): boolean {
    for (const list of [this.nextStep, this.nextTurn]) {
      const index = list.findIndex(message => message.id === id)
      if (index >= 0) {
        list.splice(index, 1)
        return true
      }
    }
    return false
  }
}

function fakeAgent(status: 'idle' | 'running' = 'idle') {
  const session = Session.create(SessionId(`wake-${Math.random().toString(36).slice(2)}`))
  const inbox = new FakeInbox()
  const steered: UserMessage[] = []
  const followed: UserMessage[] = []
  const cancel = vi.fn()
  const agent = {
    session,
    inbox,
    get status() { return status },
    cancel: (cause: unknown, options: unknown) => {
      cancel(cause, options)
      status = 'idle'
    },
    steer(message: UserMessage) {
      steered.push(message)
      inbox.append('next-step', message)
    },
    followup(message: UserMessage) {
      followed.push(message)
      inbox.append('next-turn', message)
    },
  } as unknown as Agent
  return { agent, session, inbox, steered, followed, cancel }
}

function setup(status: 'idle' | 'running' = 'idle') {
  const config = resolveConfig()
  const runs = new Map()
  const flushes: string[] = []
  const wake = new WakeGate({
    flush: agent => { flushes.push(String(agent.session.id)) },
  })
  const pause = new PauseController(config, runs, undefined, wake)
  return { config, runs, pause, wake, flushes, ...fakeAgent(status) }
}

function notice(text = 'background job job-1 (workflow: demo) finished [status: completed].'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'tool-jobs', form: 'notice' },
  })
}

function heldRecords(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .map(event => pluginRecordOf(event))
    .filter(record => record?.type === WAKE_HOLD_RECORD)
    .map(record => record!.data as Record<string, unknown>)
}

function releaseRecords(agent: Agent): Array<Record<string, unknown>> {
  return agent.session.snapshotEvents()
    .map(event => pluginRecordOf(event))
    .filter(record => record?.type === WAKE_RELEASE_RECORD)
    .map(record => record!.data as Record<string, unknown>)
}

describe('durable completion-wake gate', () => {
  it('holds a background wake while paused, then releases it only on resume', async () => {
    const { agent, pause, wake, flushes, inbox, steered } = setup('running')
    pause.pause(agent)
    expect(pause.isPaused(agent)).toBe(true)

    const wakeMessage = notice()
    const action = await pause.onPreStep(agent, [wakeMessage])

    expect(action.kind).toBe('held')
    expect(pause.isPaused(agent)).toBe(true)
    expect(steered).toEqual([])
    expect(flushes).toContain(String(agent.session.id))
    expect(heldRecords(agent)).toEqual([
      expect.objectContaining({
        holdId: expect.any(String),
        messages: [{
          content: [{ type: 'text', text: 'background job job-1 (workflow: demo) finished [status: completed].' }],
          source: { kind: 'tool-jobs', form: 'notice' },
        }],
      }),
    ])
    expect(wake.held(agent)).toHaveLength(1)

    const resumed = await pause.resumeAsync(agent)
    expect(resumed.ok).toBe(true)
    expect(pause.isPaused(agent)).toBe(false)
    expect(wake.held(agent)).toHaveLength(0)
    expect(releaseRecords(agent)).toEqual([
      expect.objectContaining({ holdId: heldRecords(agent)[0]!.holdId, reason: 'play' }),
    ])
    // The held notice is handed to the model together with the resume prompt.
    expect(inbox.nextStep.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'background job job-1 (workflow: demo) finished [status: completed].' }],
      [expect.objectContaining({ type: 'text', text: expect.stringContaining('ultracode_resume') })],
    ])
    expect(inbox.nextStep[0]?.source).toEqual({ kind: 'tool-jobs', form: 'notice' })
    expect(steered).toHaveLength(1)
  })

  it('cancels the pause when text arrives and releases held wakes into the new direction', async () => {
    const { agent, pause, inbox, steered } = setup('running')
    pause.pause(agent)
    await pause.onPreStep(agent, [notice()])

    const action = await pause.onPreStep(agent, [user('change direction')])

    expect(action.kind).toBe('released')
    expect(action.kind === 'released' && action.messages.map(message => message.source.kind))
      .toEqual(['tool-jobs'])
    expect(pause.isPaused(agent)).toBe(false)
    expect(releaseRecords(agent)).toEqual([
      expect.objectContaining({ reason: 'user-direction' }),
    ])
    // The waking user message itself is already in the claimed batch; the
    // held notice joins it, so a new direction still sees what finished.
    expect(inbox.nextStep).toEqual([])
    expect(steered).toEqual([])
    expect(heldRecords(agent)).toHaveLength(1)
  })

  it('restores pause and held wakes after a process restart without resuming, then replays on Play', async () => {
    const config = resolveConfig()
    const { agent, inbox, steered, followed } = fakeAgent('idle')
    const runs = new Map()
    const first = new WakeGate({ flush: () => {} })
    const pause = new PauseController(config, runs, undefined, first)
    const run = createRunState('tdd', config)
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    await pause.onPreStep(agent, [notice('first job finished')])
    expect(pause.isPaused(agent)).toBe(true)

    // A process restart is a fresh plugin view over the persisted log.
    const restoredRuns = new Map()
    restoredRuns.set(sessionKey(agent), fromRunEvent(latestRunEvent(agent.session.snapshotEvents())!, config))
    const replayFlushes: string[] = []
    const replayWake = new WakeGate({ flush: actor => { replayFlushes.push(String(actor.session.id)) } })
    const restored = new PauseController(config, restoredRuns, undefined, replayWake)
    restored.onCreated(agent)

    expect(restored.isPaused(agent)).toBe(true)
    expect(latestPauseEvent(agent.session.snapshotEvents())?.paused).toBe(true)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('paused_resume')
    expect(steered).toEqual([])
    expect(followed).toEqual([])

    // A completion notice still cannot start a turn after the reload.
    const action = await restored.onPreStep(agent, [notice('second job finished')])
    expect(action.kind).toBe('held')
    expect(replayWake.held(agent)).toHaveLength(2)

    const resumed = await restored.resumeAsync(agent)
    expect(resumed.ok).toBe(true)
    expect(replayFlushes).toContain(String(agent.session.id))
    expect(replayWake.held(agent)).toHaveLength(0)
    expect(releaseRecords(agent)).toHaveLength(2)
    expect(inbox.nextStep.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'first job finished' }],
      [{ type: 'text', text: 'second job finished' }],
      [expect.objectContaining({ type: 'text', text: expect.stringContaining('<autopilot_continue') })],
    ])
  })

  it('keeps an explicit pause across reload even when the run was waiting for an answer', () => {
    const config = resolveConfig()
    const { agent, steered, followed } = fakeAgent('idle')
    const runs = new Map()
    const pause = new PauseController(config, runs, undefined, new WakeGate())
    const run = createRunState('tdd', config)
    run.phase = 'waiting_user'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    expect(pause.isPaused(agent)).toBe(true)

    const restoredRuns = new Map()
    restoredRuns.set(sessionKey(agent), fromRunEvent(latestRunEvent(agent.session.snapshotEvents())!, config))
    const restored = new PauseController(config, restoredRuns, undefined, new WakeGate())
    restored.onCreated(agent)

    expect(restored.isPaused(agent)).toBe(true)
    expect(restored.reasonOf(agent)).toBe('user')
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('paused_resume')
    expect(steered).toEqual([])
    expect(followed).toEqual([])
  })

  it('restores a crash tail with a held wake and never auto-resumes it', async () => {
    const config = resolveConfig()
    const { agent, inbox, steered, followed } = fakeAgent('idle')
    const runs = new Map()
    const pause = new PauseController(config, runs, undefined, new WakeGate())
    const run = createRunState('tdd', config)
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    await pause.onPreStep(agent, [notice('crashed job finished')])
    // The wake turn opened, then the process died before its turn/end.
    agent.session.append('turn/start', { turn: 1 })

    const restoredRuns = new Map()
    restoredRuns.set(sessionKey(agent), fromRunEvent(latestRunEvent(agent.session.snapshotEvents())!, config))
    const replayWake = new WakeGate()
    const restored = new PauseController(config, restoredRuns, undefined, replayWake)
    restored.onCreated(agent)

    expect(restored.isPaused(agent)).toBe(true)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('paused_resume')
    expect(steered).toEqual([])
    expect(followed).toEqual([])
    expect(replayWake.held(agent)).toHaveLength(1)

    const resumed = await restored.resumeAsync(agent)
    expect(resumed.ok).toBe(true)
    expect(inbox.nextStep.map(message => message.content[0]))
      .toEqual([
        { type: 'text', text: 'crashed job finished' },
        expect.objectContaining({ type: 'text', text: expect.stringContaining('<autopilot_continue') }),
      ])
    expect(replayWake.held(agent)).toHaveLength(0)
  })

  it('settles an interrupted pausing manifest so reopening shows Play', async () => {
    const config = resolveConfig()
    const { agent } = fakeAgent('idle')
    const runs = new Map()
    const pause = new PauseController(config, runs, undefined, new WakeGate())
    const run = createRunState('tdd', config)
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    appendPauseManifest(agent, {
      pauseId: 'pause-crashed',
      rootId: String(agent.session.id),
      phase: 'pausing',
      startedAt: 1,
      updatedAt: 1,
      timeoutMs: 60_000,
      children: [{ id: 'child-1', mode: 'continuable', state: 'pausing' }],
      jobs: [],
      forced: 0,
    })

    const restoredRuns = new Map()
    restoredRuns.set(sessionKey(agent), fromRunEvent(latestRunEvent(agent.session.snapshotEvents())!, config))
    const restored = new PauseController(config, restoredRuns, undefined, new WakeGate())
    restored.onCreated(agent)

    expect(restored.isPaused(agent)).toBe(true)
    expect(latestPauseManifest(agent.session.snapshotEvents())?.phase).toBe('paused')

    let state = projection.init({} as never, 0 as never)
    for (const event of agent.session.snapshotEvents()) state = projection.apply(state, event)
    const view = projection.wire.view(state)
    expect(view.paused).toBe(true)
    expect(view.pauseStatus?.phase).toBe('paused')
  })

  it('settles a pausing manifest on hot reload so the primary control shows Play', () => {
    const config = resolveConfig()
    const { agent } = fakeAgent('idle')
    const runs = new Map()
    const pause = new PauseController(config, runs, undefined, new WakeGate())
    const run = createRunState('tdd', config)
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    appendPauseManifest(agent, {
      pauseId: 'pause-reloaded',
      rootId: String(agent.session.id),
      phase: 'pausing',
      startedAt: 1,
      updatedAt: 1,
      timeoutMs: 60_000,
      children: [{ id: 'child-1', mode: 'continuable', state: 'pausing' }],
      jobs: [{ id: 'job-1', ownerKind: 'root', status: 'running', disposition: 'recorded' }],
      forced: 0,
    })

    const reloaded = new PauseController(config, runs, undefined, new WakeGate())
    reloaded.hydrate(agent)

    const manifest = latestPauseManifest(agent.session.snapshotEvents())
    expect(manifest?.phase).toBe('paused')
    // A hot reload keeps the process (and its jobs) alive: no lost-job claim.
    expect(manifest?.warning).toBeUndefined()

    let state = projection.init({} as never, 0 as never)
    for (const event of agent.session.snapshotEvents()) state = projection.apply(state, event)
    expect(projection.wire.view(state).paused).toBe(true)
    expect(projection.wire.view(state).pauseStatus?.phase).toBe('paused')
  })

  it('says on load and Play that background jobs did not survive the restart', async () => {
    const config = resolveConfig()
    const { agent, inbox } = fakeAgent('idle')
    const runs = new Map()
    const pause = new PauseController(config, runs, undefined, new WakeGate())
    const run = createRunState('tdd', config)
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.pause(agent)
    appendPauseManifest(agent, {
      pauseId: 'pause-1',
      rootId: String(agent.session.id),
      phase: 'paused',
      startedAt: 1,
      updatedAt: 1,
      timeoutMs: 60_000,
      children: [],
      jobs: [
        {
          id: 'job-1',
          kind: 'workflow',
          owner: String(agent.session.id),
          ownerKind: 'root',
          status: 'running',
          disposition: 'recorded',
        },
      ],
      forced: 0,
    })

    const restoredRuns = new Map()
    restoredRuns.set(sessionKey(agent), fromRunEvent(latestRunEvent(agent.session.snapshotEvents())!, config))
    const restored = new PauseController(config, restoredRuns, undefined, new WakeGate())
    restored.onCreated(agent)

    expect(restored.isPaused(agent)).toBe(true)
    expect(latestPauseManifest(agent.session.snapshotEvents())?.warning)
      .toContain('did not survive the process restart')

    const resumed = await restored.resumeAsync(agent)
    expect(resumed.ok).toBe(true)
    expect(resumed.text).toContain('did not survive the process restart')
    expect(inbox.nextStep.at(-1)?.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('<autopilot_continue') }),
    ])
  })
})

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
