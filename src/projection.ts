/** The `ultracode` session projection consumed by the composer play control. */

import type { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { MODE_RECORD, PAUSE_MANIFEST_RECORD, PAUSE_RECORD, RUN_RECORD } from './state.js'
import type {
  AutopilotRunEvent,
  PauseManifestEvent,
  PauseStatusView,
  ProjectionRun,
  UltracodeModeEvent,
  UltracodePauseEvent,
  UltracodeProjectionState,
  UltracodeProjectionView,
} from './types.js'
import './types.js'

const pauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string(),
  turn: z.number(),
  atSeq: z.number(),
}).nullable()

const runSchema = z.object({
  runId: z.string(),
  skill: z.string(),
  phase: z.string(),
  round: z.number(),
  maxRounds: z.number(),
}).nullable()

const pauseStatusSchema = z.object({
  phase: z.enum(['pausing', 'paused', 'resuming']),
  acknowledged: z.number(),
  total: z.number(),
  forced: z.number(),
  warning: z.string().optional(),
}).nullable()

const stateSchema = z.object({
  pause: pauseSchema,
  pauseStatus: pauseStatusSchema.default(null),
  run: runSchema,
  mode: z.enum(['on', 'off']),
})

const viewSchema = z.object({
  paused: z.boolean(),
  reason: z.string().nullable(),
  pauseStatus: pauseStatusSchema,
  run: runSchema,
  mode: z.enum(['on', 'off']),
})

/** Fold one manifest into the compact pausing/paused progress the UI shows. */
function pauseStatusOf(data: PauseManifestEvent): PauseStatusView | null {
  if (data.phase !== 'pausing' && data.phase !== 'paused' && data.phase !== 'resuming') return null
  const total = data.children.length
  const acknowledged = data.children.filter(child =>
    child.state === 'parked'
    || child.state === 'idle'
    || child.state === 'resumed'
    || child.state === 'cold-resumed').length
  const forced = data.children.filter(child => child.forced === true || child.state === 'forced').length
  return {
    phase: data.phase,
    acknowledged,
    total,
    forced,
    ...data.warning === undefined ? {} : { warning: data.warning },
  }
}

export const ultracodeProjectionDefinition = {
  key: 'ultracode' as const,
  stateSchema,
  stateVersion: 1,
  init: (): UltracodeProjectionState => ({
    pause: null,
    pauseStatus: null,
    run: null,
    mode: 'off',
  }),
  apply: (state: UltracodeProjectionState, event: SessionEvent): UltracodeProjectionState => {
    const record = pluginRecordOf(event)
    const type = record?.type ?? (event.type as string)
    if (type === PAUSE_RECORD || type === 'ultracode/pause') {
      const data = (record?.data ?? event.data) as UltracodePauseEvent
      const pause = data.paused
        ? {
            paused: true as const,
            reason: data.reason,
            turn: data.turn,
            atSeq: data.atSeq,
          }
        : null
      return { ...state, pause }
    }
    if (type === RUN_RECORD || type === 'autopilot/run') {
      const data = (record?.data ?? event.data) as AutopilotRunEvent
      const run: ProjectionRun = {
        runId: data.runId,
        skill: data.skill,
        phase: data.phase,
        round: data.round,
        maxRounds: data.maxRounds,
      }
      return { ...state, run }
    }
    if (type === PAUSE_MANIFEST_RECORD) {
      const data = (record?.data ?? event.data) as PauseManifestEvent
      return { ...state, pauseStatus: pauseStatusOf(data) }
    }
    if (type === MODE_RECORD || type === 'ultracode/mode') {
      const data = (record?.data ?? event.data) as UltracodeModeEvent
      const mode = data.enabled ? 'on' as const : 'off' as const
      if (state.mode === mode) return state
      return { ...state, mode }
    }
    return state
  },
  wire: {
    viewSchema,
    view: (state: UltracodeProjectionState): UltracodeProjectionView => ({
      paused: state.pause?.paused === true,
      reason: state.pause?.reason ?? null,
      pauseStatus: state.pauseStatus ?? null,
      run: state.run,
      mode: state.mode,
    }),
  },
}

/** Register the projection when the optional registry is composed. */
export function registerUltracodeProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], scoped => {
    scoped.sessionProjections.register(ultracodeProjectionDefinition)
  })
}
