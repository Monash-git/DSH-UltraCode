import { describe, expect, it } from 'vitest'
import { evaluateCompletion } from '../src/completion.js'
import type { TodoItem } from '../src/state.js'

const openTodo: TodoItem = { content: 'finish the ticket', status: 'in_progress' }

describe('evaluateCompletion', () => {
  it('completes when no work remains', () => {
    expect(evaluateCompletion({ summary: 'done' }, [])).toEqual({ kind: 'completed' })
  })

  it('keeps the run going when remaining work is listed', () => {
    const decision = evaluateCompletion({ summary: 'partial', remaining: ['tests'] }, [])
    expect(decision.kind).toBe('more')
    if (decision.kind === 'more') expect(decision.error).toMatch(/remaining work: tests/)
  })

  it('keeps the run going when todos are open', () => {
    const decision = evaluateCompletion({ summary: 'partial' }, [openTodo])
    expect(decision.kind).toBe('more')
    if (decision.kind === 'more') expect(decision.error).toMatch(/open todos: finish the ticket/)
  })

  it('lets a blocker stop the run even with open todos', () => {
    expect(evaluateCompletion({ summary: 'blocked', blocked: 'missing credentials' }, [openTodo]))
      .toEqual({ kind: 'blocked', reason: 'missing credentials' })
  })
})
