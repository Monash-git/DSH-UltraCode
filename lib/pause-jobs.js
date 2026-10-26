/**
 * Background-job capture, drain, and stop for a root pause.
 *
 * Workflow/bash/pwsh jobs have no pause primitive. Pause records what it can
 * and stops them after a bounded drain; a job that cannot be stopped is a
 * visible `stop-failed` outcome, never a paused or stopped claim.
 */
import { isLiveJobStatus, isTerminalJobStatus, } from './state.js';
import { applyJobOutcomes, refreshPauseWorkflows } from './pause-workflows.js';
import { backgroundJobLabel, stoppedBashWarning } from './pause-warnings.js';
/** Job kinds with no pause primitive; pause stops them or reports failure. */
const STOPPABLE_JOB_KINDS = new Set(['workflow', 'bash', 'pwsh']);
function isStoppableKind(kind) {
    return kind !== undefined && STOPPABLE_JOB_KINDS.has(kind);
}
function isBashKind(kind) {
    return kind === 'bash' || kind === 'pwsh';
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Capture every job owned by the root or one of its live descendants. */
export function collectPauseJobs(root, children, registry) {
    if (registry === undefined)
        return [];
    const record = (view, ownerKind, owner) => {
        if (view.id === undefined)
            return undefined;
        const label = asString(view.label);
        const kind = asString(view.kind);
        const outputs = view.output?.spillPaths?.filter((path) => typeof path === 'string' && path !== '');
        return {
            id: String(view.id),
            ...kind === undefined ? {} : { kind },
            ...label === undefined ? {} : { label },
            ...owner === undefined ? {} : { owner },
            ownerKind,
            ...view.status === undefined ? {} : { status: view.status },
            ...outputs === undefined || outputs.length === 0 ? {} : { outputs: [...outputs] },
            disposition: isTerminalJobStatus(view.status) ? 'settled' : 'recorded',
        };
    };
    const result = [];
    const seen = new Set();
    const add = (job) => {
        if (job === undefined || seen.has(job.id))
            return;
        seen.add(job.id);
        result.push(job);
    };
    const rootId = String(root.session.id);
    for (const view of registry.list(root.session.id)) {
        if (view.owner !== undefined && String(view.owner) !== rootId)
            continue;
        add(record(view, 'root', view.owner === undefined ? undefined : rootId));
    }
    for (const child of children) {
        const childId = String(child.session.id);
        for (const view of registry.list(child.session.id)) {
            if (view.owner !== undefined && String(view.owner) !== childId)
                continue;
            add(record(view, 'child', childId));
        }
    }
    return result;
}
/** Merge jobs registered during the pause drain into the manifest. */
export function refreshPauseJobs(manifest, root, registry, children) {
    const current = new Map(manifest.jobs.map(job => [job.id, job]));
    for (const view of collectPauseJobs(root, children, registry)) {
        const existing = current.get(view.id);
        if (existing === undefined) {
            manifest.jobs.push(view);
            current.set(view.id, view);
            continue;
        }
        // Never rewrite an outcome that was already applied to this job.
        if (existing.disposition !== 'recorded' && existing.disposition !== 'settled')
            continue;
        // Optional fields must be deleted, not assigned `undefined`: plugin
        // records reject any non-JSON value, including an explicit undefined.
        if (view.kind === undefined)
            delete existing.kind;
        else
            existing.kind = view.kind;
        if (view.label === undefined)
            delete existing.label;
        else
            existing.label = view.label;
        if (view.owner === undefined)
            delete existing.owner;
        else
            existing.owner = view.owner;
        existing.ownerKind = view.ownerKind;
        existing.status = view.status;
        if (view.outputs === undefined)
            delete existing.outputs;
        else
            existing.outputs = view.outputs;
        existing.disposition = view.disposition;
    }
}
/**
 * Stop every live workflow/bash/pwsh job after the child park drain. A job
 * that settles during the drain needs no kill; a job that cannot be stopped
 * is recorded as a visible failure and is never reported as paused/stopped.
 */
export async function stopPauseJobs(options) {
    const { manifest, registry } = options;
    if (registry === undefined)
        return;
    // A running child can register a job between the initial snapshot and the
    // stop, and the workflow script can start a member in the same window.
    // Re-read both so no background work is left spending silently and the
    // saved plan captures every child id before the job is cancelled.
    refreshPauseJobs(manifest, options.root, registry, options.children);
    refreshPauseWorkflows(manifest, options.root);
    // Unowned jobs are not this session's background spend; record them but
    // never kill them from one root's pause.
    const targets = manifest.jobs.filter(job => job.owner !== undefined
        && isStoppableKind(job.kind)
        && isLiveJobStatus(job.status));
    if (targets.length > 0) {
        const drained = await Promise.all(targets.map(job => waitJobView(registry, job, options.drainMs)));
        if (options.disposed())
            return;
        const pending = [];
        targets.forEach((job, index) => {
            const view = drained[index];
            if (view !== undefined && isTerminalJobStatus(view.status)) {
                settleJob(job, view, 'settled');
            }
            else {
                pending.push(job);
            }
        });
        await Promise.all(pending.map(job => stopJob(registry, job, options.drainMs)));
        if (options.disposed())
            return;
    }
    for (const childId of applyJobOutcomes(manifest))
        options.forgetChild(childId);
}
/** Request one job kill, then confirm a terminal state within the drain bound. */
async function stopJob(registry, job, drainMs) {
    try {
        if (registry.kill === undefined)
            throw new Error('the host has no job stop API');
        const result = registry.kill(job.id, job.owner, 'paused by user');
        if (result === 'already-finished') {
            const view = await waitJobView(registry, job, drainMs);
            if (view !== undefined && isTerminalJobStatus(view.status)) {
                settleJob(job, view, 'settled');
            }
            else {
                failJob(job, 'could not be confirmed stopped');
            }
            return;
        }
    }
    catch (error) {
        failJob(job, `could not be stopped: ${errorMessage(error)}`);
        return;
    }
    const view = await waitJobView(registry, job, drainMs);
    if (view !== undefined && isTerminalJobStatus(view.status)) {
        settleJob(job, view, 'stopped');
        return;
    }
    const status = view?.status ?? 'unknown';
    failJob(job, `did not stop within ${drainMs} ms (status: ${status})`);
}
async function waitJobView(registry, job, timeoutMs) {
    if (registry.wait === undefined)
        return undefined;
    try {
        return await registry.wait(job.id, timeoutMs, job.owner);
    }
    catch {
        return undefined;
    }
}
function settleJob(job, view, disposition) {
    job.status = view.status;
    const kind = asString(view.kind);
    if (kind !== undefined)
        job.kind = kind;
    const label = asString(view.label);
    if (label !== undefined)
        job.label = label;
    const outputs = view.output?.spillPaths?.filter((path) => typeof path === 'string' && path !== '');
    if (outputs !== undefined && outputs.length > 0)
        job.outputs = [...outputs];
    delete job.warning;
    if (disposition === 'stopped') {
        job.stoppedAt = Date.now();
        if (isBashKind(job.kind))
            job.warning = stoppedBashWarning(job);
    }
    job.disposition = disposition;
}
function failJob(job, reason) {
    job.disposition = 'stop-failed';
    job.warning = `${backgroundJobLabel(job)} ${reason}. `
        + 'It may still be running and spending; stop it manually.';
}
//# sourceMappingURL=pause-jobs.js.map