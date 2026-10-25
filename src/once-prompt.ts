/**
 * One generic once-per-context prompt.
 *
 * The prompt is appended at the first root pre-step, re-anchored once after
 * compaction, and never appended to a subagent. The controller reads only the
 * session log; it has no knowledge of tickets, phases, or a particular skill.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { hasPromptSinceCompaction, isRootAgent } from './state.js'

/** The stable marker and text of one generic prompt. */
export interface OncePrompt {
  /** Stable marker used to detect the prompt after the latest compaction. */
  readonly marker: string
  readonly text: string
}

/** Appends one generic prompt once per root-session context. */
export class OncePromptController {
  constructor(private readonly prompt: OncePrompt) {}

  /**
   * Return the prompt once per context, or an empty list when the current
   * context already has it. A compaction drops the model-visible copy, so the
   * prompt is re-anchored once after each compaction.
   */
  onPreStep(agent: Agent): UserMessage[] {
    if (!isRootAgent(agent)) return []
    if (hasPromptSinceCompaction(agent, this.prompt.marker)) return []
    return [createUserMessage({
      content: [{ type: 'text', text: this.prompt.text }],
      source: { kind: 'ultracode' },
    })]
  }
}
