/** Pure completion decision for the `complete_run` tool. */

import type { TodoItem } from './state.js'

/** Input accepted by {@link evaluateCompletion}. */
export interface CompletionInput {
  readonly summary: string
  readonly artifacts?: readonly string[]
  readonly remaining?: readonly string[]
  readonly blocked?: string
}

/** How the active run should settle. */
export type CompletionDecision =
  | { readonly kind: 'completed' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'more'; readonly error: string }

/**
 * Decide whether a completion call ends the run, reports a blocker, or is
 * rejected because work remains.
 * @param input - model-supplied completion fields.
 * @param openTodos - todo items whose status is not completed.
 * @returns the completion decision.
 */
export function evaluateCompletion(input: CompletionInput, openTodos: readonly TodoItem[]): CompletionDecision {
  const blocked = input.blocked?.trim()
  if (blocked !== undefined && blocked !== '') return { kind: 'blocked', reason: blocked }

  if (input.remaining !== undefined && input.remaining.length > 0) {
    return { kind: 'more', error: `Run is not complete; remaining work: ${input.remaining.join('; ')}` }
  }

  if (openTodos.length > 0) {
    return { kind: 'more', error: `Run is not complete; open todos: ${openTodos.map(todo => todo.content).join('; ')}` }
  }

  return { kind: 'completed' }
}
