import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../src/state.js'
import { resolveConfig } from '../src/config.js'
import {
  appendModeEvent,
  appendRunEvent,
  createRunState,
  fromRunEvent,
  inboxHasUserWork,
  isRootAgent,
  isUnfinishedPhase,
  latestModeEvent,
  latestModelSelection,
  latestRunEvent,
  openTurn,
  sessionKey,
  type SessionCarrier,
} from '../src/state.js'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'todo/write': { todos: TodoItem[] }
  }
}

function carrier(): SessionCarrier {
  return { session: Session.create(SessionId('test-session')) }
}

describe('run state', () => {
  it('creates a run with the wayfinder budget', () => {
    const run = createRunState('wayfinder', resolveConfig())
    expect(run.skill).toBe('wayfinder')
    expect(run.phase).toBe('armed')
    expect(run.round).toBe(1)
    expect(run.maxRounds).toBe(120)
    expect(run.maxDurationMs).toBe(60 * 60 * 1000)
  })

  it('round-trips run and mode events through the session log', () => {
    const agent = carrier()
    const config = resolveConfig()
    const run = createRunState('implement', config)
    run.phase = 'running'
    appendRunEvent(agent, run)
    appendModeEvent(agent, true, 'test')

    const events = agent.session.snapshotEvents()
    const runEvent = latestRunEvent(events)
    expect(runEvent?.skill).toBe('implement')
    expect(runEvent?.phase).toBe('running')
    expect(runEvent?.round).toBe(1)
    expect(latestModeEvent(events)?.enabled).toBe(true)

    const restored = fromRunEvent(runEvent!, config)
    expect(restored.skill).toBe('implement')
    expect(isUnfinishedPhase(restored.phase)).toBe(true)
  })

  it('treats a session without subagent lineage as root', () => {
    const agent = carrier()
    expect(isRootAgent(agent)).toBe(true)
    expect(sessionKey(agent)).toBe('test-session')
  })

  it('treats a subagent session as non-root', () => {
    const id = SessionId('subagent-session')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      isSeeded: false,
      parentSession: SessionId('parent-session'),
      origin: 'subagent',
      delegationDepth: 1,
    })
    expect(isRootAgent({ session })).toBe(false)
  })

  it('classifies phases as unfinished or terminal', () => {
    expect(isUnfinishedPhase('armed')).toBe(true)
    expect(isUnfinishedPhase('running')).toBe(true)
    expect(isUnfinishedPhase('waiting_user')).toBe(true)
    expect(isUnfinishedPhase('paused_user')).toBe(true)
    expect(isUnfinishedPhase('paused_resume')).toBe(true)
    expect(isUnfinishedPhase('completed')).toBe(false)
    expect(isUnfinishedPhase('exhausted')).toBe(false)
    expect(isUnfinishedPhase('cancelled')).toBe(false)
    expect(isUnfinishedPhase('error')).toBe(false)
  })

  it('reads the latest model selection and open turn', () => {
    const agent = carrier()
    ;(agent.session as unknown as { append(type: string, data: unknown): unknown }).append('model/selection', {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    expect(latestModelSelection(agent.session.snapshotEvents())?.reasoningEffort).toBe('ultra')
    agent.session.append('turn/start', { turn: 4 })
    expect(openTurn(agent)).toBe(4)
    agent.session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    expect(openTurn(agent)).toBe(0)
  })

  it('detects pending user work in either inbox list', () => {
    const message = {
      id: 'm',
      role: 'user' as const,
      content: [],
      source: { kind: 'user' as const },
    }
    const injected = { ...message, source: { kind: 'autopilot' as const } }
    expect(inboxHasUserWork({ inbox: { nextTurn: [], nextStep: [] } } as never)).toBe(false)
    expect(inboxHasUserWork({ inbox: { nextTurn: [injected], nextStep: [] } } as never)).toBe(false)
    expect(inboxHasUserWork({ inbox: { nextTurn: [message], nextStep: [] } } as never)).toBe(true)
    expect(inboxHasUserWork({ inbox: { nextTurn: [], nextStep: [message] } } as never)).toBe(true)
  })
})
