import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../src/state.js'
import { resolveConfig } from '../src/config.js'
import {
  activeElapsedMs,
  appendModeEvent,
  appendRunEvent,
  createRunState,
  fromRunEvent,
  hasPriorTurn,
  inboxHasUserWork,
  isRootAgent,
  isUnfinishedPhase,
  latestArtifactPaths,
  latestModeEvent,
  latestModelSelection,
  latestPauseEvent,
  latestRunEvent,
  liveOwnedJob,
  markRunWaiting,
  openTurn,
  resumeRunActive,
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

function legacyEvent(type: string, data: unknown, seq: number, ignorable = true): SessionEvent {
  return { type, data, seq, time: 0, ...ignorable ? { ignorable: true as const } : {} } as unknown as SessionEvent
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

  it('reads a legacy log whose plugin events predate the plugin-record envelope', () => {
    const id = SessionId('legacy-session')
    const seed: SessionEvent[] = [
      legacyEvent('model/selection', {
        provider: 'deepseek-official',
        model: 'mock',
        reasoningEffort: 'max',
      }, 0),
      legacyEvent('autopilot/run', {
        runId: 'legacy-run',
        skill: 'tdd',
        phase: 'paused_user',
        round: 2,
        maxRounds: 60,
        startedAt: 1,
        updatedAt: 2,
      }, 1),
      legacyEvent('ultracode/mode', { enabled: true, source: 'selector', updatedAt: 2 }, 2),
      legacyEvent('ultracode/pause', {
        paused: true,
        reason: 'user',
        turn: 1,
        atSeq: 2,
        updatedAt: 2,
      }, 3),
      legacyEvent('turn/start', { turn: 1 }, 4, false),
      legacyEvent('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 5, false),
    ]
    const session = Session.create(id, seed)
    const events = session.snapshotEvents()
    const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }

    expect(() => validateStoredEvents(header, [...events])).not.toThrow()
    expect(latestModelSelection(events)?.reasoningEffort).toBe('max')
    expect(latestRunEvent(events)?.phase).toBe('paused_user')
    expect(latestModeEvent(events)?.enabled).toBe(true)
    expect(latestPauseEvent(events)?.paused).toBe(true)
    expect(hasPriorTurn({ session })).toBe(true)
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
    const runRecord = events.find(event => (event.type as string) === 'plugin:ultracode/run')
    const modeRecord = events.find(event => (event.type as string) === 'plugin:ultracode/mode')
    expect(runRecord?.ignorable).toBe(true)
    expect(modeRecord?.ignorable).toBe(true)

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
    expect(isUnfinishedPhase('waiting_job')).toBe(true)
    expect(isUnfinishedPhase('paused_user')).toBe(true)
    expect(isUnfinishedPhase('paused_resume')).toBe(true)
    expect(isUnfinishedPhase('completed')).toBe(false)
    expect(isUnfinishedPhase('exhausted')).toBe(false)
    expect(isUnfinishedPhase('cancelled')).toBe(false)
    expect(isUnfinishedPhase('error')).toBe(false)
  })

  it('measures active time with waiting and paused spans excluded', () => {
    const run = createRunState('tdd', resolveConfig())
    run.startedAt = 1_000
    expect(activeElapsedMs(run, 6_000)).toBe(5_000)

    markRunWaiting(run, 2_000)
    expect(activeElapsedMs(run, 10_000)).toBe(1_000)

    resumeRunActive(run, 10_000)
    expect(run.inactiveMs).toBe(8_000)
    expect(activeElapsedMs(run, 12_000)).toBe(3_000)

    markRunWaiting(run, 12_000)
    expect(activeElapsedMs(run, 20_000)).toBe(3_000)

    resumeRunActive(run, 20_000)
    expect(activeElapsedMs(run, 21_000)).toBe(4_000)
  })

  it('persists earlier inactive spans so a reload cannot count them as active', () => {
    const agent = carrier()
    const config = resolveConfig()
    const run = createRunState('tdd', config)
    run.phase = 'running'
    run.startedAt = 1_000
    markRunWaiting(run, 2_000)
    resumeRunActive(run, 10_000)
    expect(run.inactiveMs).toBe(8_000)

    appendRunEvent(agent, run)
    const first = latestRunEvent(agent.session.snapshotEvents())!
    expect(first.inactiveMs).toBe(8_000)
    const restored = fromRunEvent(first, config)
    expect(restored.inactiveMs).toBe(8_000)
    expect(activeElapsedMs(restored, 12_000)).toBe(3_000)

    // A second waiting span (with its start time) also survives a reload:
    // the whole span, not just time since the last record, stays inactive.
    markRunWaiting(restored, 12_000)
    appendRunEvent(agent, restored)
    const second = latestRunEvent(agent.session.snapshotEvents())!
    expect(second.inactiveSince).toBe(12_000)
    const reRestored = fromRunEvent(second, config)
    expect(reRestored.inactiveMs).toBe(8_000)
    expect(reRestored.inactiveSince).toBe(12_000)
    expect(activeElapsedMs(reRestored, 22_000)).toBe(3_000)
  })

  it('collects bounded, unique artifact paths from present events', () => {
    const agent = carrier()
    const append = (files: Array<{ path: string }>): void => {
      ;(agent.session as unknown as { append(type: string, data: unknown): unknown }).append(
        'deliverables/presented',
        { turn: 1, callId: `present-${files.length}`, files },
      )
    }
    append([{ path: 'C:/tmp/report.md' }, { path: 'C:/tmp/data.csv' }])
    append([{ path: 'C:/tmp/data.csv' }, { path: 'C:/tmp/final.pdf' }])
    expect(latestArtifactPaths(agent)).toEqual([
      'C:/tmp/report.md',
      'C:/tmp/data.csv',
      'C:/tmp/final.pdf',
    ])

    const many = Array.from({ length: 25 }, (_value, index) => ({ path: `C:/tmp/artifact-${index}.txt` }))
    append(many)
    const bounded = latestArtifactPaths(agent)
    expect(bounded).toHaveLength(20)
    expect(bounded.at(0)).toBe('C:/tmp/artifact-5.txt')
    expect(bounded.at(-1)).toBe('C:/tmp/artifact-24.txt')
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

  it('recognizes only running jobs owned by the session', () => {
    const owner = 'owner-session'
    const registry = {
      list: () => [
        { id: 'foreign', owner: 'other-session', status: 'running' },
        { id: 'stopping', owner, status: 'stopping' },
        { id: 'unowned', status: 'running' },
        { id: 'live', owner, status: 'running' },
      ],
    }

    expect(liveOwnedJob(registry, owner)?.id).toBe('live')
    expect(liveOwnedJob(undefined, owner)).toBeUndefined()
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
