import { describe, expect, it } from 'vitest'
import {
  autopilotBanner,
  continuationNudge,
  TASK_STATE_PROMPT,
  ULTRA_STANDING_PLAYBOOK,
  ultraReminder,
} from '../src/prompts.js'

/** Ticket, phase, and skill vocabulary must stay out of the generic prompt. */
const FORBIDDEN_TASK_STATE_VOCABULARY = /ticket|phase|skill|wayfinder|tdd/i

function expectReplyFirst(text: string): void {
  expect(text).toMatch(/direct user question/i)
  expect(text).toMatch(/progress/i)
  expect(text).toMatch(/same step before/i)
  expect(text).toMatch(/does not stop the run/i)
}

describe('generic task-state prompt', () => {
  it('asks for a current todo list on every multi-step task', () => {
    expect(TASK_STATE_PROMPT).toContain('Any multi-step task: keep the todo list current.')
    expect(TASK_STATE_PROMPT).toMatch(/a task is added, completed, reordered, or dropped/)
    expect(TASK_STATE_PROMPT).toContain('update the todo list in the same step')
    expect(TASK_STATE_PROMPT).toContain('This applies to every task, regardless of its type.')
  })

  it('contains no ticket, phase, or skill names', () => {
    expect(TASK_STATE_PROMPT).not.toMatch(FORBIDDEN_TASK_STATE_VOCABULARY)
  })
})

describe('reply-first prompt assets', () => {
  it('adds reply-first to the Ultra standing playbook and reminder', () => {
    expectReplyFirst(ULTRA_STANDING_PLAYBOOK)
    expectReplyFirst(ultraReminder(2, 8))
  })

  it('adds reply-first to the autopilot banner and continuation nudge', () => {
    expectReplyFirst(autopilotBanner('tdd', 1, 20))
    expectReplyFirst(continuationNudge('tdd', 2, 20, '1 completed, 1 open', 'tests'))
  })
})
