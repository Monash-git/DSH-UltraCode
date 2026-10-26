/**
 * Durable hold/release for background wakes that arrive while a root session
 * is paused.
 *
 * DSH delivers a background job completion notice (or a subagent settlement)
 * as a waking user message. The plugin cannot stop the driver before it opens
 * a turn, but its `agent/pre-step` gate can capture the claimed batch as a
 * durable plugin record and reject the proposed step, so no model request is
 * made. Play replays every unreleased record into the resume batch. Nothing is
 * dropped and nothing resumes on its own.
 */
import type { ContentBlock, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionCarrier } from './state.js';
export declare const WAKE_HOLD_RECORD: "plugin:ultracode/wake-hold";
export declare const WAKE_RELEASE_RECORD: "plugin:ultracode/wake-release";
/** One claimed message stored verbatim, without its transient message identity. */
export interface WakeHoldMessage {
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
/** Durable capture of one wake batch that arrived while paused. */
export interface WakeHoldEvent {
    readonly holdId: string;
    readonly pauseId?: string;
    readonly at: number;
    readonly messages: readonly WakeHoldMessage[];
}
/** Why a held wake left the hold: Play or an explicit user direction. */
export type WakeReleaseReason = 'play' | 'user-direction';
/** Durable marker that one hold has been handed back to the model. */
export interface WakeReleaseEvent {
    readonly holdId: string;
    readonly reason: WakeReleaseReason;
    readonly at: number;
}
/** The flush boundary used to make a hold durable before its turn is rejected. */
export interface WakeGateDeps {
    flush?(agent: SessionCarrier): Promise<unknown> | unknown;
}
/** Unreleased holds plus the messages they should replay. */
export interface PendingWakes {
    readonly holds: readonly WakeHoldEvent[];
    readonly messages: readonly UserMessage[];
}
/**
 * Fold every hold that has no matching release marker, oldest first.
 * Records are append-only, so an interleaved release can never resurrect a
 * hold that was already replayed.
 */
export declare function heldWakes(events: readonly SessionEvent[]): WakeHoldEvent[];
/** Own the durable hold/release records of one root session. */
export declare class WakeGate {
    private readonly deps;
    constructor(deps?: WakeGateDeps);
    /** Every wake still held for this session, oldest first. */
    held(agent: SessionCarrier): readonly WakeHoldEvent[];
    /**
     * Capture one non-user wake batch. Nothing is written for an empty set, and
     * user-authored messages are never held. The caller rejects the step after
     * this resolves, so the flush is the durability barrier for the capture.
     */
    hold(agent: SessionCarrier, pauseId: string | undefined, messages: readonly UserMessage[]): Promise<WakeHoldEvent | undefined>;
    /**
     * Reconstruct every unreleased hold as a deliverable user message. No
     * release marker is written yet: the caller first proves delivery through
     * the inbox, then calls {@link markReleased}.
     */
    pending(agent: SessionCarrier): PendingWakes;
    /** Durably record that one batch of holds reached the resume turn. */
    markReleased(agent: SessionCarrier, holds: readonly WakeHoldEvent[], reason: WakeReleaseReason): void;
    /** Flush the session so hold/release records survive a process crash. */
    flush(agent: SessionCarrier): Promise<void>;
}
//# sourceMappingURL=wake.d.ts.map