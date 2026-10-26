/**
 * One generic once-per-context prompt.
 *
 * The prompt is appended at the first root pre-step, re-anchored once after
 * compaction, and never appended to a subagent. The controller reads only the
 * session log; it has no knowledge of tickets, phases, or a particular skill.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { hasPromptSinceCompaction, isRootAgent } from './state.js';
/** Appends one generic prompt once per root-session context. */
export class OncePromptController {
    prompt;
    constructor(prompt) {
        this.prompt = prompt;
    }
    /**
     * Return the prompt once per context, or an empty list when the current
     * context already has it. A compaction drops the model-visible copy, so the
     * prompt is re-anchored once after each compaction.
     */
    onPreStep(agent) {
        if (!isRootAgent(agent))
            return [];
        if (hasPromptSinceCompaction(agent, this.prompt.marker))
            return [];
        return [createUserMessage({
                content: [{ type: 'text', text: this.prompt.text }],
                source: { kind: 'ultracode' },
            })];
    }
}
//# sourceMappingURL=once-prompt.js.map