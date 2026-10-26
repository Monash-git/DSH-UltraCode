/**
 * Ultra standing mode: selector/command/keyword activation, the full playbook
 * on arm/resume/compaction, and one compact reminder per human turn.
 *
 * The model authors workflow scripts; this module only supplies the standing
 * authorization and reminders. It never creates an autopilot run.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { hasUltracodeToken } from './detect.js';
import { ULTRA_REMINDER_PREFIX, ULTRA_STANDING_MARKER, ULTRA_STANDING_PLAYBOOK, ultraReminder, } from './prompts.js';
import { appendModeEvent, hasPriorTurn, hasPromptSinceCompaction, hasReminderForTurn, isRootAgent, latestModeEvent, latestModelSelection, sessionKey, } from './state.js';
/** Owns the in-memory activation view; the durable state remains the log. */
export class UltraModeController {
    config;
    defaultSelection;
    commandMode = new Set();
    active = new Set();
    forceFullPlaybook = new Set();
    constructor(config, defaultSelection) {
        this.config = config;
        this.defaultSelection = defaultSelection;
    }
    /** Load the command mode and current activation view for one agent. */
    onCreated(agent) {
        if (!isRootAgent(agent))
            return;
        this.ensureDefaultSelection(agent);
        const key = sessionKey(agent);
        const mode = latestModeEvent(agent.session.snapshotEvents());
        if (mode?.source === 'command') {
            if (mode.enabled)
                this.commandMode.add(key);
            else
                this.commandMode.delete(key);
        }
        this.active.delete(key);
        if (this.isSelectorUltra(agent) || this.commandMode.has(key))
            this.active.add(key);
    }
    /** Whether the model selection currently says `ultra`. */
    isSelectorUltra(agent) {
        const selection = latestModelSelection(agent.session.snapshotEvents());
        if (selection !== undefined)
            return selection.reasoningEffort === 'ultra';
        if (hasPriorTurn(agent))
            return false;
        return this.defaultSelection?.()?.reasoningEffort === 'ultra';
    }
    /** Read the selected effort, for status output. */
    selectedEffort(agent) {
        const selection = latestModelSelection(agent.session.snapshotEvents());
        if (selection !== undefined)
            return selection.reasoningEffort;
        return hasPriorTurn(agent) ? undefined : this.defaultSelection?.()?.reasoningEffort;
    }
    /**
     * Carry an Ultra default into a blank new session: no selection event and no
     * turn yet. DSH's blank draft keeps the selector choice client-side; the
     * session created on the first send otherwise starts without it and the
     * request header (max) makes the UI fall back to Max. Existing sessions are
     * deliberately never mutated just because Ultra is the current default.
     */
    ensureDefaultSelection(agent) {
        if (hasPriorTurn(agent))
            return;
        if (latestModelSelection(agent.session.snapshotEvents()) !== undefined)
            return;
        const selection = this.defaultSelection?.();
        if (selection?.reasoningEffort !== 'ultra')
            return;
        agent.session.append('model/selection', {
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: 'ultra',
        });
    }
    /** Enable or disable the effort-independent command mode. */
    setCommandMode(agent, enabled) {
        const key = sessionKey(agent);
        if (enabled)
            this.commandMode.add(key);
        else
            this.commandMode.delete(key);
        appendModeEvent(agent, enabled, enabled ? 'command' : 'off', 'command');
    }
    /** Whether the command mode is on. */
    commandModeOn(agent) {
        return this.commandMode.has(sessionKey(agent));
    }
    /** Force the next armed step to re-anchor the full playbook (resume). */
    requestFullPlaybook(agent) {
        this.forceFullPlaybook.add(sessionKey(agent));
    }
    /** Drop in-memory state when the agent is disposed. */
    dispose(agent) {
        const key = sessionKey(agent);
        this.commandMode.delete(key);
        this.active.delete(key);
        this.forceFullPlaybook.delete(key);
    }
    /** Append the playbook and/or the per-turn reminder for this step. */
    onPreStep(payload) {
        const { agent } = payload;
        if (!isRootAgent(agent))
            return [];
        this.ensureDefaultSelection(agent);
        const key = sessionKey(agent);
        const selector = this.isSelectorUltra(agent);
        const command = this.commandMode.has(key);
        const keyword = payload.step === 1 && hasUltracodeToken(payload.messages);
        const armed = selector || command || keyword;
        const wasActive = this.active.has(key);
        if (!armed) {
            if (wasActive) {
                this.active.delete(key);
                appendModeEvent(agent, false, 'standing mode off', 'selector');
            }
            return [];
        }
        this.active.add(key);
        if (!wasActive)
            appendModeEvent(agent, true, 'standing mode on', selector ? 'selector' : command ? 'command' : 'keyword');
        const additions = [];
        const forceFullPlaybook = this.forceFullPlaybook.delete(key);
        const hasPlaybook = !forceFullPlaybook && hasPromptSinceCompaction(agent, ULTRA_STANDING_MARKER);
        if (!hasPlaybook) {
            additions.push(createUserMessage({
                content: [{ type: 'text', text: ULTRA_STANDING_PLAYBOOK }],
                source: { kind: 'ultracode' },
            }));
        }
        else if (this.config.ultraReminder
            && payload.step === 1
            && !hasReminderForTurn(agent, payload.turn, ULTRA_REMINDER_PREFIX)) {
            additions.push(createUserMessage({
                content: [{ type: 'text', text: ultraReminder(payload.turn, this.config.fanoutLimit) }],
                source: { kind: 'ultracode', form: 'notice', summary: 'Ultra mode' },
            }));
        }
        return additions;
    }
}
//# sourceMappingURL=ultra.js.map