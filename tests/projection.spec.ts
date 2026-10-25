import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ultracodeProjectionDefinition as definition } from '../src/projection.js'

function event(type: string, data: unknown): SessionEvent {
  return { type, data, seq: 1, time: 0, ignorable: true } as unknown as SessionEvent
}

describe('ultracode projection', () => {
  it('folds pause, run, and mode into the client view', () => {
    let state = definition.init({} as never, 0 as never)
    state = definition.apply(state, event('plugin:ultracode/pause', {
      paused: true,
      reason: 'user',
      turn: 3,
      atSeq: 7,
      updatedAt: 0,
    }))
    state = definition.apply(state, event('plugin:ultracode/run', {
      runId: 'run-1',
      skill: 'tdd',
      phase: 'paused_user',
      round: 2,
      maxRounds: 60,
      startedAt: 0,
      updatedAt: 0,
    }))
    state = definition.apply(state, event('plugin:ultracode/mode', {
      enabled: true,
      updatedAt: 0,
    }))

    expect(definition.stateSchema.parse(state)).toEqual(state)
    const view = definition.wire.view(state)
    expect(view).toEqual({
      paused: true,
      reason: 'user',
      pauseStatus: null,
      run: { runId: 'run-1', skill: 'tdd', phase: 'paused_user', round: 2, maxRounds: 60 },
      mode: 'on',
    })
    expect(definition.wire.viewSchema.parse(view)).toEqual(view)
  })

  it('carries the waiting-on-job phase to the client view', () => {
    let state = definition.init({} as never, 0 as never)
    state = definition.apply(state, event('plugin:ultracode/run', {
      runId: 'run-2',
      skill: 'implement',
      phase: 'waiting_job',
      round: 3,
      maxRounds: 120,
      startedAt: 0,
      updatedAt: 0,
      reason: 'waiting for background job',
    }))

    const view = definition.wire.view(state)
    expect(view.run?.phase).toBe('waiting_job')
    expect(definition.wire.viewSchema.parse(view)).toEqual(view)
  })

  it('carries pausing progress and forced counts from the pause manifest', () => {
    let state = definition.init({} as never, 0 as never)
    state = definition.apply(state, event('plugin:ultracode/pause-manifest', {
      pauseId: 'pause-1',
      rootId: 'root-1',
      phase: 'paused',
      startedAt: 0,
      updatedAt: 0,
      timeoutMs: 60_000,
      children: [
        { id: 'child-1', mode: 'continuable', state: 'parked', forced: false },
        { id: 'child-2', mode: 'continuable', state: 'parked', forced: false },
        { id: 'child-3', mode: 'continuable', state: 'forced', forced: true },
      ],
      jobs: [],
      forced: 1,
      warning: 'Subagent child-3 could not be resumed.',
    }))

    expect(definition.wire.view(state).pauseStatus).toEqual({
      phase: 'paused',
      acknowledged: 2,
      total: 3,
      forced: 1,
      warning: 'Subagent child-3 could not be resumed.',
    })
    expect(definition.wire.viewSchema.parse(definition.wire.view(state))).toEqual(definition.wire.view(state))
    expect(definition.stateSchema.parse(state)).toEqual(state)
  })

  it('loads an old projection state without pause progress', () => {
    const oldState = {
      pause: null,
      run: null,
      mode: 'off' as const,
    }
    expect(definition.stateSchema.parse(oldState)).toEqual({
      ...oldState,
      pauseStatus: null,
    })
  })

  it('clears the pause and returns the same reference for unrelated events', () => {
    let state = definition.init({} as never, 0 as never)
    state = definition.apply(state, event('plugin:ultracode/pause', {
      paused: true,
      reason: 'user',
      turn: 1,
      atSeq: 2,
      updatedAt: 0,
    }))
    const unchanged = definition.apply(state, event('tool/call', {}))
    expect(unchanged).toBe(state)
    state = definition.apply(state, event('plugin:ultracode/pause', {
      paused: false,
      reason: 'resumed',
      turn: 1,
      atSeq: 3,
      updatedAt: 0,
    }))
    expect(definition.wire.view(state).paused).toBe(false)
  })
})
