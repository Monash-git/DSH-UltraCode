/**
 * One-time generic task-state prompt for root sessions.
 *
 * This module reads only the session log. It never loads skill files and has no
 * knowledge of tickets, phases, or a particular skill.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { TASK_STATE_MARKER, TASK_STATE_PROMPT } from './prompts.js'
import { hasPromptSinceCompaction, isRootAgent } from './state.js'

/** Appends the generic task-state prompt at the first root pre-step of a session. */
export class TaskStateController {
  /**
   * Return the prompt once per context, or an empty list when the current
   * context already has it. A compaction drops the model-visible copy, so the
   * prompt is re-anchored once after each compaction.
   */
  onPreStep(agent: Agent): UserMessage[] {
    if (!isRootAgent(agent)) return []
    if (hasPromptSinceCompaction(agent, TASK_STATE_MARKER)) return []
    return [createUserMessage({
      content: [{ type: 'text', text: TASK_STATE_PROMPT }],
      source: { kind: 'ultracode' },
    })]
  }
}
