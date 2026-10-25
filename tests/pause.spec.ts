import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { PauseController } from '../src/pause.js'
import {
  appendPauseEvent,
  appendRunEvent,
  createRunState,
  latestPauseEvent,
  latestRunEvent,
  sessionKey,
} from '../src/state.js'

function fakeAgent(status: 'idle' | 'running' = 'running') {
  const session = Session.create(SessionId(`pause-${Math.random().toString(36).slice(2)}`))
  const cancel = vi.fn()
  const steer = vi.fn()
  const agent = {
    session,
    cancel,
    steer,
    status,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  return { agent, session, cancel, steer }
}

function setup(status: 'idle' | 'running' = 'running') {
  const config = resolveConfig()
  const runs = new Map()
  const pause = new PauseController(config, runs)
  return { config, runs, pause, ...fakeAgent(status) }
}

describe('PauseController', () => {
  it('pauses a running root session, preserves the inbox, and resumes with one message', () => {
    const { agent, pause, cancel, steer, runs } = setup()
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'running'
    runs.set(sessionKey(agent), run)

    const paused = pause.pause(agent)
    expect(paused.ok).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(pause.isPaused(agent)).toBe(true)
    expect(latestPauseEvent(agent.session.snapshotEvents())?.paused).toBe(true)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('paused_user')

    const resumed = pause.resume(agent)
    expect(resumed.ok).toBe(true)
    expect(pause.isPaused(agent)).toBe(false)
    expect(steer).toHaveBeenCalledTimes(1)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('running')
    expect(latestPauseEvent(agent.session.snapshotEvents())?.paused).toBe(false)
  })

  it('records a normal root turn interrupted by Stop as paused', () => {
    const { agent, pause } = setup()
    const signal = new AbortController()
    signal.abort()
    const outcome = pause.onTurnStopping(agent, 1, signal.signal)
    expect(outcome).toBe('paused')
    expect(pause.isPaused(agent)).toBe(true)
  })

  it('restores durable pause state on a live reload without recording a restart', () => {
    const { agent, pause, runs } = setup('running')
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    appendPauseEvent(agent, {
      paused: true,
      reason: 'user',
      turn: 1,
      atSeq: 2,
      updatedAt: Date.now(),
    })
    const before = agent.session.snapshotEvents()

    pause.hydrate(agent)

    expect(pause.isPaused(agent)).toBe(true)
    expect(pause.reasonOf(agent)).toBe('user')
    expect(agent.session.snapshotEvents()).toEqual(before)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('running')
  })

  it('does not pause a running session just because the plugin reloaded', () => {
    const { agent, pause, runs } = setup('running')
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)

    pause.hydrate(agent)

    expect(pause.isPaused(agent)).toBe(false)
    expect(latestPauseEvent(agent.session.snapshotEvents())).toBeUndefined()
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('running')
  })

  it('loads an old paused session without appending another pause record', () => {
    const { agent, pause } = setup('idle')
    appendPauseEvent(agent, {
      paused: true,
      reason: 'user',
      turn: 1,
      atSeq: 0,
      updatedAt: Date.now(),
    })
    const before = agent.session.snapshotEvents()

    pause.onCreated(agent)

    expect(pause.isPaused(agent)).toBe(true)
    expect(pause.reasonOf(agent)).toBe('user')
    expect(agent.session.snapshotEvents()).toEqual(before)
  })

  it('promotes an unfinished run to paused_resume when a persisted session loads', () => {
    const { agent, pause, runs } = setup('idle')
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'running'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)

    pause.onCreated(agent)

    expect(pause.isPaused(agent)).toBe(true)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('paused_resume')
  })

  it('restores an interrupted turn from the log on agent creation', () => {
    const { agent, pause } = setup('idle')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    pause.onCreated(agent)
    expect(pause.isPaused(agent)).toBe(true)
    expect(latestPauseEvent(agent.session.snapshotEvents())?.reason).toBe('interrupted')
  })

  it('keeps a model question in waiting_user instead of the play-button pause', () => {
    const { agent, pause, runs } = setup('idle')
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'waiting_user'
    runs.set(sessionKey(agent), run)
    appendRunEvent(agent, run)
    pause.onCreated(agent)
    expect(pause.isPaused(agent)).toBe(false)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('waiting_user')
  })

  it('clears a pause when the user starts a new direction', async () => {
    const { agent, pause, runs } = setup()
    const run = createRunState('tdd', resolveConfig())
    run.phase = 'paused_user'
    runs.set(sessionKey(agent), run)
    pause.pause(agent)
    const cleared = await pause.onPreStep(agent, [createUserMessage({
      content: [{ type: 'text', text: 'new direction' }],
      source: { kind: 'user' },
    })])
    expect(cleared.kind).toBe('released')
    expect(pause.isPaused(agent)).toBe(false)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('cancelled')
  })

  it('leaves the pause intact when the resume steer fails', () => {
    const { agent, pause, steer } = setup()
    pause.pause(agent)
    steer.mockImplementation(() => { throw new Error('session closed') })
    const resumed = pause.resume(agent)
    expect(resumed.ok).toBe(false)
    expect(pause.isPaused(agent)).toBe(true)
    expect(latestPauseEvent(agent.session.snapshotEvents())?.paused).toBe(true)
  })

  it('does not record a pause for an explicit autopilot off', () => {
    const { agent, pause } = setup()
    pause.requestCancel(agent)
    const outcome = pause.onTurnStopping(agent, 1, new AbortController().signal)
    expect(outcome).toBe('cancelled')
    expect(pause.isPaused(agent)).toBe(false)
  })
})
