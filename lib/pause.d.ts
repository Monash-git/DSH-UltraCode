/**
 * Durable pause/resume for every root session.
 *
 * A pause is a log-only `ultracode/pause` event plus, when a skill run is
 * active, a `paused_user`/`paused_resume` run phase. Resume is one appended
 * user message; nothing rewrites history.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ResolvedConfig } from './config.js';
import type { PauseCoordinator } from './pause-coordinator.js';
import { type RunState } from './state.js';
import { WakeGate } from './wake.js';
export interface PauseOutcome {
    readonly ok: boolean;
    readonly text: string;
}
/** What a root pre-step should do with the claimed batch while paused. */
export type PausePreStepAction = {
    readonly kind: 'none';
}
/** The batch was captured durably; reject the step so no model turn starts. */
 | {
    readonly kind: 'held';
}
/** The user started a new direction; these held wakes join that turn. */
 | {
    readonly kind: 'released';
    readonly messages: readonly UserMessage[];
};
/** Owns the per-session pause state and the resume commands. */
export declare class PauseController {
    private readonly config;
    private readonly runs;
    private readonly coordinator?;
    private readonly paused;
    private readonly explicitCancel;
    /** Job-restart warnings for pauses restored from a previous process. */
    private readonly restoredWarnings;
    private readonly wake;
    constructor(config: ResolvedConfig, runs: Map<string, RunState>, coordinator?: PauseCoordinator | undefined, wake?: WakeGate);
    /**
     * Load durable pause state for an agent that stays live across a plugin
     * reload. A reload is not a session restart: an unfinished run is left
     * untouched and no pause record is written.
     */
    hydrate(agent: Agent): void;
    /** Load durable state and promote a crash-interrupted turn to paused. */
    onCreated(agent: Agent): void;
    /**
     * Reconcile a pause loaded from a persisted log. A previous process cannot
     * finish a `pausing`/`resuming` transition, so settle the manifest to
     * `paused` (reopening must show Play). A process restart also lost every
     * recorded job: persist that warning once and keep it for the Play result.
     */
    private settleRestoredPause;
    /** Fold the newest durable pause record into the in-memory view. */
    private restorePaused;
    /**
     * Apply the root pause gate to one claimed batch.
     *
     * A human message cancels the pause and starts a new direction; any wakes
     * held earlier are released into that same turn so nothing is lost. A pure
     * background wake (job notice, subagent settlement, schedule input) is
     * captured durably and the step is rejected: the driver closes the turn
     * without a model request, and Play replays the batch later.
     */
    onPreStep(agent: Agent, messages: readonly UserMessage[]): Promise<PausePreStepAction>;
    /** Pause immediately; cancel the active turn when there is one. */
    pause(agent: Agent): PauseOutcome;
    /** Resume a paused autopilot run or a generic interrupted turn. */
    resume(agent: Agent): PauseOutcome;
    /**
     * Resume and wait for child release, so Play can report a cold-resume
     * failure. Used by the `/resume` command; the autopilot command keeps the
     * non-blocking path.
     */
    resumeAsync(agent: Agent): Promise<PauseOutcome>;
    private resumeLocal;
    /**
     * Put every held wake into the resume batch before the waking steer, so one
     * model call sees the notices and the resume instruction together.
     */
    private stageHeld;
    /** Withdraw staged wakes after a failed resume, leaving them held for Play. */
    private unstageHeld;
    /** Mark staged wakes released only after the resume steer succeeded. */
    private finishHeld;
    /** Mark an explicit off/unload so turn-stopping does not record a pause. */
    requestCancel(agent: Agent): void;
    /** Consume the explicit-cancel flag for one turn. */
    consumeCancel(agent: Agent): boolean;
    /** Record an error as a resumable pause. */
    onError(agent: Agent, turn: number): void;
    /**
     * Apply the turn-stopping pause/clear rules. Returns whether the turn is
     * paused; the caller decides whether a run question or cap owns the turn.
     */
    onTurnStopping(agent: Agent, turn: number, signal: AbortSignal): 'paused' | 'cancelled' | 'none';
    /** Clear the pause when the model reports completion or a blocker. */
    complete(agent: Agent): void;
    /** Drop in-memory state when the agent is disposed. */
    dispose(agent: Agent): void;
    /** Whether the session is currently paused. */
    isPaused(agent: Agent): boolean;
    /** The current paused reason, for status text. */
    reasonOf(agent: Agent): string | undefined;
    /** Release parked children without blocking the command result. */
    private releaseChildren;
    private markPaused;
    private clear;
}
//# sourceMappingURL=pause.d.ts.map