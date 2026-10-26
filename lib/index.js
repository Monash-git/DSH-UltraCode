/**
 * DSH Ultracode host plugin: selector-level Ultra, standing playbook/reminders,
 * skill autopilot, steer-aware continuation, and pause/resume for root sessions.
 *
 * All model-visible additions are appended user messages. The plugin never
 * changes the system prompt, tool declarations, provider, model, or wire effort.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { handleAutopilotCommand, handlePauseCommand, handleResumeCommand, handleUltraCommand, } from './commands.js';
import { evaluateCompletion } from './completion.js';
import { resolveConfig } from './config.js';
import { findSkillInvocation, hasUserMessage } from './detect.js';
import { registerUltraEffort } from './effort.js';
import { ObservationController } from './observation.js';
import { PauseController } from './pause.js';
import { PauseCoordinator, } from './pause-coordinator.js';
import { registerUltracodeProjection } from './projection.js';
import { autopilotBanner, changeApproachNudge, continuationNudge, wrapUpNudge, } from './prompts.js';
import { installBusyEnterDefault } from './steering.js';
import { createSessionStatusTool } from './status.js';
import { TaskStateController } from './task-state.js';
import { activeElapsedMs, appendRunEvent, createRunState, fromRunEvent, inboxHasUserWork, isRootAgent, isUnfinishedPhase, lastAssistantEndsWithQuestion, latestModelSelection, latestRunEvent, latestTodos, liveOwnedJob, markRunWaiting, progressDigest, resumeRunActive, sessionKey, todoSummary, } from './state.js';
import { UltraModeController } from './ultra.js';
import { WakeGate } from './wake.js';
export const name = 'dsh-ultracode';
export const inject = ['tools', 'commands', 'workingDirectory'];
/** Plugin entry: effort decoration, Ultra standing mode, autopilot, pause/resume. */
export function apply(ctx, config = {}) {
    const settings = resolveConfig(config);
    const runs = new Map();
    const hydrated = new Set();
    /** One typed accessor for every optional host service. */
    const service = (name) => serviceOf(ctx, name);
    const jobs = () => service('jobs');
    const sessions = () => service('sessions');
    const coordinator = new PauseCoordinator({
        timeoutMs: settings.pauseTimeoutMs,
        drainMs: settings.pauseDrainMs,
        agents: () => service('agents'),
        subagents: () => service('subagents'),
        sessions,
        jobs,
    });
    // A background wake claimed while paused is captured durably before the
    // step is rejected, so Play can replay it and a crash cannot drop it.
    const wake = new WakeGate({
        flush: async (agent) => {
            try {
                await sessions()?.flush(agent.session);
            }
            catch {
                // The records are already in the live log; a failed barrier must not
                // let the held wake reach the model.
            }
        },
    });
    const pause = new PauseController(settings, runs, coordinator, wake);
    const defaultSelection = () => {
        const model = service('agentDefaultModel');
        return model?.currentSelection();
    };
    const ultra = new UltraModeController(settings, defaultSelection);
    const taskState = new TaskStateController();
    const observation = new ObservationController();
    const selectMax = (agent) => {
        const selection = latestModelSelection(agent.session.snapshotEvents());
        if (selection?.reasoningEffort !== 'ultra')
            return;
        const fallback = () => {
            ;
            agent.session.append('model/selection', {
                provider: selection.provider,
                model: selection.model,
                reasoningEffort: 'max',
            });
        };
        const controller = service('sessionController');
        if (controller === undefined) {
            fallback();
            return;
        }
        void controller.selectModel({
            sessionId: agent.session.id,
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: 'max',
        }).catch((error) => {
            console.error('[dsh-ultracode] unable to select Max through the session controller:', error);
            fallback();
        });
    };
    const commands = { runs, pause, ultra, selectMax };
    /**
     * Rebuild this instance's in-memory view from the durable log. A hot reload
     * creates a new plugin instance while agents stay live, so `agent/created`
     * will not fire for them again; `live` also tells pause restoration not to
     * treat the reload as a session restart. Existing sessions are read, never
     * rewritten.
     */
    const restoreAgent = (agent, live) => {
        const key = sessionKey(agent);
        if (hydrated.has(key))
            return;
        hydrated.add(key);
        const event = latestRunEvent(agent.session.snapshotEvents());
        if (event !== undefined)
            runs.set(key, fromRunEvent(event, settings));
        else
            runs.delete(key);
        const restored = runs.get(key);
        if (restored !== undefined
            && (restored.phase === 'waiting_job'
                || restored.phase === 'waiting_user'
                || restored.phase === 'paused_user'
                || restored.phase === 'paused_resume')) {
            // Start the exclusion at the durable record, not at reload: the whole
            // waiting or paused span belongs outside the active-time budget.
            markRunWaiting(restored, restored.updatedAt);
        }
        if (live)
            pause.hydrate(agent);
        else
            pause.onCreated(agent);
        if (restored !== undefined && pause.isPaused(agent))
            markRunWaiting(restored);
        ultra.onCreated(agent);
        if (pause.isPaused(agent) || runs.get(key)?.phase === 'paused_resume') {
            ultra.requestFullPlaybook(agent);
        }
    };
    const restoreLiveAgents = (scope) => {
        const agents = serviceOf(scope, 'agents');
        for (const agent of agents?.list() ?? [])
            restoreAgent(agent, true);
    };
    // Disposal is a reload or an uninstall, never a reason to mutate a session.
    // A true shutdown ends the live turn with the process; the durable run
    // record is restored as `paused_resume` the next time the session loads.
    // Parked child turns are released so an unload cannot leave them hanging.
    ctx.effect(() => () => {
        runs.clear();
        hydrated.clear();
        coordinator.dispose();
    });
    if (settings.ultraEffort)
        registerUltraEffort(ctx);
    const stopSteering = installBusyEnterDefault(ctx, settings);
    ctx.effect(() => stopSteering);
    registerUltracodeProjection(ctx);
    ctx.on('agent/created', ({ agent, source }) => {
        const key = sessionKey(agent);
        if (source === 'clear') {
            hydrated.delete(key);
            runs.delete(key);
            pause.dispose(agent);
            ultra.dispose(agent);
            return undefined;
        }
        restoreAgent(agent, false);
        return undefined;
    });
    ctx.on('agent/disposed', ({ agent }) => {
        const key = sessionKey(agent);
        hydrated.delete(key);
        runs.delete(key);
        pause.dispose(agent);
        ultra.dispose(agent);
    });
    // Restore live agents that outlived a previous plugin instance (hot reload).
    // Keep the inject form so a late-mounted registry is still scanned once.
    restoreLiveAgents(ctx);
    ctx.inject(['agents'], scoped => restoreLiveAgents(scoped));
    ctx.on('agent/error', ({ agent, turn }) => {
        pause.onError(agent, turn);
    });
    // Park gate: runs for every agent. A child with a root pause request is
    // checkpointed, acknowledged, and held at this pre-step boundary without
    // ending its turn. The host pause control is stripped for every model.
    ctx.on('agent/pre-step', async (payload, next) => coordinator.onPreStep(payload, next));
    // The listener calls next() first, so the skill body and the catalog have
    // already been appended; our additions are always last.
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        if (!isRootAgent(payload.agent))
            return decision;
        try {
            const { agent, messages, turn, step } = payload;
            const pauseAction = await pause.onPreStep(agent, messages);
            if (pauseAction.kind === 'held') {
                // The wake is durable now. Rejecting closes the turn without a model
                // request; Play replays the captured batch.
                return { kind: 'reject' };
            }
            const additions = [];
            if (pauseAction.kind === 'released')
                additions.push(...pauseAction.messages);
            additions.push(...ultra.onPreStep({ agent, messages, turn, step }));
            additions.push(...taskState.onPreStep(agent));
            additions.push(...observation.onPreStep(agent));
            const key = sessionKey(agent);
            const current = runs.get(key);
            const terminal = current === undefined || !isUnfinishedPhase(current.phase);
            const invocation = findSkillInvocation(messages);
            if (invocation !== undefined && terminal) {
                const skill = await loadSkill(ctx, agent, invocation, payload.signal);
                const metadata = skill?.metadata;
                if (metadata?.autopilot === true) {
                    const metadataMaxRounds = typeof metadata.maxRounds === 'number' ? metadata.maxRounds : undefined;
                    const run = createRunState(invocation, settings, metadataMaxRounds);
                    runs.set(key, run);
                    additions.push(createUserMessage({
                        content: [{ type: 'text', text: autopilotBanner(invocation, 1, run.maxRounds) }],
                        source: { kind: 'autopilot' },
                    }));
                    run.phase = 'running';
                    appendRunEvent(agent, run);
                }
            }
            else if (current !== undefined && current.phase === 'waiting_job' && messages.length > 0) {
                // A completion notice, a user message, or any other admitted input
                // wakes the run. The wake is a yield/resume cycle, so it counts.
                resumeRunActive(current);
                current.round += 1;
                current.phase = 'running';
                // The waiting reason is not remaining work; the model's next answer
                // and continuation nudge must not treat it as such.
                delete current.reason;
                appendRunEvent(agent, current);
            }
            else if (current !== undefined
                && (current.phase === 'waiting_user' || current.phase === 'paused_resume')
                && hasUserMessage(messages)) {
                resumeRunActive(current);
                current.phase = 'running';
                delete current.reason;
                appendRunEvent(agent, current);
            }
            if (additions.length === 0)
                return decision;
            return { ...decision, messages: [...decision.messages, ...additions] };
        }
        catch (error) {
            console.error('[dsh-ultracode] pre-step failed:', error);
            return decision;
        }
    });
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
        if (!isRootAgent(agent))
            return;
        const run = runs.get(sessionKey(agent));
        if (run !== undefined && run.phase === 'running') {
            const pauseResult = pause.onTurnStopping(agent, turn, signal);
            if (pauseResult === 'cancelled') {
                run.phase = 'cancelled';
                run.reason = 'turn cancelled';
                appendRunEvent(agent, run);
                return;
            }
            if (pauseResult === 'paused')
                return;
            if (inboxHasUserWork(agent))
                return;
            if (lastAssistantEndsWithQuestion(agent)) {
                run.phase = 'waiting_user';
                run.reason = 'waiting for user answer';
                markRunWaiting(run);
                appendRunEvent(agent, run);
                return;
            }
            const job = liveOwnedJob(jobs(), agent.session.id);
            if (job !== undefined) {
                // A run at a cap must not yield into an uncounted turn.
                if (run.round >= run.maxRounds) {
                    wrapUp(agent, run, 'round limit');
                    return;
                }
                if (activeElapsedMs(run) >= run.maxDurationMs) {
                    wrapUp(agent, run, 'time limit');
                    return;
                }
                run.phase = 'waiting_job';
                run.reason = typeof job.id === 'string'
                    ? `waiting for background job ${job.id}`
                    : 'waiting for background job';
                markRunWaiting(run);
                appendRunEvent(agent, run);
                return;
            }
            if (run.round >= run.maxRounds) {
                wrapUp(agent, run, 'round limit');
                return;
            }
            if (activeElapsedMs(run) >= run.maxDurationMs) {
                wrapUp(agent, run, 'time limit');
                return;
            }
            const digest = progressDigest(agent);
            if (digest === run.noProgressDigest) {
                run.noProgressCount += 1;
            }
            else {
                run.noProgressDigest = digest;
                run.noProgressCount = 1;
            }
            if (run.noProgressCount > settings.noProgressRounds) {
                wrapUp(agent, run, 'no progress');
                return;
            }
            if (run.noProgressCount === settings.noProgressRounds) {
                agent.steer(createUserMessage({
                    content: [{ type: 'text', text: changeApproachNudge(run.skill) }],
                    source: { kind: 'autopilot' },
                }));
                return;
            }
            run.round += 1;
            appendRunEvent(agent, run);
            agent.steer(createUserMessage({
                content: [{
                        type: 'text',
                        text: continuationNudge(run.skill, run.round, run.maxRounds, todoSummary(agent), run.reason ?? 'unknown'),
                    }],
                source: { kind: 'autopilot' },
            }));
            return;
        }
        // No running skill run: still persist a paused root session on Stop/crash.
        pause.onTurnStopping(agent, turn, signal);
    });
    const completeRun = defineTool({
        name: 'complete_run',
        description: 'Finish the active autopilot run. Call only when every part of the skill\'s work is done and verified, or when you are blocked.',
        parameters: {
            summary: { type: 'string', required: true, description: 'What was completed, with evidence.' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths or URLs produced.' },
            remaining: { type: 'array', items: { type: 'string' }, description: 'Remaining work. Must be empty unless blocked.' },
            blocked: { type: 'string', description: 'A concrete blocker. Set only when you cannot finish.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    blocked: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.blocked ? `Run blocked: ${value.summary}` : `Run complete: ${value.summary}`,
                }],
        },
        async execute(args, exec) {
            const agent = exec.agent;
            if (agent === undefined)
                throw new Error('complete_run requires a calling agent');
            if (!isRootAgent(agent))
                throw new Error('complete_run is only available to the root agent');
            const key = sessionKey(agent);
            const run = runs.get(key);
            if (run === undefined || run.phase !== 'running') {
                throw new Error('No active autopilot run.');
            }
            const summary = args.artifacts !== undefined && args.artifacts.length > 0
                ? `${args.summary} [artifacts: ${args.artifacts.join(', ')}]`
                : args.summary;
            const openTodos = (latestTodos(agent) ?? []).filter(todo => todo.status !== 'completed');
            const decision = evaluateCompletion(args, openTodos);
            if (decision.kind === 'more')
                throw new Error(decision.error);
            if (decision.kind === 'blocked') {
                run.phase = 'exhausted';
                run.reason = decision.reason;
                appendRunEvent(agent, run);
                pause.complete(agent);
                exec.concludeTurn();
                return { summary, blocked: true };
            }
            run.phase = 'completed';
            appendRunEvent(agent, run);
            pause.complete(agent);
            exec.concludeTurn();
            return { summary, blocked: false };
        },
    });
    ctx.tools.register(completeRun);
    ctx.tools.register(createSessionStatusTool({
        runs,
        pause,
        readJobs: (agent) => {
            const registry = service('jobs');
            return registry?.list(agent.session.id) ?? [];
        },
    }));
    ctx.commands.register({
        name: 'autopilot',
        description: 'Inspect or control the active autopilot run',
        input: { hint: '[status|off|pause|resume]' },
        handler: invocation => handleAutopilotCommand(invocation.agent, invocation.rawInput, commands),
    });
    ctx.commands.register({
        name: 'pause',
        description: 'Pause the current root session and keep it resumable',
        recordInput: false,
        handler: invocation => handlePauseCommand(invocation.agent, commands),
    });
    ctx.commands.register({
        name: 'resume',
        description: 'Resume a paused root session or autopilot run',
        recordInput: false,
        handler: invocation => handleResumeCommand(invocation.agent, commands),
    });
    ctx.commands.register({
        name: 'ultra',
        description: 'Toggle the Ultra standing mode or run an explicit Ultra task',
        input: { hint: '[on|off|status|<task>]' },
        recordInput: false,
        handler: invocation => handleUltraCommand(invocation.agent, invocation.rawInput, commands),
    });
}
function wrapUp(agent, run, reason) {
    run.phase = 'exhausted';
    run.reason = reason;
    appendRunEvent(agent, run);
    agent.steer(createUserMessage({
        content: [{ type: 'text', text: wrapUpNudge(run.skill, reason) }],
        source: { kind: 'autopilot' },
    }));
}
async function loadSkill(ctx, agent, name, signal) {
    const skills = serviceOf(ctx, 'skills');
    if (skills === undefined)
        return undefined;
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    return await skills.get(name, { cwd, scope: agent });
}
/** Read one optional service without repeating the cordis type cast. */
function serviceOf(ctx, name) {
    return ctx.get(name);
}
//# sourceMappingURL=index.js.map