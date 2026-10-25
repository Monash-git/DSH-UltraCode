/** Merge-extensible message sources, session events, and the client projection. */

import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

export type AutopilotPhase =
  | 'armed'
  | 'running'
  | 'waiting_user'
  | 'paused_user'
  | 'paused_resume'
  | 'completed'
  | 'exhausted'
  | 'cancelled'
  | 'error'

/** Durable, log-only record of one autopilot or explicit Ultra task run. */
export interface AutopilotRunEvent {
  readonly runId: string
  readonly skill: string
  readonly phase: AutopilotPhase
  readonly round: number
  readonly maxRounds: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly reason?: string
}

/** Durable, log-only record of the Ultra standing-mode state. */
export interface UltracodeModeEvent {
  readonly enabled: boolean
  readonly reason?: string
  readonly source?: 'selector' | 'command' | 'keyword'
  readonly updatedAt: number
}

export type PauseReason = 'user' | 'interrupted' | 'error' | 'max-tokens'
export type ClearReason = 'resumed' | 'cleared' | 'completed'

/** Durable pause state for a root session. */
export interface UltracodePauseEvent {
  readonly paused: boolean
  readonly reason: PauseReason | ClearReason
  readonly turn: number
  readonly atSeq: number
  readonly updatedAt: number
}

/** One run summary carried by the `ultracode` projection. */
export interface ProjectionRun {
  readonly runId: string
  readonly skill: string
  readonly phase: string
  readonly round: number
  readonly maxRounds: number
}

/** Host fold state for the `ultracode` projection; plain JSON only. */
export interface UltracodeProjectionState {
  readonly pause: {
    readonly paused: boolean
    readonly reason: string
    readonly turn: number
    readonly atSeq: number
  } | null
  readonly run: ProjectionRun | null
  readonly mode: 'on' | 'off'
}

/** Client-visible whole value for the `ultracode` projection. */
export interface UltracodeProjectionView {
  readonly paused: boolean
  readonly reason: string | null
  readonly run: ProjectionRun | null
  readonly mode: 'on' | 'off'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A continuation, banner, or completion instruction published by this plugin. */
    'autopilot': { kind: 'autopilot' }
    /** An Ultra playbook, reminder, task, or resume instruction published by this plugin. */
    'ultracode': { kind: 'ultracode'; form?: 'notice'; summary?: string }
  }
}

declare module '@deepseek-ai/dsh-session' {
  /**
   * These are plugin records, not released `SessionEventMap` members. The
   * persistence reader skips unknown types only when the envelope is
   * `ignorable`; `appendPluginRecord` sets that marker and keeps the records
   * outside the release schema.
   */
  interface PluginRecordMap {
    'plugin:ultracode/run': AutopilotRunEvent
    'plugin:ultracode/mode': UltracodeModeEvent
    'plugin:ultracode/pause': UltracodePauseEvent
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    ultracode: UltracodeProjectionView
  }
  interface SessionProjectionStateMap {
    ultracode: UltracodeProjectionState
  }
}
