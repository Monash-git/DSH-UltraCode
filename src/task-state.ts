/**
 * One-time generic task-state prompt for root sessions.
 *
 * This module reads only the session log. It never loads skill files and has no
 * knowledge of tickets, phases, or a particular skill.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { TASK_STATE_MARKER, TASK_STATE_PROMPT } from './prompts.js'
import { isRootAgent, messageText } from './state.js'

/** Appends the generic task-state prompt at the first root pre-step of a session. */
export class TaskStateController {
  /** Return the prompt once, or an empty list when the session already has it. */
  onPreStep(agent: Agent): UserMessage[] {
    if (!isRootAgent(agent)) return []
    const alreadyPresent = agent.session.snapshotEvents().some(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'ultracode'
      && messageText(event.data).includes(TASK_STATE_MARKER))
    if (alreadyPresent) return []
    return [createUserMessage({
      content: [{ type: 'text', text: TASK_STATE_PROMPT }],
      source: { kind: 'ultracode' },
    })]
  }
}
