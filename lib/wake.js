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
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
export const WAKE_HOLD_RECORD = 'plugin:ultracode/wake-hold';
export const WAKE_RELEASE_RECORD = 'plugin:ultracode/wake-release';
/**
 * Fold every hold that has no matching release marker, oldest first.
 * Records are append-only, so an interleaved release can never resurrect a
 * hold that was already replayed.
 */
export function heldWakes(events) {
    const released = new Set();
    const holds = [];
    for (const event of events) {
        const record = pluginRecordOf(event);
        if (record?.type === WAKE_HOLD_RECORD) {
            holds.push(record.data);
        }
        else if (record?.type === WAKE_RELEASE_RECORD) {
            released.add(record.data.holdId);
        }
    }
    return holds.filter(hold => !released.has(hold.holdId));
}
/** Own the durable hold/release records of one root session. */
export class WakeGate {
    deps;
    constructor(deps = {}) {
        this.deps = deps;
    }
    /** Every wake still held for this session, oldest first. */
    held(agent) {
        return heldWakes(agent.session.snapshotEvents());
    }
    /**
     * Capture one non-user wake batch. Nothing is written for an empty set, and
     * user-authored messages are never held. The caller rejects the step after
     * this resolves, so the flush is the durability barrier for the capture.
     */
    async hold(agent, pauseId, messages) {
        const held = messages
            .filter(message => message.source.kind !== 'user')
            .map(message => ({ content: message.content, source: message.source }));
        if (held.length === 0)
            return undefined;
        const event = {
            holdId: randomUUID(),
            ...pauseId === undefined ? {} : { pauseId },
            at: Date.now(),
            messages: held,
        };
        appendPluginRecord(agent.session, WAKE_HOLD_RECORD, event);
        await this.flush(agent);
        return event;
    }
    /**
     * Reconstruct every unreleased hold as a deliverable user message. No
     * release marker is written yet: the caller first proves delivery through
     * the inbox, then calls {@link markReleased}.
     */
    pending(agent) {
        const holds = this.held(agent);
        return {
            holds,
            messages: holds.flatMap(hold => hold.messages.map(message => createUserMessage({
                content: message.content,
                source: message.source,
            }))),
        };
    }
    /** Durably record that one batch of holds reached the resume turn. */
    markReleased(agent, holds, reason) {
        if (holds.length === 0)
            return;
        const at = Date.now();
        for (const hold of holds) {
            appendPluginRecord(agent.session, WAKE_RELEASE_RECORD, { holdId: hold.holdId, reason, at });
        }
    }
    /** Flush the session so hold/release records survive a process crash. */
    async flush(agent) {
        try {
            await this.deps.flush?.(agent);
        }
        catch {
            // A durability barrier failure must not turn a held wake into a model
            // call; the records are already in the live log.
        }
    }
}
//# sourceMappingURL=wake.js.map