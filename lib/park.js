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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** Stable text for the hidden control message; never model-visible. */
export const PAUSE_CONTROL_TEXT = 'Ultra host pause: checkpoint and park until the root session resumes.';
/** Build the host-only control message that wakes a child toward its park point. */
export function pauseControlMessage(pauseId) {
    return createUserMessage({
        content: [{ type: 'text', text: PAUSE_CONTROL_TEXT }],
        source: { kind: 'ultracode', form: 'pause', pauseId },
    });
}
/** Whether a claimed message is the host pause control rather than model input. */
export function isPauseControlMessage(message) {
    const source = message.source;
    return source.kind === 'ultracode' && source.form === 'pause';
}
/** Build the model-visible message that resumes a child after a forced stop. */
export function pauseResumeMessage() {
    return createUserMessage({
        content: [{
                type: 'text',
                text: 'The root session resumed. Continue your task from where it stopped. '
                    + 'If your previous turn was interrupted, inspect your checkpoint and artifacts, then continue.',
            }],
        source: { kind: 'ultracode', form: 'notice', summary: 'root session resumed' },
    });
}
class ParkEntryImpl {
    pauseId;
    acknowledgedValue;
    acknowledgedResolve;
    releasedValue;
    releasedResolve;
    acknowledged = new Promise(resolve => {
        this.acknowledgedResolve = resolve;
    });
    released = new Promise(resolve => {
        this.releasedResolve = resolve;
    });
    constructor(pauseId) {
        this.pauseId = pauseId;
    }
    acknowledge(value) {
        if (this.acknowledgedValue !== undefined)
            return;
        this.acknowledgedValue = value;
        this.acknowledgedResolve(value);
    }
    release(kind) {
        if (this.releasedValue !== undefined)
            return;
        this.releasedValue = kind;
        this.releasedResolve(kind);
    }
    async wait(signal) {
        if (signal.aborted)
            throw signal.reason ?? new Error('pause aborted');
        let removeAbort = () => { };
        const aborted = new Promise((_resolve, reject) => {
            const onAbort = () => reject(signal.reason ?? new Error('pause aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbort = () => signal.removeEventListener('abort', onAbort);
        });
        try {
            const kind = await Promise.race([this.released, aborted]);
            if (kind === 'abort')
                throw signal.reason ?? new Error('pause aborted');
            return 'resume';
        }
        finally {
            removeAbort();
        }
    }
}
/** Per-child park entries keyed by durable child session id. */
export class ParkGate {
    entries = new Map();
    /** Register a park request for one child, reusing an existing same-pause entry. */
    request(childId, pauseId) {
        const existing = this.entries.get(childId);
        if (existing !== undefined && existing.pauseId === pauseId)
            return existing;
        const entry = new ParkEntryImpl(pauseId);
        this.entries.set(childId, entry);
        return entry;
    }
    /** The active request for one child, if any. */
    get(childId) {
        return this.entries.get(childId);
    }
    /** Release one child; returns whether a request existed. */
    release(childId, kind = 'resume') {
        const entry = this.entries.get(childId);
        if (entry === undefined)
            return false;
        entry.release(kind);
        this.entries.delete(childId);
        return true;
    }
    /** Drop one child's request without requiring it to have reached the gate. */
    forget(childId) {
        this.entries.delete(childId);
    }
    /** Release and forget every request (plugin unload or root disposal). */
    dispose(kind = 'abort') {
        for (const entry of this.entries.values())
            entry.release(kind);
        this.entries.clear();
    }
}
//# sourceMappingURL=park.js.map