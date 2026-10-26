/**
 * Ultra standing mode: selector/command/keyword activation, the full playbook
 * on arm/resume/compaction, and one compact reminder per human turn.
 *
 * The model authors workflow scripts; this module only supplies the standing
 * authorization and reminders. It never creates an autopilot run.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ResolvedConfig } from './config.js';
export interface UltraPreStep {
    readonly agent: Agent;
    readonly messages: readonly UserMessage[];
    readonly turn: number;
    readonly step: number;
}
/** Owns the in-memory activation view; the durable state remains the log. */
export declare class UltraModeController {
    private readonly config;
    private readonly defaultSelection?;
    private readonly commandMode;
    private readonly active;
    private readonly forceFullPlaybook;
    constructor(config: ResolvedConfig, defaultSelection?: (() => {
        provider: string;
        model: string;
        reasoningEffort?: string;
    } | undefined) | undefined);
    /** Load the command mode and current activation view for one agent. */
    onCreated(agent: Agent): void;
    /** Whether the model selection currently says `ultra`. */
    isSelectorUltra(agent: Agent): boolean;
    /** Read the selected effort, for status output. */
    selectedEffort(agent: Agent): string | undefined;
    /**
     * Carry an Ultra default into a blank new session: no selection event and no
     * turn yet. DSH's blank draft keeps the selector choice client-side; the
     * session created on the first send otherwise starts without it and the
     * request header (max) makes the UI fall back to Max. Existing sessions are
     * deliberately never mutated just because Ultra is the current default.
     */
    private ensureDefaultSelection;
    /** Enable or disable the effort-independent command mode. */
    setCommandMode(agent: Agent, enabled: boolean): void;
    /** Whether the command mode is on. */
    commandModeOn(agent: Agent): boolean;
    /** Force the next armed step to re-anchor the full playbook (resume). */
    requestFullPlaybook(agent: Agent): void;
    /** Drop in-memory state when the agent is disposed. */
    dispose(agent: Agent): void;
    /** Append the playbook and/or the per-turn reminder for this step. */
    onPreStep(payload: UltraPreStep): UserMessage[];
}
//# sourceMappingURL=ultra.d.ts.map