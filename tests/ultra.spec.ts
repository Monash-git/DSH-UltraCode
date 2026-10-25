import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { ULTRA_REMINDER_PREFIX, ULTRA_STANDING_MARKER, ULTRA_STANDING_PLAYBOOK } from '../src/prompts.js'
import { UltraModeController } from '../src/ultra.js'

function fakeAgent(): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(`ultra-${Math.random().toString(36).slice(2)}`))
  return { agent: { session } as unknown as Agent, session }
}

function selectUltra(session: Session): void {
  ;(session as unknown as { append(type: string, data: unknown): unknown }).append('model/selection', {
    provider: 'deepseek-official',
    model: 'mock',
    reasoningEffort: 'ultra',
  })
}

function appendPlaybook(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: ULTRA_STANDING_PLAYBOOK }],
    source: { kind: 'ultracode' },
  }), { surfaceOp: 'append' })
}

describe('UltraModeController', () => {
  it('injects the full playbook on selector activation and a reminder on the next human turn', () => {
    const { agent, session } = fakeAgent()
    selectUltra(session)
    const controller = new UltraModeController(resolveConfig())

    const first = controller.onPreStep({ agent, messages: [], turn: 1, step: 1 })
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0])).toContain(ULTRA_STANDING_MARKER)

    appendPlaybook(session)
    const second = controller.onPreStep({ agent, messages: [], turn: 2, step: 1 })
    expect(second).toHaveLength(1)
    expect(JSON.stringify(second[0])).toContain(`${ULTRA_REMINDER_PREFIX}2]`)
    session.append('user/message', second[0]!, { surfaceOp: 'append' })

    const duplicate = controller.onPreStep({ agent, messages: [], turn: 2, step: 1 })
    expect(duplicate).toHaveLength(0)
  })

  it('treats a keyword as a current-turn activation that does not persist', () => {
    const { agent } = fakeAgent()
    const controller = new UltraModeController(resolveConfig())
    const keyword = createUserMessage({
      content: [{ type: 'text', text: 'ultracode: audit the repository' }],
      source: { kind: 'user' },
    })

    const first = controller.onPreStep({ agent, messages: [keyword], turn: 1, step: 1 })
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0])).toContain(ULTRA_STANDING_MARKER)

    const next = controller.onPreStep({ agent, messages: [], turn: 2, step: 1 })
    expect(next).toHaveLength(0)
    expect(controller.commandModeOn(agent)).toBe(false)
  })

  it('honors the effort-independent command mode', () => {
    const { agent } = fakeAgent()
    const controller = new UltraModeController(resolveConfig())
    controller.setCommandMode(agent, true)
    const additions = controller.onPreStep({ agent, messages: [], turn: 1, step: 1 })
    expect(additions).toHaveLength(1)
    expect(JSON.stringify(additions[0])).toContain(ULTRA_STANDING_MARKER)
  })

  it('re-anchors the full playbook on an explicit resume request', () => {
    const { agent, session } = fakeAgent()
    selectUltra(session)
    appendPlaybook(session)
    const controller = new UltraModeController(resolveConfig())
    controller.requestFullPlaybook(agent)
    const additions = controller.onPreStep({ agent, messages: [], turn: 2, step: 1 })
    expect(additions).toHaveLength(1)
    expect(JSON.stringify(additions[0])).toContain(ULTRA_STANDING_MARKER)
  })

  it('re-injects the full playbook after compaction', () => {
    const { agent, session } = fakeAgent()
    selectUltra(session)
    appendPlaybook(session)
    ;(session as unknown as { append(type: string, data: unknown): unknown }).append('compaction/end', {})
    const controller = new UltraModeController(resolveConfig())
    const additions = controller.onPreStep({ agent, messages: [], turn: 2, step: 1 })
    expect(additions).toHaveLength(1)
    expect(JSON.stringify(additions[0])).toContain(ULTRA_STANDING_MARKER)
  })
})
