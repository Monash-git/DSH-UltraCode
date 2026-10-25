/** Merge-extensible message sources, session events, and the client projection. */

import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

export type AutopilotPhase =
  | 'armed'
  | 'running'
  | 'waiting_user'
  | 'waiting_job'
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

/** Root-mediated pause lifecycle recorded in the pause manifest. */
export type PauseManifestPhase = 'pausing' | 'paused' | 'resuming' | 'resumed' | 'cancelled'

/** Per-child disposition recorded in the pause manifest. */
export type PauseChildState =
  | 'pausing'
  | 'parked'
  | 'idle'
  | 'forced'
  | 'stopped'
  | 'resumed'
  | 'cold-resumed'
  | 'restarted'
  | 'restart-required'
  | 'unavailable'
  | 'disposed'
  | 'cancelled'

/** One local descendant in the root-owned pause manifest. */
export interface PauseManifestChild {
  readonly id: string
  readonly label?: string
  readonly mode: string
  /** The child belongs to a workflow run recorded in the root session. */
  readonly workflow?: boolean
  readonly state: PauseChildState
  readonly forced?: boolean
  readonly acknowledgedAt?: number
  readonly checkpointAt?: number
  readonly checkpointSeq?: number
  readonly warning?: string
}

/**
 * What pause/play did with one background job.
 *
 * - `recorded`: observed only (not a workflow/bash job, or no stop was needed).
 * - `settled`: already terminal before pause, or finished during the drain.
 * - `stopped`: a kill was requested and a terminal settlement was observed.
 * - `stop-failed`: the job could not be stopped or its stop could not be
 *   confirmed; it must not be reported as paused or stopped.
 * - `restart-required`: Play issued a restart instruction for the stopped job.
 * - `cancelled`: the pause was cancelled, so no automatic restart follows.
 */
export type PauseJobDisposition =
  | 'recorded'
  | 'settled'
  | 'stopped'
  | 'stop-failed'
  | 'restart-required'
  | 'cancelled'

/** One background job observed and, for workflow/bash work, stopped by pause. */
export interface PauseManifestJob {
  id: string
  kind?: string
  label?: string
  owner?: string
  ownerKind: 'root' | 'child'
  status?: string
  /** Durable output files the producer kept for this job, when it reported any. */
  outputs?: readonly string[]
  disposition: PauseJobDisposition
  stoppedAt?: number
  warning?: string
}

/**
 * Lifecycle of one workflow run captured at pause.
 *
 * - `running`: live when the pause started.
 * - `finished`: the root session already recorded its `run-end`.
 * - `settled`: it finished during the pause drain before a kill was needed.
 * - `stopped`: its job reached a terminal state after the kill request.
 * - `stop-failed`: its job could not be stopped or confirmed stopped.
 * - `restart-required`: Play instructed the root to restart it.
 */
export type PauseWorkflowState =
  | 'running'
  | 'finished'
  | 'settled'
  | 'stopped'
  | 'stop-failed'
  | 'restart-required'

/**
 * Durable capture of one workflow run: the plan (the original script), the
 * output paths the producer kept, and every child Session id. The workflow
 * engine has no journal, so Play restarts from this state instead of claiming
 * a run-level resume.
 */
export interface PauseManifestWorkflow {
  runId: string
  name: string
  jobId?: string
  childIds: string[]
  plan?: string
  artifacts: string[]
  workspace?: string
  state: PauseWorkflowState
  warning?: string
}

/** Durable root-owned pause manifest; the single source of truth for a pause. */
export interface PauseManifestEvent {
  readonly pauseId: string
  readonly rootId: string
  phase: PauseManifestPhase
  readonly startedAt: number
  updatedAt: number
  readonly timeoutMs: number
  rootCheckpointAt?: number
  rootCheckpointSeq?: number
  children: readonly PauseManifestChild[]
  jobs: PauseManifestJob[]
  workflows?: PauseManifestWorkflow[]
  forced: number
  warning?: string
  /** The model-visible restart instruction Play delivered, for the durable record. */
  restartInstruction?: string
}

/** Durable checkpoint written into a parked child's own session. */
export interface PauseCheckpointEvent {
  readonly pauseId: string
  readonly childId: string
  readonly turn: number
  readonly step: number
  readonly atSeq: number
  readonly at: number
  readonly forced: boolean
  readonly todos?: readonly { readonly content: string; readonly status: string }[]
  readonly lastAssistantText?: string
}

/** Pausing progress and forced-stop facts carried by the client projection. */
export interface PauseStatusView {
  readonly phase: 'pausing' | 'paused' | 'resuming'
  readonly acknowledged: number
  readonly total: number
  readonly forced: number
  readonly warning?: string
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
  readonly pauseStatus: PauseStatusView | null
  readonly run: ProjectionRun | null
  readonly mode: 'on' | 'off'
}

/** Client-visible whole value for the `ultracode` projection. */
export interface UltracodeProjectionView {
  readonly paused: boolean
  readonly reason: string | null
  readonly pauseStatus: PauseStatusView | null
  readonly run: ProjectionRun | null
  readonly mode: 'on' | 'off'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A continuation, banner, or completion instruction published by this plugin. */
    'autopilot': { kind: 'autopilot' }
    /**
     * An Ultra playbook, reminder, task, resume instruction, or host-side
     * pause control published by this plugin. A `pause` message is a control
     * signal consumed by the pre-step gate and never reaches the model.
     */
    'ultracode': {
      kind: 'ultracode'
      form?: 'notice' | 'pause'
      summary?: string
      pauseId?: string
    }
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
    'plugin:ultracode/pause-manifest': PauseManifestEvent
    'plugin:ultracode/checkpoint': PauseCheckpointEvent
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
