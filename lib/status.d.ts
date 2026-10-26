/**
 * Generic, read-only status for the current root session.
 *
 * The report is folded from the live session log, the plugin's in-memory run
 * and pause state, and the composition's optional job registry. It never
 * opens a session archive, a profile directory, or another session's state.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type RunState } from './state.js';
/** One live job owned by the calling session, in a shape any job reader satisfies. */
export interface StatusJobView {
    id: string;
    kind: string;
    label: string;
    owner?: string;
    status: string;
    progress?: string;
    detail?: string;
    startedAt: number;
}
/** One active autopilot run summary. */
export interface StatusRun {
    phase: string;
    round: number;
    maxRounds: number;
}
/** Canonical, read-only status report returned by `session_status`. */
export interface SessionStatus {
    session: {
        id: string;
        status: string;
    };
    turn: number;
    step: number;
    run: StatusRun | null;
    todos: {
        total: number;
        completed: number;
        open: number;
        updatedAt: number | null;
    };
    jobs: StatusJobView[];
    pause: {
        paused: boolean;
        reason: string | null;
    };
    generatedAt: number;
}
/** Everything the pure fold needs; no session store or filesystem access. */
export interface StatusInput {
    sessionId: string;
    sessionStatus: string;
    events: readonly SessionEvent[];
    run?: RunState;
    jobs?: readonly StatusJobView[];
    paused?: boolean;
    pauseReason?: string;
    now?: number;
}
/** The pause surface the status tool reads. */
export interface StatusPause {
    isPaused(agent: Agent): boolean;
    reasonOf(agent: Agent): string | undefined;
}
/** Tool dependencies supplied by the plugin composition. */
export interface StatusToolDeps {
    runs: ReadonlyMap<string, RunState>;
    pause: StatusPause;
    readJobs(agent: Agent): readonly StatusJobView[];
}
/** Fold a status report from live state without mutating anything. */
export declare function collectStatus(input: StatusInput): SessionStatus;
/** Render a compact, model-readable report. */
export declare function renderStatus(status: SessionStatus): string;
/** Build the root-session `session_status` tool. */
export declare function createSessionStatusTool(deps: StatusToolDeps): ToolDefinition;
/** Fold the current turn and step from live log boundaries. */
export declare function currentTurnAndStep(events: readonly SessionEvent[]): {
    turn: number;
    step: number;
};
//# sourceMappingURL=status.d.ts.map