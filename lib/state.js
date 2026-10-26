/** Per-run state, durable event folding, and session-log reads used by the plugin. */
import { randomUUID } from 'node:crypto';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { maxDurationFor, maxRoundsFor } from './config.js';
/** Job statuses whose work is still owned and spending. */
const LIVE_JOB_STATUSES = new Set(['running', 'stopping']);
/** Job statuses that will never run or spend again. */
const TERMINAL_JOB_STATUSES = new Set(['completed', 'killed', 'failed']);
/** Whether a job is still live (running or stopping). */
export function isLiveJobStatus(status) {
    return status !== undefined && LIVE_JOB_STATUSES.has(status);
}
/** Whether a job has reached a terminal state. */
export function isTerminalJobStatus(status) {
    return status !== undefined && TERMINAL_JOB_STATUSES.has(status);
}
/**
 * The first `running` job owned by this session. A `stopping` job is still
 * live but settles as killed and deliberately sends no completion notice, and
 * unowned jobs wake nobody, so yielding on either would strand the run.
 */
export function liveOwnedJob(registry, owner) {
    if (registry === undefined)
        return undefined;
    return registry.list(owner).find(job => job.owner === owner && job.status === 'running');
}
/** Return whether the agent is a root agent rather than a delegated child. */
export function isRootAgent(agent) {
    return agent.session.header.parentSession === undefined && agent.session.header.origin !== 'subagent';
}
/** Stable map key for one session. */
export function sessionKey(agent) {
    return String(agent.session.id);
}
/** Create a fresh run in the armed state. */
export function createRunState(skill, config, metadataMaxRounds) {
    const now = Date.now();
    return {
        runId: randomUUID(),
        skill,
        phase: 'armed',
        round: 1,
        maxRounds: maxRoundsFor(skill, metadataMaxRounds, config),
        maxDurationMs: maxDurationFor(skill, config),
        startedAt: now,
        updatedAt: now,
        noProgressCount: 0,
        inactiveMs: 0,
    };
}
/** Restore live state from a durable event, including earlier inactive spans. */
export function fromRunEvent(event, config) {
    return {
        runId: event.runId,
        skill: event.skill,
        phase: event.phase,
        round: event.round,
        maxRounds: event.maxRounds,
        maxDurationMs: maxDurationFor(event.skill, config),
        startedAt: event.startedAt,
        updatedAt: event.updatedAt,
        ...event.reason === undefined ? {} : { reason: event.reason },
        noProgressCount: 0,
        inactiveMs: event.inactiveMs ?? 0,
        ...event.inactiveSince === undefined ? {} : { inactiveSince: event.inactiveSince },
    };
}
/**
 * Stop the active-duration clock. Waiting for a background job, waiting for
 * the user, and a paused run do not spend the run's duration budget.
 */
export function markRunWaiting(run, now = Date.now()) {
    if (run.inactiveSince === undefined)
        run.inactiveSince = now;
}
/** Resume the active-duration clock and accumulate the span just ended. */
export function resumeRunActive(run, now = Date.now()) {
    if (run.inactiveSince === undefined)
        return;
    run.inactiveMs += Math.max(0, now - run.inactiveSince);
    run.inactiveSince = undefined;
}
/** Elapsed active time: wall clock minus every waiting or paused span. */
export function activeElapsedMs(run, now = Date.now()) {
    const currentWait = run.inactiveSince === undefined ? 0 : Math.max(0, now - run.inactiveSince);
    return Math.max(0, now - run.startedAt - run.inactiveMs - currentWait);
}
/** Plugin-record types: unknown readers skip them because the envelope is ignorable. */
export const RUN_RECORD = 'plugin:ultracode/run';
export const MODE_RECORD = 'plugin:ultracode/mode';
export const PAUSE_RECORD = 'plugin:ultracode/pause';
export const PAUSE_MANIFEST_RECORD = 'plugin:ultracode/pause-manifest';
export const CHECKPOINT_RECORD = 'plugin:ultracode/checkpoint';
/** Append the current run state as an ignorable plugin record. */
export function appendRunEvent(agent, run) {
    run.updatedAt = Date.now();
    appendPluginRecord(agent.session, RUN_RECORD, {
        runId: run.runId,
        skill: run.skill,
        phase: run.phase,
        round: run.round,
        maxRounds: run.maxRounds,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...run.reason === undefined ? {} : { reason: run.reason },
        inactiveMs: run.inactiveMs,
        ...run.inactiveSince === undefined ? {} : { inactiveSince: run.inactiveSince },
    });
}
/** Append the Ultra mode toggle as an ignorable plugin record. */
export function appendModeEvent(agent, enabled, reason, source) {
    appendPluginRecord(agent.session, MODE_RECORD, {
        enabled,
        ...reason === undefined ? {} : { reason },
        ...source === undefined ? {} : { source },
        updatedAt: Date.now(),
    });
}
/** Append the pause state as an ignorable plugin record. */
export function appendPauseEvent(agent, event) {
    appendPluginRecord(agent.session, PAUSE_RECORD, event);
}
/** Append the whole root-owned pause manifest as an ignorable plugin record. */
export function appendPauseManifest(agent, event) {
    appendPluginRecord(agent.session, PAUSE_MANIFEST_RECORD, event);
}
/** Append one child checkpoint and return its durable sequence number. */
export function appendCheckpointEvent(agent, event) {
    return appendPluginRecord(agent.session, CHECKPOINT_RECORD, event);
}
/** Read the newest run record from a session snapshot. */
export function latestRunEvent(events) {
    const event = lastEvent(events, candidate => recordData(candidate, RUN_RECORD, 'autopilot/run') !== undefined);
    return event === undefined ? undefined : recordData(event, RUN_RECORD, 'autopilot/run');
}
/** Read the newest mode record from a session snapshot. */
export function latestModeEvent(events) {
    const event = lastEvent(events, candidate => recordData(candidate, MODE_RECORD, 'ultracode/mode') !== undefined);
    return event === undefined ? undefined : recordData(event, MODE_RECORD, 'ultracode/mode');
}
/** Read the newest pause record and its sequence from a session snapshot. */
export function latestPauseInfo(events) {
    const event = lastEvent(events, candidate => recordData(candidate, PAUSE_RECORD, 'ultracode/pause') !== undefined);
    if (event === undefined)
        return undefined;
    const data = recordData(event, PAUSE_RECORD, 'ultracode/pause');
    return data === undefined ? undefined : { data, seq: event.seq };
}
/** Read the newest pause record from a session snapshot. */
export function latestPauseEvent(events) {
    return latestPauseInfo(events)?.data;
}
/** Read the newest root pause manifest from a session snapshot. */
export function latestPauseManifest(events) {
    const event = lastEvent(events, candidate => recordData(candidate, PAUSE_MANIFEST_RECORD) !== undefined);
    return event === undefined
        ? undefined
        : recordData(event, PAUSE_MANIFEST_RECORD);
}
/** Read the newest checkpoint written into a child session. */
export function latestCheckpointEvent(events) {
    const event = lastEvent(events, candidate => recordData(candidate, CHECKPOINT_RECORD) !== undefined);
    return event === undefined
        ? undefined
        : recordData(event, CHECKPOINT_RECORD);
}
/** Fold the newest whole child catalog from `subagent/catalog` events. */
export function catalogChildren(events) {
    const result = new Map();
    for (const event of events) {
        if (event.type !== 'subagent/catalog')
            continue;
        const data = event.data;
        if (typeof data.childId !== 'string' || typeof data.mode !== 'string')
            continue;
        result.set(data.childId, {
            id: data.childId,
            mode: data.mode,
            ...typeof data.label === 'string' ? { label: data.label } : {},
        });
    }
    return result;
}
/** Fold the durable workflow run and member records written by the workflow tool. */
export function workflowRuns(events) {
    const result = new Map();
    for (const event of events) {
        const type = event.type;
        if (type === 'tool-workflow/run-start') {
            const data = event.data;
            if (typeof data.runId !== 'string' || typeof data.name !== 'string')
                continue;
            const existing = result.get(data.runId);
            result.set(data.runId, {
                runId: data.runId,
                name: data.name,
                childIds: existing?.childIds ?? [],
                finished: existing?.finished ?? false,
            });
            continue;
        }
        if (type === 'tool-workflow/agent-start') {
            const data = event.data;
            if (typeof data.runId !== 'string' || typeof data.childId !== 'string')
                continue;
            const run = result.get(data.runId);
            if (run === undefined) {
                result.set(data.runId, {
                    runId: data.runId,
                    name: data.runId,
                    childIds: [data.childId],
                    finished: false,
                });
                continue;
            }
            if (!run.childIds.includes(data.childId))
                run.childIds.push(data.childId);
            continue;
        }
        if (type === 'tool-workflow/run-end') {
            const data = event.data;
            if (typeof data.runId !== 'string')
                continue;
            const run = result.get(data.runId);
            if (run !== undefined)
                run.finished = true;
        }
    }
    return [...result.values()];
}
/**
 * Find the original workflow script for one run name. The workflow engine
 * keeps no journal; the model-written script survives only in the assistant
 * tool call, so this is the saved plan a restart can rely on.
 */
export function workflowPlan(events, name) {
    let plan;
    for (const event of events) {
        if (event.type !== 'tool/call')
            continue;
        const data = event.data;
        if (typeof data.arguments !== 'string')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(data.arguments);
        }
        catch {
            continue;
        }
        if (typeof parsed !== 'object' || parsed === null)
            continue;
        const args = parsed;
        if (typeof args.meta !== 'object' || args.meta === null)
            continue;
        const meta = args.meta;
        if (meta.name !== name || typeof args.script !== 'string')
            continue;
        plan = args.script;
    }
    return plan;
}
/** Child ids started by the model-facing workflow tool in this session. */
export function workflowChildIds(events) {
    const result = new Set();
    for (const run of workflowRuns(events)) {
        for (const childId of run.childIds)
            result.add(childId);
    }
    return result;
}
function recordData(event, recordType, legacyType) {
    const record = pluginRecordOf(event);
    if (record?.type === recordType)
        return record.data;
    if (legacyType !== undefined && event.type === legacyType)
        return event.data;
    return undefined;
}
/** Read the newest model selection event. */
export function latestModelSelection(events) {
    const event = lastEvent(events, candidate => candidate.type === 'model/selection');
    if (event === undefined)
        return undefined;
    const data = event.data;
    if (typeof data.provider !== 'string' || typeof data.model !== 'string')
        return undefined;
    return {
        provider: data.provider,
        model: data.model,
        ...typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {},
    };
}
/** Read the newest durable turn closer. */
export function latestTurnEnd(events) {
    const event = lastEvent(events, candidate => candidate.type === 'turn/end');
    if (event?.type !== 'turn/end')
        return undefined;
    const reason = event.data.reason.kind;
    return {
        turn: event.data.turn,
        reason: typeof reason === 'string' ? reason : 'unknown',
        seq: event.seq,
    };
}
/** The currently open turn number, or 0 when the log is balanced. */
export function openTurn(agent) {
    let open = 0;
    for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'turn/start')
            open = event.data.turn;
        else if (event.type === 'turn/end')
            open = 0;
    }
    return open;
}
/** Whether the session has opened or closed a turn, so it is no longer blank. */
export function hasPriorTurn(agent) {
    return agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'turn/end');
}
/** Whether a human-authored prompt appears after the given seq. */
export function hasHumanMessageAfter(events, seq) {
    return events.some(event => event.seq > seq
        && event.type === 'user/message'
        && event.data.source.kind === 'user');
}
/** Whether a run is in a phase that still owns unfinished work. */
export function isUnfinishedPhase(phase) {
    return phase === 'armed'
        || phase === 'running'
        || phase === 'waiting_user'
        || phase === 'waiting_job'
        || phase === 'paused_user'
        || phase === 'paused_resume';
}
/** Whether the inbox holds pending human work (queue or steering). */
export function inboxHasUserWork(agent) {
    const isHuman = (message) => message.source.kind === 'user';
    return agent.inbox.nextTurn.some(isHuman) || agent.inbox.nextStep.some(isHuman);
}
/** Read the newest todo write from a session snapshot, including when it happened. */
export function todoSnapshot(events) {
    const event = lastEvent(events, candidate => todoItemsOf(candidate) !== undefined);
    if (event === undefined)
        return undefined;
    const todos = todoItemsOf(event);
    return todos === undefined ? undefined : { todos, updatedAt: event.time };
}
/** Read the newest whole todo list, or undefined when the todo tool never wrote one. */
export function latestTodos(agent) {
    return todoSnapshot(agent.session.snapshotEvents())?.todos;
}
/** Compact todo summary for a continuation nudge. */
export function todoSummary(agent) {
    const todos = latestTodos(agent);
    if (todos === undefined)
        return 'none';
    const completed = todos.filter(todo => todo.status === 'completed').length;
    const open = todos.length - completed;
    return `${completed} completed, ${open} open`;
}
/** The newest assistant message's text, or an empty string. */
export function latestAssistantText(agent) {
    const event = lastEvent(agent.session.snapshotEvents(), candidate => candidate.type === 'assistant/message');
    if (event?.type !== 'assistant/message')
        return '';
    const parts = [];
    for (const block of event.data.message.content) {
        if (block.type === 'text')
            parts.push(block.text);
    }
    return parts.join('\n');
}
/** Bound the artifact list a checkpoint carries. */
const MAX_ARTIFACT_PATHS = 20;
/** Bound one artifact path so a record cannot grow without limit. */
const MAX_ARTIFACT_PATH_CHARS = 500;
/**
 * Bounded artifact paths the session presented through the `present` tool.
 * The newest unique paths survive; older duplicates are dropped first.
 */
export function latestArtifactPaths(agent) {
    const paths = [];
    for (const event of agent.session.snapshotEvents()) {
        if (event.type !== 'deliverables/presented')
            continue;
        const data = event.data;
        if (!Array.isArray(data.files))
            continue;
        for (const file of data.files) {
            if (typeof file !== 'object' || file === null)
                continue;
            const path = file.path;
            if (typeof path !== 'string' || path === '')
                continue;
            const bounded = path.length <= MAX_ARTIFACT_PATH_CHARS
                ? path
                : `${path.slice(0, MAX_ARTIFACT_PATH_CHARS - 1)}…`;
            if (paths.includes(bounded))
                continue;
            paths.push(bounded);
            if (paths.length > MAX_ARTIFACT_PATHS)
                paths.shift();
        }
    }
    return paths;
}
function lastEvent(events, predicate) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event !== undefined && predicate(event))
            return event;
    }
    return undefined;
}
/** Whether the newest assistant message ends with a question mark. */
export function lastAssistantEndsWithQuestion(agent) {
    const text = latestAssistantText(agent).trim();
    return text.endsWith('?') || text.endsWith('？');
}
/** A stable digest of recent observable progress. */
export function progressDigest(agent) {
    const events = agent.session.snapshotEvents();
    const calls = [];
    const resultLengths = [];
    for (const event of events) {
        if (event.type === 'tool/call') {
            calls.push(event.data.name);
            if (calls.length > 5)
                calls.shift();
        }
        else if (event.type === 'tool/result') {
            resultLengths.push(blockTextLength(event.data.message.content));
            if (resultLengths.length > 5)
                resultLengths.shift();
        }
    }
    return JSON.stringify({
        calls,
        resultLengths,
        todo: latestTodos(agent) ?? [],
        assistant: latestAssistantText(agent).length,
    });
}
/** The newest session event sequence, or 0 for an empty log. */
export function lastSeq(agent) {
    const events = agent.session.snapshotEvents();
    const last = events[events.length - 1];
    return last === undefined ? 0 : last.seq;
}
/** Whether a plugin prompt carrying the marker appears after the latest compaction. */
export function hasPromptSinceCompaction(agent, marker) {
    const events = agent.session.snapshotEvents();
    let lastCompaction = -1;
    let lastPlaybook = -1;
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'compaction/end')
            lastCompaction = index;
        if (event.type === 'user/message'
            && event.data.source.kind === 'ultracode'
            && messageText(event.data).includes(marker)) {
            lastPlaybook = index;
        }
    }
    return lastPlaybook > lastCompaction;
}
/** Whether the compact reminder for one turn already appears in the log. */
export function hasReminderForTurn(agent, turn, markerPrefix) {
    const marker = `${markerPrefix}${turn}]`;
    return agent.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'ultracode'
        && messageText(event.data).includes(marker));
}
/** Project one live run into the client projection shape. */
export function toProjectionRun(run) {
    return {
        runId: run.runId,
        skill: run.skill,
        phase: run.phase,
        round: run.round,
        maxRounds: run.maxRounds,
    };
}
/** Concatenate text blocks of one user message. */
export function messageText(message) {
    return message.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}
function todoItemsOf(event) {
    if (event.type !== 'todo/write')
        return undefined;
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('todos' in data))
        return undefined;
    const todos = data.todos;
    if (!Array.isArray(todos))
        return undefined;
    const result = [];
    for (const todo of todos) {
        if (typeof todo !== 'object' || todo === null)
            return undefined;
        if (!('content' in todo) || typeof todo.content !== 'string')
            return undefined;
        if (!('status' in todo) || typeof todo.status !== 'string')
            return undefined;
        result.push({ content: todo.content, status: todo.status });
    }
    return result;
}
function blockTextLength(blocks) {
    let length = 0;
    for (const block of blocks) {
        if (block.type === 'text')
            length += block.text.length;
    }
    return length;
}
//# sourceMappingURL=state.js.map