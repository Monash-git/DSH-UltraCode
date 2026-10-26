/** The `ultracode` session projection consumed by the composer play control. */
import { pluginRecordOf } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { MODE_RECORD, PAUSE_MANIFEST_RECORD, PAUSE_RECORD, RUN_RECORD } from './state.js';
import './types.js';
const pauseSchema = z.object({
    paused: z.boolean(),
    reason: z.string(),
    turn: z.number(),
    atSeq: z.number(),
}).nullable();
const runSchema = z.object({
    runId: z.string(),
    skill: z.string(),
    phase: z.string(),
    round: z.number(),
    maxRounds: z.number(),
}).nullable();
const pauseStatusSchema = z.object({
    phase: z.enum(['pausing', 'paused', 'resuming']),
    acknowledged: z.number(),
    total: z.number(),
    forced: z.number(),
    warning: z.string().optional(),
}).nullable();
const stateSchema = z.object({
    pause: pauseSchema,
    pauseStatus: pauseStatusSchema.default(null),
    run: runSchema,
    mode: z.enum(['on', 'off']),
});
const viewSchema = z.object({
    paused: z.boolean(),
    reason: z.string().nullable(),
    pauseStatus: pauseStatusSchema,
    run: runSchema,
    mode: z.enum(['on', 'off']),
});
/** Fold one manifest into the compact pausing/paused progress the UI shows. */
function pauseStatusOf(data) {
    if (data.phase !== 'pausing' && data.phase !== 'paused' && data.phase !== 'resuming')
        return null;
    const total = data.children.length;
    const acknowledged = data.children.filter(child => child.state === 'parked'
        || child.state === 'idle'
        || child.state === 'resumed'
        || child.state === 'cold-resumed').length;
    const forced = data.children.filter(child => child.forced === true || child.state === 'forced').length;
    return {
        phase: data.phase,
        acknowledged,
        total,
        forced,
        ...data.warning === undefined ? {} : { warning: data.warning },
    };
}
export const ultracodeProjectionDefinition = {
    key: 'ultracode',
    stateSchema,
    stateVersion: 1,
    init: () => ({
        pause: null,
        pauseStatus: null,
        run: null,
        mode: 'off',
    }),
    apply: (state, event) => {
        const record = pluginRecordOf(event);
        const type = record?.type ?? event.type;
        if (type === PAUSE_RECORD || type === 'ultracode/pause') {
            const data = (record?.data ?? event.data);
            const pause = data.paused
                ? {
                    paused: true,
                    reason: data.reason,
                    turn: data.turn,
                    atSeq: data.atSeq,
                }
                : null;
            return { ...state, pause };
        }
        if (type === RUN_RECORD || type === 'autopilot/run') {
            const data = (record?.data ?? event.data);
            const run = {
                runId: data.runId,
                skill: data.skill,
                phase: data.phase,
                round: data.round,
                maxRounds: data.maxRounds,
            };
            return { ...state, run };
        }
        if (type === PAUSE_MANIFEST_RECORD) {
            const data = (record?.data ?? event.data);
            return { ...state, pauseStatus: pauseStatusOf(data) };
        }
        if (type === MODE_RECORD || type === 'ultracode/mode') {
            const data = (record?.data ?? event.data);
            const mode = data.enabled ? 'on' : 'off';
            if (state.mode === mode)
                return state;
            return { ...state, mode };
        }
        return state;
    },
    wire: {
        viewSchema,
        view: (state) => ({
            paused: state.pause?.paused === true,
            reason: state.pause?.reason ?? null,
            pauseStatus: state.pauseStatus ?? null,
            run: state.run,
            mode: state.mode,
        }),
    },
};
/** Register the projection when the optional registry is composed. */
export function registerUltracodeProjection(ctx) {
    ctx.inject(['sessionProjections'], scoped => {
        scoped.sessionProjections.register(ultracodeProjectionDefinition);
    });
}
//# sourceMappingURL=projection.js.map