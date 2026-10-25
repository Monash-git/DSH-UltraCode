/**
 * One-time generic safe-observation prompt for root sessions.
 *
 * The prompt points the model at the status and session-history tools and
 * bounds raw archive inspection. This module reads only the session log; it has
 * no knowledge of tickets, phases, or a particular skill.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { OBSERVATION_MARKER, OBSERVATION_PROMPT } from './prompts.js'
import { hasPromptSinceCompaction, isRootAgent } from './state.js'

/** Appends the safe-observation prompt once per root-session context. */
export class ObservationController {
  /**
   * Return the prompt once per context, or an empty list when the current
   * context already has it. A compaction drops the model-visible copy, so the
   * prompt is re-anchored once after each compaction.
   */
  onPreStep(agent: Agent): UserMessage[] {
    if (!isRootAgent(agent)) return []
    if (hasPromptSinceCompaction(agent, OBSERVATION_MARKER)) return []
    return [createUserMessage({
      content: [{ type: 'text', text: OBSERVATION_PROMPT }],
      source: { kind: 'ultracode' },
    })]
  }
}
