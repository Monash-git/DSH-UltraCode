/**
 * Host-side park gate for local subagents.
 *
 * The root pause coordinator sends one host-authored control message into a
 * running child's inbox. At the child's next `agent/pre-step` boundary the
 * gate consumes that message (it never reaches the model), flushes the child
 * session, records a durable checkpoint, acknowledges the root, and awaits a
 * release promise. The child stays `running` with its turn open, so its
 * context, tools, and (for workflow children) the pending workflow result are
 * preserved without a new model request.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm';
/** Stable text for the hidden control message; never model-visible. */
export declare const PAUSE_CONTROL_TEXT = "Ultra host pause: checkpoint and park until the root session resumes.";
/** One deterministic pause acknowledgment produced at a child pre-step. */
export interface ParkAcknowledgement {
    readonly pauseId: string;
    readonly checkpointAt: number;
    readonly checkpointSeq: number;
    /** Artifact paths the checkpoint captured, when the session presented any. */
    readonly artifacts?: readonly string[];
}
/** Build the host-only control message that wakes a child toward its park point. */
export declare function pauseControlMessage(pauseId: string): UserMessage;
/** Whether a claimed message is the host pause control rather than model input. */
export declare function isPauseControlMessage(message: UserMessage): boolean;
/** Build the model-visible message that resumes a child after a forced stop. */
export declare function pauseResumeMessage(): UserMessage;
/** One waiting child: an acknowledgment and a release latch. */
export interface ParkEntry {
    readonly pauseId: string;
    /** Resolves once the child reaches and flushes its park point. */
    readonly acknowledged: Promise<ParkAcknowledgement>;
    /** Resolves when the root releases the child. */
    readonly released: Promise<'resume' | 'abort'>;
    /** Record the checkpoint as the child's acknowledgment (first one wins). */
    acknowledge(value: ParkAcknowledgement): void;
    /** Release a parked child, or cancel an unclaimed park request. */
    release(kind: 'resume' | 'abort'): void;
    /** Wait for release; rejects when the turn signal aborts first. */
    wait(signal: AbortSignal): Promise<'resume'>;
}
/** Per-child park entries keyed by durable child session id. */
export declare class ParkGate {
    private readonly entries;
    /** Register a park request for one child, reusing an existing same-pause entry. */
    request(childId: string, pauseId: string): ParkEntry;
    /** The active request for one child, if any. */
    get(childId: string): ParkEntry | undefined;
    /** Release one child; returns whether a request existed. */
    release(childId: string, kind?: 'resume' | 'abort'): boolean;
    /** Drop one child's request without requiring it to have reached the gate. */
    forget(childId: string): void;
    /** Release and forget every request (plugin unload or root disposal). */
    dispose(kind?: 'resume' | 'abort'): void;
}
//# sourceMappingURL=park.d.ts.map