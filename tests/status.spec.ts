import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { createRunState } from '../src/state.js'
import {
  collectStatus,
  createSessionStatusTool,
  renderStatus,
  type StatusJobView,
} from '../src/status.js'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'todo/write': { todos: { content: string; status: string }[] }
  }
}

function event(type: string, data: unknown, seq: number, time: number): SessionEvent {
  return { type, data, seq, time } as unknown as SessionEvent
}

function rootAgent(): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(`status-root-${Math.random().toString(36).slice(2)}`))
  return { agent: { session, status: 'running' } as unknown as Agent, session }
}

function subagent(): { agent: Agent; session: Session } {
  const id = SessionId(`status-child-${Math.random().toString(36).slice(2)}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    parentSession: SessionId('parent-session'),
    origin: 'subagent',
    delegationDepth: 1,
  })
  return { agent: { session, status: 'running' } as unknown as Agent, session }
}

function runningRun() {
  const run = createRunState('implement', resolveConfig())
  run.phase = 'running'
  run.round = 3
  return run
}

function job(overrides: Partial<StatusJobView> & Pick<StatusJobView, 'id'>): StatusJobView {
  return {
    kind: 'workflow',
    label: 'verify build',
    status: 'running',
    startedAt: 1,
    ...overrides,
  }
}

describe('collectStatus', () => {
  it('reports the current turn, step, run, todo summary, owned jobs, and pause state', () => {
    const run = runningRun()
    const jobs = [
      job({ id: 'job-live', owner: 'root-session', progress: '2/3' }),
      job({ id: 'job-settled', owner: 'root-session', status: 'completed' }),
      job({ id: 'job-foreign', owner: 'other-session' }),
      job({ id: 'job-unowned' }),
    ]
    const events = [
      event('turn/start', { turn: 4 }, 0, 100),
      event('step/start', { turn: 4, step: 1 }, 1, 101),
      event('todo/write', {
        todos: [
          { content: 'Inspect the request path', status: 'completed' },
          { content: 'Add the regression test', status: 'in_progress' },
          { content: 'Run the full suite', status: 'pending' },
        ],
      }, 2, 2_023),
      event('tool/call', {
        turn: 4,
        step: 7,
        callId: 'call-status',
        name: 'session_status',
        arguments: '{}',
      }, 3, 102),
    ]

    const status = collectStatus({
      sessionId: 'root-session',
      sessionStatus: 'running',
      events,
      run,
      jobs,
      paused: true,
      pauseReason: 'user',
      now: 999,
    })

    expect(status.session).toEqual({ id: 'root-session', status: 'running' })
    expect(status.turn).toBe(4)
    expect(status.step).toBe(7)
    expect(status.run).toEqual({ phase: 'running', round: 3, maxRounds: run.maxRounds })
    expect(status.todos).toEqual({ total: 3, completed: 1, open: 2, updatedAt: 2_023 })
    expect(status.jobs.map(item => item.id)).toEqual(['job-live'])
    expect(status.jobs[0]).toMatchObject({ progress: '2/3' })
    expect(status.pause).toEqual({ paused: true, reason: 'user' })
    expect(status.generatedAt).toBe(999)
  })

  it('reports empty state before any run, todo write, or job exists', () => {
    const status = collectStatus({
      sessionId: 'root-session',
      sessionStatus: 'idle',
      events: [],
      now: 5,
    })

    expect(status.turn).toBe(0)
    expect(status.step).toBe(0)
    expect(status.run).toBeNull()
    expect(status.todos).toEqual({ total: 0, completed: 0, open: 0, updatedAt: null })
    expect(status.jobs).toEqual([])
    expect(status.pause).toEqual({ paused: false, reason: null })
    expect(status.generatedAt).toBe(5)
  })

  it('renders a readable progress snapshot without skill or ticket vocabulary', () => {
    const status = collectStatus({
      sessionId: 'root-session',
      sessionStatus: 'running',
      events: [
        event('turn/start', { turn: 4 }, 0, 100),
        event('todo/write', { todos: [{ content: 'one', status: 'completed' }] }, 1, 2_023),
      ],
      run: runningRun(),
      jobs: [job({ id: 'job-live', owner: 'root-session', progress: '2/3' })],
      paused: true,
      pauseReason: 'user',
      now: 999,
    })

    const text = renderStatus(status)
    expect(text).toContain('turn: 4')
    expect(text).toContain('step: 0')
    expect(text).toContain('run: running')
    expect(text).toContain('round 3/')
    expect(text).toContain('todos: 1 completed, 0 open')
    expect(text).toContain('jobs: 1 active')
    expect(text).toContain('job-live')
    expect(text).toContain('verify build')
    expect(text).toContain('pause: paused (user)')
    expect(text).not.toContain('implement')
  })
})

describe('session_status tool', () => {
  it('returns the root session report without appending to the session log', async () => {
    const { agent, session } = rootAgent()
    const run = runningRun()
    const readJobs = vi.fn(() => [job({ id: 'job-live', owner: String(session.id) })])
    const tool = createSessionStatusTool({
      runs: new Map([[String(session.id), run]]),
      pause: { isPaused: () => false, reasonOf: () => undefined },
      readJobs,
    })
    const before = session.snapshotEvents().length

    const value = await tool.execute({}, { agent } as unknown as ToolRunContext)

    expect(readJobs).toHaveBeenCalledWith(agent)
    expect(JSON.stringify(value)).toContain('"turn":0')
    expect(JSON.stringify(value)).toContain('"phase":"running"')
    expect(JSON.stringify(value)).toContain('job-live')
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('is root-only so it never reports another workspace or a child session', async () => {
    const { agent } = subagent()
    const tool = createSessionStatusTool({
      runs: new Map(),
      pause: { isPaused: () => false, reasonOf: () => undefined },
      readJobs: () => [],
    })

    await expect(tool.execute({}, { agent } as unknown as ToolRunContext))
      .rejects.toThrow(/root agent/i)
  })
})
