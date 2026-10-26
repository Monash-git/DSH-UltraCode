/**
 * One-time generic task-state prompt for root sessions.
 *
 * This module reads only the session log. It never loads skill files and has no
 * knowledge of tickets, phases, or a particular skill.
 */
import { OncePromptController } from './once-prompt.js';
import { TASK_STATE_MARKER, TASK_STATE_PROMPT } from './prompts.js';
/** Appends the generic task-state prompt at the first root pre-step of a session. */
export class TaskStateController extends OncePromptController {
    constructor() {
        super({ marker: TASK_STATE_MARKER, text: TASK_STATE_PROMPT });
    }
}
//# sourceMappingURL=task-state.js.map