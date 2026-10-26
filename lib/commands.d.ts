/** Host command handlers for autopilot, pause/resume, and Ultra compatibility. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { PauseController } from './pause.js';
import { type RunState } from './state.js';
import type { UltraModeController } from './ultra.js';
export interface CommandContext {
    readonly runs: Map<string, RunState>;
    readonly pause: PauseController;
    readonly ultra: UltraModeController;
    /** Switch the live session selection from Ultra to Max through the session controller. */
    selectMax(agent: Agent): void;
}
/** Handle `/autopilot [status|off|pause|resume]`. */
export declare function handleAutopilotCommand(agent: Agent, rawInput: string, context: CommandContext): CommandResult;
/** Handle `/pause`. */
export declare function handlePauseCommand(agent: Agent, context: CommandContext): CommandResult;
/** Handle `/resume`; waits for child release so warnings reach the command card. */
export declare function handleResumeCommand(agent: Agent, context: CommandContext): Promise<CommandResult>;
/** Handle `/ultra [on|off|status|<task>]`. */
export declare function handleUltraCommand(agent: Agent, rawInput: string, context: CommandContext): CommandResult;
//# sourceMappingURL=commands.d.ts.map