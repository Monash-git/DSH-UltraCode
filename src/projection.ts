/** The `ultracode` session projection consumed by the composer play control. */

import type { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { MODE_RECORD, PAUSE_RECORD, RUN_RECORD } from './state.js'
import type {
  AutopilotRunEvent,
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

const stateSchema = z.object({
  pause: pauseSchema,
  run: runSchema,
  mode: z.enum(['on', 'off']),
})

const viewSchema = z.object({
  paused: z.boolean(),
  reason: z.string().nullable(),
  run: runSchema,
  mode: z.enum(['on', 'off']),
})

export const ultracodeProjectionDefinition = {
  key: 'ultracode' as const,
  stateSchema,
  stateVersion: 1,
  init: (): UltracodeProjectionState => ({
    pause: null,
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
