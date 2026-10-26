/**
 * Root-mediated pause coordination.
 *
 * The root owns the durable manifest. Pause discovers live local descendants
 * by durable lineage, sends each running child a host pause control, and
 * waits a bounded time for the child's pre-step gate to acknowledge with a
 * flushed checkpoint. Children that do not acknowledge are stopped with the
 * existing interrupt/cancel path and marked forced. Play releases parked
 * children in place, warm-resumes resident children that were stopped, and
 * cold-resumes disposed children through `ctx.subagents`; when cold resume is
 * unavailable, the manifest carries an explicit restart-from-checkpoint
 * warning. Nothing releases a child without Play or an explicit user message.
 *
 * The child park, job stop, workflow capture, and warning helpers live in
 * focused sibling modules; this class only orchestrates the transition.
 */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import { type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { type LiveAgentRegistryLike } from './pause-children.js';
import { type PauseRestart } from './pause-workflows.js';
import { type JobRegistryLike } from './state.js';
import type { PauseManifestChild } from './types.js';
export type { LiveAgentRegistryLike } from './pause-children.js';
export type { PauseRestart } from './pause-workflows.js';
/** The subset of the session store used for durability barriers. */
export interface SessionStoreLike {
    flush(session: Session): Promise<boolean>;
}
/** One recursive catalog row, loosely typed so the plugin needs no hard dependency. */
export interface SubagentRowLike {
    readonly kind?: string;
    readonly id?: unknown;
    readonly mode?: unknown;
    readonly label?: unknown;
}
/** The optional `ctx.subagents` surface used for discovery and cold resume. */
export interface SubagentServiceLike {
    listDescendants?(rootSessionId: Agent['session']['id'], signal?: AbortSignal): Promise<readonly SubagentRowLike[]>;
    sendMessage?(sender: Agent, targetId: Agent['session']['id'], content: readonly ContentBlock[], options: {
        readonly signal: AbortSignal;
    }): Promise<unknown>;
    interrupt?(targetSessionId: Agent['session']['id'], authority: {
        readonly kind: 'ancestor';
        readonly agent: Agent;
    }): void;
}
/** Everything the coordinator reads from the host composition. */
export interface PauseCoordinatorDeps {
    readonly timeoutMs: number;
    /** Bounded drain before and after stopping a non-pausable job. */
    readonly drainMs: number;
    readonly agents?: () => LiveAgentRegistryLike | undefined;
    readonly subagents?: () => SubagentServiceLike | undefined;
    readonly sessions?: () => SessionStoreLike | undefined;
    readonly jobs?: () => JobRegistryLike | undefined;
}
/** The minimal `agent/pre-step` payload the gate consumes. */
export interface PausePreStepPayload {
    readonly agent: Agent;
    readonly messages: UserMessage[];
    readonly turn: number;
    readonly step: number;
    readonly signal: AbortSignal;
}
/** Why the root released its children. */
export type PauseReleaseMode = 'resume' | 'cancel';
/** What one release did to the manifest. */
export interface PauseReleaseResult {
    readonly children: readonly PauseManifestChild[];
    readonly warnings: readonly string[];
    readonly restart?: PauseRestart;
}
/** Coordinate one root's pause across its live local descendants. */
export declare class PauseCoordinator {
    private readonly deps;
    private readonly gate;
    private readonly active;
    private disposed;
    constructor(deps: PauseCoordinatorDeps);
    /**
     * Start a pause: checkpoint the root, record the manifest, and park every
     * live local descendant. Acknowledgment waits are bounded by `timeoutMs`.
     */
    begin(root: Agent, pauseId: string): Promise<void>;
    /**
     * Consume pause controls at any pre-step. A child with an active request
     * flushes, records a checkpoint, acknowledges, then parks until release;
     * a stale control is dropped so it can never reach a model.
     */
    onPreStep(payload: PausePreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
    /**
     * Release every manifest child. `resume` releases parked turns in place,
     * warm-resumes resident children, and cold-resumes disposed children when
     * the subagent service can; `cancel` stops parked children and the manifest
     * without starting any new work. A release during the `pausing` phase stops
     * any owned workflow/bash work before the transition settles.
     */
    release(root: Agent, mode: PauseReleaseMode): Promise<PauseReleaseResult>;
    /** Release and forget everything owned by one root session. */
    disposeRoot(rootId: string): void;
    /** Unblock and forget one disposed child's park request. */
    abortChild(childId: string): void;
    /**
     * Stop every park wait on plugin unload so no child turn hangs forever.
     * A reload must not resume paused work: live parked children are cancelled
     * through the normal interrupt path (preserving their inbox), and any
     * not-yet-parked request is aborted. The durable pause record and manifest
     * still say paused; the reloaded instance can Play-release (warm-resume)
     * the children or report them.
     */
    dispose(): void;
    /** Live descendants by durable lineage (`origin: subagent`), direct or deeper. */
    private liveChildren;
    private liveChild;
    private rowsById;
    /** Stop jobs at most once per pause so begin and release never race a kill. */
    private stopJobsOnce;
    private checkpointRoot;
    private checkpointChild;
    private forceChild;
    private coldResume;
    private stillPausing;
    private write;
    private flush;
}
//# sourceMappingURL=pause-coordinator.d.ts.map