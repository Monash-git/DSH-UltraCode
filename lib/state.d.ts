/** Per-run state, durable event folding, and session-log reads used by the plugin. */
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { type ResolvedConfig } from './config.js';
import type { AutopilotPhase, AutopilotRunEvent, PauseCheckpointEvent, PauseManifestEvent, ProjectionRun, UltracodeModeEvent, UltracodePauseEvent } from './types.js';
/** The subset of a live agent used by the state helpers; a real Agent is assignable. */
export interface SessionCarrier {
    readonly session: Session;
}
/** The inbox surface the steering guard reads. */
export interface InboxCarrier {
    readonly inbox: {
        readonly nextTurn: readonly UserMessage[];
        readonly nextStep: readonly UserMessage[];
    };
}
/** The subset of one background job's output projection the pause protocol reads. */
export interface JobOutputLike {
    readonly spillPaths?: readonly string[];
}
/** The subset of one background job the turn-yield and pause checks read. */
export interface JobViewLike {
    readonly id?: unknown;
    readonly owner?: unknown;
    readonly status: string;
    readonly kind?: unknown;
    readonly label?: unknown;
    readonly output?: JobOutputLike;
}
/** The subset of the optional `ctx.jobs` service the plugin depends on. */
export interface JobRegistryLike {
    list(caller?: unknown): readonly JobViewLike[];
    kill?(id: unknown, caller?: unknown, reason?: string): 'requested' | 'already-finished';
    wait?(id: unknown, timeoutMs: number, caller?: unknown, signal?: AbortSignal): Promise<JobViewLike>;
    get?(id: unknown, caller?: unknown): JobViewLike;
}
/** Whether a job is still live (running or stopping). */
export declare function isLiveJobStatus(status: string | undefined): boolean;
/** Whether a job has reached a terminal state. */
export declare function isTerminalJobStatus(status: string | undefined): boolean;
/**
 * The first `running` job owned by this session. A `stopping` job is still
 * live but settles as killed and deliberately sends no completion notice, and
 * unowned jobs wake nobody, so yielding on either would strand the run.
 */
export declare function liveOwnedJob(registry: JobRegistryLike | undefined, owner: unknown): JobViewLike | undefined;
/** Live state for one autopilot run. */
export interface RunState {
    runId: string;
    skill: string;
    phase: AutopilotPhase;
    round: number;
    maxRounds: number;
    maxDurationMs: number;
    startedAt: number;
    updatedAt: number;
    reason?: string;
    noProgressDigest?: string;
    noProgressCount: number;
    /** Non-active milliseconds accumulated after earlier waiting spans. */
    inactiveMs: number;
    /** When the current waiting span began; absent while the run is active. */
    inactiveSince?: number;
}
/** One todo item as written by the todo tool. */
export interface TodoItem {
    content: string;
    status: string;
}
/** A session's selected provider/model/effort, read from the durable log. */
export interface ModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
/** The latest durable turn closer. */
export interface TurnEndInfo {
    turn: number;
    reason: string;
    seq: number;
}
/** Return whether the agent is a root agent rather than a delegated child. */
export declare function isRootAgent(agent: SessionCarrier): boolean;
/** Stable map key for one session. */
export declare function sessionKey(agent: SessionCarrier): string;
/** Create a fresh run in the armed state. */
export declare function createRunState(skill: string, config: ResolvedConfig, metadataMaxRounds?: number): RunState;
/** Restore live state from a durable event, including earlier inactive spans. */
export declare function fromRunEvent(event: AutopilotRunEvent, config: ResolvedConfig): RunState;
/**
 * Stop the active-duration clock. Waiting for a background job, waiting for
 * the user, and a paused run do not spend the run's duration budget.
 */
export declare function markRunWaiting(run: RunState, now?: number): void;
/** Resume the active-duration clock and accumulate the span just ended. */
export declare function resumeRunActive(run: RunState, now?: number): void;
/** Elapsed active time: wall clock minus every waiting or paused span. */
export declare function activeElapsedMs(run: RunState, now?: number): number;
/** Plugin-record types: unknown readers skip them because the envelope is ignorable. */
export declare const RUN_RECORD: "plugin:ultracode/run";
export declare const MODE_RECORD: "plugin:ultracode/mode";
export declare const PAUSE_RECORD: "plugin:ultracode/pause";
export declare const PAUSE_MANIFEST_RECORD: "plugin:ultracode/pause-manifest";
export declare const CHECKPOINT_RECORD: "plugin:ultracode/checkpoint";
/** Append the current run state as an ignorable plugin record. */
export declare function appendRunEvent(agent: SessionCarrier, run: RunState): void;
/** Append the Ultra mode toggle as an ignorable plugin record. */
export declare function appendModeEvent(agent: SessionCarrier, enabled: boolean, reason?: string, source?: UltracodeModeEvent['source']): void;
/** Append the pause state as an ignorable plugin record. */
export declare function appendPauseEvent(agent: SessionCarrier, event: UltracodePauseEvent): void;
/** Append the whole root-owned pause manifest as an ignorable plugin record. */
export declare function appendPauseManifest(agent: SessionCarrier, event: PauseManifestEvent): void;
/** Append one child checkpoint and return its durable sequence number. */
export declare function appendCheckpointEvent(agent: SessionCarrier, event: PauseCheckpointEvent): number;
/** Read the newest run record from a session snapshot. */
export declare function latestRunEvent(events: readonly SessionEvent[]): AutopilotRunEvent | undefined;
/** Read the newest mode record from a session snapshot. */
export declare function latestModeEvent(events: readonly SessionEvent[]): UltracodeModeEvent | undefined;
/** Read the newest pause record and its sequence from a session snapshot. */
export declare function latestPauseInfo(events: readonly SessionEvent[]): {
    readonly data: UltracodePauseEvent;
    readonly seq: number;
} | undefined;
/** Read the newest pause record from a session snapshot. */
export declare function latestPauseEvent(events: readonly SessionEvent[]): UltracodePauseEvent | undefined;
/** Read the newest root pause manifest from a session snapshot. */
export declare function latestPauseManifest(events: readonly SessionEvent[]): PauseManifestEvent | undefined;
/** Read the newest checkpoint written into a child session. */
export declare function latestCheckpointEvent(events: readonly SessionEvent[]): PauseCheckpointEvent | undefined;
/** One durable direct-child catalog row. */
export interface CatalogChildRow {
    readonly id: string;
    readonly mode: string;
    readonly label?: string;
}
/** Fold the newest whole child catalog from `subagent/catalog` events. */
export declare function catalogChildren(events: readonly SessionEvent[]): Map<string, CatalogChildRow>;
/** One durable workflow run folded from this session's workflow records. */
export interface WorkflowRunRow {
    readonly runId: string;
    readonly name: string;
    childIds: string[];
    finished: boolean;
}
/** Fold the durable workflow run and member records written by the workflow tool. */
export declare function workflowRuns(events: readonly SessionEvent[]): WorkflowRunRow[];
/**
 * Find the original workflow script for one run name. The workflow engine
 * keeps no journal; the model-written script survives only in the assistant
 * tool call, so this is the saved plan a restart can rely on.
 */
export declare function workflowPlan(events: readonly SessionEvent[], name: string): string | undefined;
/** Child ids started by the model-facing workflow tool in this session. */
export declare function workflowChildIds(events: readonly SessionEvent[]): Set<string>;
/** Read the newest model selection event. */
export declare function latestModelSelection(events: readonly SessionEvent[]): ModelSelection | undefined;
/** Read the newest durable turn closer. */
export declare function latestTurnEnd(events: readonly SessionEvent[]): TurnEndInfo | undefined;
/** The currently open turn number, or 0 when the log is balanced. */
export declare function openTurn(agent: SessionCarrier): number;
/** Whether the session has opened or closed a turn, so it is no longer blank. */
export declare function hasPriorTurn(agent: SessionCarrier): boolean;
/** Whether a human-authored prompt appears after the given seq. */
export declare function hasHumanMessageAfter(events: readonly SessionEvent[], seq: number): boolean;
/** Whether a run is in a phase that still owns unfinished work. */
export declare function isUnfinishedPhase(phase: AutopilotPhase): boolean;
/** Whether the inbox holds pending human work (queue or steering). */
export declare function inboxHasUserWork(agent: InboxCarrier): boolean;
/** The newest whole todo list and the durable time it was written. */
export interface TodoSnapshot {
    readonly todos: TodoItem[];
    readonly updatedAt: number;
}
/** Read the newest todo write from a session snapshot, including when it happened. */
export declare function todoSnapshot(events: readonly SessionEvent[]): TodoSnapshot | undefined;
/** Read the newest whole todo list, or undefined when the todo tool never wrote one. */
export declare function latestTodos(agent: SessionCarrier): TodoItem[] | undefined;
/** Compact todo summary for a continuation nudge. */
export declare function todoSummary(agent: SessionCarrier): string;
/** The newest assistant message's text, or an empty string. */
export declare function latestAssistantText(agent: SessionCarrier): string;
/**
 * Bounded artifact paths the session presented through the `present` tool.
 * The newest unique paths survive; older duplicates are dropped first.
 */
export declare function latestArtifactPaths(agent: SessionCarrier): string[];
/** Whether the newest assistant message ends with a question mark. */
export declare function lastAssistantEndsWithQuestion(agent: SessionCarrier): boolean;
/** A stable digest of recent observable progress. */
export declare function progressDigest(agent: SessionCarrier): string;
/** The newest session event sequence, or 0 for an empty log. */
export declare function lastSeq(agent: SessionCarrier): number;
/** Whether a plugin prompt carrying the marker appears after the latest compaction. */
export declare function hasPromptSinceCompaction(agent: SessionCarrier, marker: string): boolean;
/** Whether the compact reminder for one turn already appears in the log. */
export declare function hasReminderForTurn(agent: SessionCarrier, turn: number, markerPrefix: string): boolean;
/** Project one live run into the client projection shape. */
export declare function toProjectionRun(run: RunState): ProjectionRun;
/** Concatenate text blocks of one user message. */
export declare function messageText(message: UserMessage): string;
//# sourceMappingURL=state.d.ts.map