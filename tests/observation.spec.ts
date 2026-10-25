import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ObservationController } from '../src/observation.js'
import { OBSERVATION_MARKER, OBSERVATION_PROMPT } from '../src/prompts.js'

/** Ticket, phase, and skill vocabulary must stay out of the generic prompt. */
const FORBIDDEN_OBSERVATION_VOCABULARY = /ticket|phase|skill|wayfinder|tdd/i

function rootAgent(): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(`observation-${Math.random().toString(36).slice(2)}`))
  return { agent: { session } as unknown as Agent, session }
}

function subagent(): { agent: Agent; session: Session } {
  const id = SessionId(`observation-child-${Math.random().toString(36).slice(2)}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    parentSession: SessionId('parent-session'),
    origin: 'subagent',
    delegationDepth: 1,
  })
  return { agent: { session } as unknown as Agent, session }
}

function appendPrompt(session: Session, additions: ReturnType<ObservationController['onPreStep']>): void {
  session.append('user/message', additions[0]!, { surfaceOp: 'append' })
}

function compact(session: Session): void {
  ;(session as unknown as { append(type: string, data: unknown): unknown }).append('compaction/end', {
    compactionId: 'test-compaction',
    turn: null,
  })
}

describe('safe observation prompt', () => {
  it('directs the model to status and session tools instead of raw archives', () => {
    expect(OBSERVATION_PROMPT).toContain(OBSERVATION_MARKER)
    expect(OBSERVATION_PROMPT).toContain('session_status')
    expect(OBSERVATION_PROMPT).toContain('session_search')
    expect(OBSERVATION_PROMPT).toContain('session_event_search')
    expect(OBSERVATION_PROMPT).toContain('session_trace')
    expect(OBSERVATION_PROMPT).toContain('session_event_trace')
    expect(OBSERVATION_PROMPT).toContain('session_event_read')
  })

  it('marks a one-frame archive read as partial and not evidence, and bounds the investigation', () => {
    expect(OBSERVATION_PROMPT).toMatch(/one frame/i)
    expect(OBSERVATION_PROMPT).toMatch(/partial/i)
    expect(OBSERVATION_PROMPT).toMatch(/not (evidence|proof)|never (evidence|proof)/i)
    expect(OBSERVATION_PROMPT).toMatch(/multi-frame/i)
    expect(OBSERVATION_PROMPT).toMatch(/stop/i)
    expect(OBSERVATION_PROMPT).toContain('.zstd')
    expect(OBSERVATION_PROMPT).toContain('node_modules')
    expect(OBSERVATION_PROMPT).toMatch(/profile director/i)
  })

  it('contains no ticket, phase, or skill names', () => {
    expect(OBSERVATION_PROMPT).not.toMatch(FORBIDDEN_OBSERVATION_VOCABULARY)
  })
})

describe('ObservationController', () => {
  it('appends the generic prompt once before the first compaction', () => {
    const { agent, session } = rootAgent()
    const controller = new ObservationController()

    const first = controller.onPreStep(agent)
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0])).toContain(OBSERVATION_MARKER)

    appendPrompt(session, first)
    expect(controller.onPreStep(agent)).toHaveLength(0)
  })

  it('re-anchors the prompt after a compaction without duplicating it', () => {
    const { agent, session } = rootAgent()
    const controller = new ObservationController()

    appendPrompt(session, controller.onPreStep(agent))
    expect(controller.onPreStep(agent)).toHaveLength(0)

    compact(session)
    const reanchored = controller.onPreStep(agent)
    expect(reanchored).toHaveLength(1)
    expect(JSON.stringify(reanchored[0])).toContain(OBSERVATION_MARKER)

    appendPrompt(session, reanchored)
    expect(controller.onPreStep(agent)).toHaveLength(0)
  })

  it('never appends to a subagent session', () => {
    const { agent } = subagent()
    expect(new ObservationController().onPreStep(agent)).toHaveLength(0)
  })

  it('reads only the session log', () => {
    const { agent } = rootAgent()
    const propertiesRead: string[] = []
    const bareAgent = new Proxy(agent, {
      get(target, property, receiver) {
        propertiesRead.push(String(property))
        return Reflect.get(target, property, receiver)
      },
    })

    expect(new ObservationController().onPreStep(bareAgent)).toHaveLength(1)
    expect(propertiesRead.every(property => property === 'session')).toBe(true)
  })
})
