import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TASK_STATE_MARKER } from '../src/prompts.js'
import { TaskStateController } from '../src/task-state.js'

function rootAgent(): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(`task-state-${Math.random().toString(36).slice(2)}`))
  return { agent: { session } as unknown as Agent, session }
}

function subagent(): { agent: Agent; session: Session } {
  const id = SessionId(`task-state-child-${Math.random().toString(36).slice(2)}`)
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

describe('TaskStateController', () => {
  it('appends the generic prompt once to a root session', () => {
    const { agent, session } = rootAgent()
    const controller = new TaskStateController()

    const first = controller.onPreStep(agent)
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0])).toContain(TASK_STATE_MARKER)
    expect(JSON.stringify(first[0])).toContain('Any multi-step task')

    session.append('user/message', first[0]!, { surfaceOp: 'append' })
    expect(controller.onPreStep(agent)).toHaveLength(0)
  })

  it('never appends to a subagent session', () => {
    const { agent } = subagent()
    expect(new TaskStateController().onPreStep(agent)).toHaveLength(0)
  })

  it('reads only the session log, so a trivial turn needs no skill lookup', () => {
    const { agent, session } = rootAgent()
    const propertiesRead: string[] = []
    const bareAgent = new Proxy(agent, {
      get(target, property, receiver) {
        propertiesRead.push(String(property))
        return Reflect.get(target, property, receiver)
      },
    })

    const first = new TaskStateController().onPreStep(bareAgent)
    expect(first).toHaveLength(1)
    session.append('user/message', first[0]!, { surfaceOp: 'append' })
    expect(new TaskStateController().onPreStep(bareAgent)).toHaveLength(0)
    expect(propertiesRead.every(property => property === 'session')).toBe(true)
  })
})
