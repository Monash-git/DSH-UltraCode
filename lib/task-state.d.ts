/**
 * One-time generic task-state prompt for root sessions.
 *
 * This module reads only the session log. It never loads skill files and has no
 * knowledge of tickets, phases, or a particular skill.
 */
import { OncePromptController } from './once-prompt.js';
/** Appends the generic task-state prompt at the first root pre-step of a session. */
export declare class TaskStateController extends OncePromptController {
    constructor();
}
//# sourceMappingURL=task-state.d.ts.map