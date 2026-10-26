/**
 * One-time generic safe-observation prompt for root sessions.
 *
 * The prompt points the model at the status and session-history tools and
 * bounds raw archive inspection. This module reads only the session log; it has
 * no knowledge of tickets, phases, or a particular skill.
 */
import { OncePromptController } from './once-prompt.js';
import { OBSERVATION_MARKER, OBSERVATION_PROMPT } from './prompts.js';
/** Appends the safe-observation prompt once per root-session context. */
export class ObservationController extends OncePromptController {
    constructor() {
        super({ marker: OBSERVATION_MARKER, text: OBSERVATION_PROMPT });
    }
}
//# sourceMappingURL=observation.js.map