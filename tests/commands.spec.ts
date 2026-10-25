import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  handleAutopilotCommand,
  handlePauseCommand,
  handleResumeCommand,
  handleUltraCommand,
  type CommandContext,
} from '../src/commands.js'
import { resolveConfig } from '../src/config.js'
import {
  appendModeEvent,
  createRunState,
  latestModeEvent,
  latestModelSelection,
  latestRunEvent,
  sessionKey,
} from '../src/state.js'

function fakeAgent(): {
  agent: Agent
  session: Session
  steer: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
} {
  const session = Session.create(SessionId('cmd-test'))
  const steer = vi.fn()
  const followup = vi.fn()
  const agent = { session, steer, followup, status: 'idle' } as unknown as Agent
  return { agent, session, steer, followup }
}

function fakeContext(overrides: Partial<CommandContext> = {}): {
  context: CommandContext
  pause: CommandContext['pause']
  ultra: CommandContext['ultra']
  runs: Map<string, ReturnType<typeof createRunState>>
} {
  const runs = overrides.runs ?? new Map<string, ReturnType<typeof createRunState>>()
  const pause = overrides.pause ?? {
    isPaused: vi.fn(() => false),
    reasonOf: vi.fn(() => undefined),
    requestCancel: vi.fn(),
    pause: vi.fn(() => ({ ok: true, text: 'Session paused.' })),
    resume: vi.fn(() => ({ ok: true, text: 'Session resumed.' })),
  } as unknown as CommandContext['pause']
  const ultra = overrides.ultra ?? {
    isSelectorUltra: vi.fn(() => false),
    commandModeOn: vi.fn(() => false),
    selectedEffort: vi.fn(() => undefined),
    setCommandMode: vi.fn((agent: Agent, enabled: boolean) => {
      appendModeEvent(agent, enabled, enabled ? 'command' : 'off', 'command')
    }),
  } as unknown as CommandContext['ultra']
  return { context: { runs, pause, ultra }, pause, ultra, runs }
}

describe('/ultra command', () => {
  it('turns on the standing mode and queues the task without creating a run', () => {
    const { agent, followup } = fakeAgent()
    const { context, ultra, runs } = fakeContext()

    const result = handleUltraCommand(agent, 'audit the repository', context)

    expect(result.kind).toBe('success')
    expect(ultra.setCommandMode).toHaveBeenCalledWith(agent, true)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('audit the repository')
    expect(runs.size).toBe(0)
    expect(latestRunEvent(agent.session.snapshotEvents())).toBeUndefined()
  })

  it('turns the mode off and selects max when the selector is ultra', () => {
    const { agent, followup } = fakeAgent()
    const { context, ultra } = fakeContext()
    agent.session.append('model/selection', {
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })

    const result = handleUltraCommand(agent, 'off', context)

    expect(result.kind).toBe('success')
    expect(ultra.setCommandMode).toHaveBeenCalledWith(agent, false)
    expect(followup).not.toHaveBeenCalled()
    expect(latestModelSelection(agent.session.snapshotEvents())?.reasoningEffort).toBe('max')
    expect(latestModeEvent(agent.session.snapshotEvents())?.enabled).toBe(false)
  })

  it('reports status for an empty argument', () => {
    const { agent } = fakeAgent()
    const { context } = fakeContext()
    const result = handleUltraCommand(agent, '', context)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('Ultra selector')
  })
})

describe('/autopilot command', () => {
  it('reports no active run', () => {
    const { agent } = fakeAgent()
    const { context } = fakeContext()
    const result = handleAutopilotCommand(agent, 'status', context)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('No active autopilot run')
  })

  it('cancels an active run and asks the pause controller to keep inbox work', () => {
    const { agent } = fakeAgent()
    const run = createRunState('wayfinder', resolveConfig())
    run.phase = 'running'
    const runs = new Map([[sessionKey(agent), run]])
    const { context, pause } = fakeContext({ runs })

    const result = handleAutopilotCommand(agent, 'off', context)

    expect(result.kind).toBe('success')
    expect(runs.has(sessionKey(agent))).toBe(false)
    expect(pause.requestCancel).toHaveBeenCalledWith(agent)
    expect(latestRunEvent(agent.session.snapshotEvents())?.phase).toBe('cancelled')
  })

  it('pauses and resumes through the pause controller', () => {
    const { agent } = fakeAgent()
    const { context, pause } = fakeContext()
    expect(handleAutopilotCommand(agent, 'pause', context).kind).toBe('success')
    expect(pause.pause).toHaveBeenCalledWith(agent)
    expect(handleAutopilotCommand(agent, 'resume', context).kind).toBe('success')
    expect(pause.resume).toHaveBeenCalledWith(agent)
  })
})

describe('/pause and /resume commands', () => {
  it('delegate to the pause controller', () => {
    const { agent } = fakeAgent()
    const { context, pause } = fakeContext()
    expect(handlePauseCommand(agent, context).kind).toBe('success')
    expect(handleResumeCommand(agent, context).kind).toBe('success')
    expect(pause.pause).toHaveBeenCalledWith(agent)
    expect(pause.resume).toHaveBeenCalledWith(agent)
  })
})
