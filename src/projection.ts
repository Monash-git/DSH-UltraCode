/** The `ultracode` session projection consumed by the composer play control. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ProjectionRun,
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
    if (event.type === 'ultracode/pause') {
      const pause = event.data.paused
        ? {
            paused: true as const,
            reason: event.data.reason,
            turn: event.data.turn,
            atSeq: event.data.atSeq,
          }
        : null
      return { ...state, pause }
    }
    if (event.type === 'autopilot/run') {
      const run: ProjectionRun = {
        runId: event.data.runId,
        skill: event.data.skill,
        phase: event.data.phase,
        round: event.data.round,
        maxRounds: event.data.maxRounds,
      }
      return { ...state, run }
    }
    if (event.type === 'ultracode/mode') {
      const mode = event.data.enabled ? 'on' as const : 'off' as const
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
