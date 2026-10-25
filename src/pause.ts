/**
 * Durable pause/resume for every root session.
 *
 * A pause is a log-only `ultracode/pause` event plus, when a skill run is
 * active, a `paused_user`/`paused_resume` run phase. Resume is one appended
 * user message; nothing rewrites history.
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'
import type { PauseCoordinator } from './pause-coordinator.js'
import { continuationNudge, genericResumeNudge } from './prompts.js'
import {
  appendPauseEvent,
  appendPauseManifest,
  appendRunEvent,
  hasHumanMessageAfter,
  isRootAgent,
  isUnfinishedPhase,
  lastSeq,
  latestPauseInfo,
  latestPauseManifest,
  latestTurnEnd,
  markRunWaiting,
  openTurn,
  resumeRunActive,
  sessionKey,
  todoSummary,
  type RunState,
} from './state.js'
import type {
  ClearReason,
  PauseManifestEvent,
  PauseReason,
  UltracodePauseEvent,
} from './types.js'
import { WakeGate, type PendingWakes, type WakeReleaseReason } from './wake.js'

export interface PauseOutcome {
  readonly ok: boolean
  readonly text: string
}

/** What a root pre-step should do with the claimed batch while paused. */
export type PausePreStepAction =
  | { readonly kind: 'none' }
  /** The batch was captured durably; reject the step so no model turn starts. */
  | { readonly kind: 'held' }
  /** The user started a new direction; these held wakes join that turn. */
  | { readonly kind: 'released'; readonly messages: readonly UserMessage[] }

const RESUMABLE_TURN_END = new Set(['aborted', 'interrupted', 'error', 'max-tokens'])

/** Owns the per-session pause state and the resume commands. */
export class PauseController {
  private readonly paused = new Map<string, { reason: PauseReason | ClearReason; turn: number; atSeq: number }>()
  private readonly explicitCancel = new Set<string>()
  /** Job-restart warnings for pauses restored from a previous process. */
  private readonly restoredWarnings = new Map<string, string>()
  private readonly wake: WakeGate

  constructor(
    private readonly config: ResolvedConfig,
    private readonly runs: Map<string, RunState>,
    private readonly coordinator?: PauseCoordinator,
    wake?: WakeGate,
  ) {
    this.wake = wake ?? new WakeGate()
  }

  /**
   * Load durable pause state for an agent that stays live across a plugin
   * reload. A reload is not a session restart: an unfinished run is left
   * untouched and no pause record is written.
   */
  hydrate(agent: Agent): void {
    if (!isRootAgent(agent)) return
    const key = sessionKey(agent)
    const events = agent.session.snapshotEvents()
    this.restorePaused(agent)
    // A hot reload cancelled the previous instance's park waits; settle an
    // interrupted transition so the primary control shows Play, not a stuck
    // pausing state. Jobs may still be alive, so no restart warning here.
    this.settleRestoredPause(agent, events, key, false)
  }

  /** Load durable state and promote a crash-interrupted turn to paused. */
  onCreated(agent: Agent): void {
    if (!isRootAgent(agent)) return
    const key = sessionKey(agent)
    const events = agent.session.snapshotEvents()
    const { latestPause, pauseSeq } = this.restorePaused(agent)
    this.settleRestoredPause(agent, events, key, true)

    const run = this.runs.get(key)
    if (run !== undefined && run.phase === 'waiting_user' && !this.paused.has(key)) {
      // A model question is an answer-pending state, not the play-button
      // pause. An explicit pause recorded after the question still wins.
      return
    }
    if (run !== undefined && isUnfinishedPhase(run.phase)) {
      // Downtime between processes is not active time for the run.
      markRunWaiting(run)
      run.phase = 'paused_resume'
      run.reason = 'session restarted'
      appendRunEvent(agent, run)
      if (!this.paused.has(key)) this.markPaused(agent, 'interrupted', latestTurnEnd(events)?.turn ?? 0)
      return
    }

    if (this.paused.has(key)) return
    const end = latestTurnEnd(events)
    if (end === undefined || !RESUMABLE_TURN_END.has(end.reason)) return
    if (hasHumanMessageAfter(events, end.seq)) return
    if (latestPause !== undefined && !latestPause.paused && pauseSeq > end.seq) return
    this.markPaused(agent, 'interrupted', end.turn)
  }

  /**
   * Reconcile a pause loaded from a persisted log. A previous process cannot
   * finish a `pausing`/`resuming` transition, so settle the manifest to
   * `paused` (reopening must show Play). A process restart also lost every
   * recorded job: persist that warning once and keep it for the Play result.
   */
  private settleRestoredPause(
    agent: Agent,
    events: readonly SessionEvent[],
    key: string,
    processRestart: boolean,
  ): void {
    if (!this.paused.has(key)) return
    const manifest = latestPauseManifest(events)
    if (manifest === undefined) return
    const warning = processRestart ? jobRestartWarning(manifest) : undefined
    if (warning !== undefined) this.restoredWarnings.set(key, warning)
    const settled = manifest.phase === 'pausing' || manifest.phase === 'resuming'
    if (!settled && (warning === undefined || manifest.warning?.includes(warning) === true)) return
    const combined = warning === undefined
      ? manifest.warning
      : manifest.warning === undefined
        ? warning
        : manifest.warning.includes(warning)
          ? manifest.warning
          : `${manifest.warning} ${warning}`
    appendPauseManifest(agent, {
      ...manifest,
      ...(settled ? { phase: 'paused' as const } : {}),
      ...combined === undefined ? {} : { warning: combined },
      updatedAt: Date.now(),
    })
  }

  /** Fold the newest durable pause record into the in-memory view. */
  private restorePaused(agent: Agent): {
    latestPause: UltracodePauseEvent | undefined
    pauseSeq: number
  } {
    const key = sessionKey(agent)
    const pauseInfo = latestPauseInfo(agent.session.snapshotEvents())
    const latestPause = pauseInfo?.data
    if (latestPause?.paused === true) {
      this.paused.set(key, {
        reason: latestPause.reason,
        turn: latestPause.turn,
        atSeq: latestPause.atSeq,
      })
    } else {
      this.paused.delete(key)
    }
    return { latestPause, pauseSeq: pauseInfo?.seq ?? -1 }
  }

  /**
   * Apply the root pause gate to one claimed batch.
   *
   * A human message cancels the pause and starts a new direction; any wakes
   * held earlier are released into that same turn so nothing is lost. A pure
   * background wake (job notice, subagent settlement, schedule input) is
   * captured durably and the step is rejected: the driver closes the turn
   * without a model request, and Play replays the batch later.
   */
  async onPreStep(agent: Agent, messages: readonly UserMessage[]): Promise<PausePreStepAction> {
    const key = sessionKey(agent)
    if (!isRootAgent(agent) || !this.paused.has(key)) return { kind: 'none' }
    if (messages.some(message => message.source.kind === 'user')) {
      this.clear(agent, 'cleared')
      void this.coordinator?.release(agent, 'cancel').catch((error: unknown) => {
        console.error('[dsh-ultracode] cancelling the child pause failed:', error)
      })
      const run = this.runs.get(key)
      if (run !== undefined && (run.phase === 'paused_user' || run.phase === 'paused_resume')) {
        run.phase = 'cancelled'
        run.reason = 'user continued with a new message'
        appendRunEvent(agent, run)
      }
      const pending = this.wake.pending(agent)
      this.wake.markReleased(agent, pending.holds, 'user-direction')
      await this.wake.flush(agent)
      return { kind: 'released', messages: pending.messages }
    }
    if (messages.length === 0) return { kind: 'none' }
    await this.wake.hold(agent, latestPauseManifest(agent.session.snapshotEvents())?.pauseId, messages)
    return { kind: 'held' }
  }

  /** Pause immediately; cancel the active turn when there is one. */
  pause(agent: Agent): PauseOutcome {
    if (!isRootAgent(agent)) return { ok: false, text: 'Pause is only available to the root session.' }
    const key = sessionKey(agent)
    if (this.paused.has(key)) return { ok: true, text: 'Session is already paused.' }
    const turn = openTurn(agent) || latestTurnEnd(agent.session.snapshotEvents())?.turn || 0
    this.markPaused(agent, 'user', turn)
    const run = this.runs.get(key)
    if (run !== undefined
      && (run.phase === 'running' || run.phase === 'armed' || run.phase === 'waiting_job')) {
      // Paused time is not active time, whether the run was working or idle
      // while waiting for a background job.
      markRunWaiting(run)
      run.phase = 'paused_user'
      run.reason = 'paused by user'
      appendRunEvent(agent, run)
    }
    // Make the durable pause record independent of the coordinator's slower
    // manifest write: a crash right after the user clicks Pause must still
    // reopen as paused.
    void this.wake.flush(agent)
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    if (this.coordinator !== undefined) {
      // The command returns immediately; acknowledgment waits are bounded by
      // the coordinator timeout and never hold the UI request open.
      void this.coordinator.begin(agent, randomUUID()).catch((error: unknown) => {
        console.error('[dsh-ultracode] root pause coordination failed:', error)
      })
      return { ok: true, text: 'Pausing session.' }
    }
    return { ok: true, text: 'Session paused.' }
  }

  /** Resume a paused autopilot run or a generic interrupted turn. */
  resume(agent: Agent): PauseOutcome {
    return this.resumeLocal(agent, false)
  }

  /**
   * Resume and wait for child release, so Play can report a cold-resume
   * failure. Used by the `/resume` command; the autopilot command keeps the
   * non-blocking path.
   */
  async resumeAsync(agent: Agent): Promise<PauseOutcome> {
    if (!isRootAgent(agent)) return { ok: false, text: 'Resume is only available to the root session.' }
    const key = sessionKey(agent)
    const warnings: string[] = []
    if (this.coordinator !== undefined) {
      try {
        const released = await this.coordinator.release(agent, 'resume')
        warnings.push(...released.warnings)
      } catch (error: unknown) {
        warnings.push(`Child release failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const restoredWarning = this.restoredWarnings.get(key)
    if (restoredWarning !== undefined) warnings.push(restoredWarning)
    const outcome = this.resumeLocal(agent, true)
    // The release records are only as good as the next flush; Play is the one
    // place where waiting for durability does not delay a live turn.
    await this.wake.flush(agent)
    if (!outcome.ok) return outcome
    this.restoredWarnings.delete(key)
    if (warnings.length === 0) return outcome
    return { ok: true, text: `${outcome.text} ${warnings.join(' ')}` }
  }

  private resumeLocal(agent: Agent, releasedChildren: boolean): PauseOutcome {
    if (!isRootAgent(agent)) return { ok: false, text: 'Resume is only available to the root session.' }
    const key = sessionKey(agent)
    const run = this.runs.get(key)
    if (run !== undefined && (run.phase === 'paused_user' || run.phase === 'paused_resume')) {
      if (run.round >= run.maxRounds) {
        run.phase = 'exhausted'
        run.reason = 'round limit'
        appendRunEvent(agent, run)
        this.clear(agent, 'cleared')
        return { ok: false, text: 'The run has reached its round limit.' }
      }
      const previous = { phase: run.phase, round: run.round, reason: run.reason }
      const nextRound = run.round + 1
      let staged: ReturnType<PauseController['stageHeld']>
      try {
        staged = this.stageHeld(agent)
      } catch (error: unknown) {
        return { ok: false, text: `Unable to resume the run: ${error instanceof Error ? error.message : String(error)}` }
      }
      try {
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: continuationNudge(run.skill, nextRound, run.maxRounds, todoSummary(agent), 'resumed by user'),
          }],
          source: { kind: 'autopilot' },
        }))
      } catch (error: unknown) {
        this.unstageHeld(agent, staged)
        run.phase = previous.phase
        run.round = previous.round
        run.reason = previous.reason
        return { ok: false, text: `Unable to resume the run: ${error instanceof Error ? error.message : String(error)}` }
      }
      this.finishHeld(agent, staged, 'play')
      if (!releasedChildren) this.releaseChildren(agent)
      resumeRunActive(run)
      run.round = nextRound
      run.phase = 'running'
      run.reason = 'resumed by user'
      appendRunEvent(agent, run)
      this.clear(agent, 'resumed')
      return { ok: true, text: `Autopilot resumed for ${run.skill}.` }
    }
    if (!this.paused.has(key)) {
      return { ok: false, text: 'No paused session to resume.' }
    }
    let staged: ReturnType<PauseController['stageHeld']>
    try {
      staged = this.stageHeld(agent)
    } catch (error: unknown) {
      return { ok: false, text: `Unable to resume the session: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: genericResumeNudge(todoSummary(agent)) }],
        source: { kind: 'ultracode' },
      }))
    } catch (error: unknown) {
      this.unstageHeld(agent, staged)
      return { ok: false, text: `Unable to resume the session: ${error instanceof Error ? error.message : String(error)}` }
    }
    this.finishHeld(agent, staged, 'play')
    if (!releasedChildren) this.releaseChildren(agent)
    if (run !== undefined) resumeRunActive(run)
    this.clear(agent, 'resumed')
    return { ok: true, text: 'Session resumed.' }
  }

  /**
   * Put every held wake into the resume batch before the waking steer, so one
   * model call sees the notices and the resume instruction together.
   */
  private stageHeld(agent: Agent): { readonly pending: PendingWakes; readonly appended: UserMessage['id'][] } {
    const pending = this.wake.pending(agent)
    const appended: UserMessage['id'][] = []
    if (pending.messages.length > 0) {
      try {
        for (const message of pending.messages) {
          agent.inbox.append('next-step', message)
          appended.push(message.id)
        }
      } catch (error: unknown) {
        this.unstageHeld(agent, { appended })
        throw error
      }
    }
    return { pending, appended }
  }

  /** Withdraw staged wakes after a failed resume, leaving them held for Play. */
  private unstageHeld(
    agent: Agent,
    staged: { readonly appended: readonly UserMessage['id'][] },
  ): void {
    for (const id of staged.appended) agent.inbox.remove(id)
  }

  /** Mark staged wakes released only after the resume steer succeeded. */
  private finishHeld(
    agent: Agent,
    staged: { readonly pending: PendingWakes },
    reason: WakeReleaseReason,
  ): void {
    this.wake.markReleased(agent, staged.pending.holds, reason)
    void this.wake.flush(agent)
  }

  /** Mark an explicit off/unload so turn-stopping does not record a pause. */
  requestCancel(agent: Agent): void {
    this.explicitCancel.add(sessionKey(agent))
    this.clear(agent, 'cleared')
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    void this.coordinator?.release(agent, 'cancel').catch((error: unknown) => {
      console.error('[dsh-ultracode] cancelling the child pause failed:', error)
    })
  }

  /** Consume the explicit-cancel flag for one turn. */
  consumeCancel(agent: Agent): boolean {
    return this.explicitCancel.delete(sessionKey(agent))
  }

  /** Record an error as a resumable pause. */
  onError(agent: Agent, turn: number): void {
    if (!isRootAgent(agent)) return
    if (this.paused.has(sessionKey(agent))) return
    this.markPaused(agent, 'error', turn)
    const run = this.runs.get(sessionKey(agent))
    if (run !== undefined && (run.phase === 'running' || run.phase === 'waiting_job')) {
      markRunWaiting(run)
      run.phase = 'paused_user'
      run.reason = 'turn error'
      appendRunEvent(agent, run)
    }
  }

  /**
   * Apply the turn-stopping pause/clear rules. Returns whether the turn is
   * paused; the caller decides whether a run question or cap owns the turn.
   */
  onTurnStopping(agent: Agent, turn: number, signal: AbortSignal): 'paused' | 'cancelled' | 'none' {
    if (!isRootAgent(agent)) return 'none'
    const key = sessionKey(agent)
    if (this.explicitCancel.delete(key)) return 'cancelled'
    if (signal.aborted) {
      if (!this.paused.has(key)) this.markPaused(agent, 'user', turn)
      const run = this.runs.get(key)
      if (run !== undefined && (run.phase === 'running' || run.phase === 'waiting_job')) {
        markRunWaiting(run)
        run.phase = 'paused_user'
        run.reason = 'turn interrupted'
        appendRunEvent(agent, run)
      }
      return 'paused'
    }
    if (this.paused.has(key)) {
      // A paused session never clears itself: an unrelated wake (job notice,
      // child settlement) must not restart work. Play or a human message owns
      // the transition; ticket 08 adds the wake hold.
      return 'paused'
    }
    return 'none'
  }

  /** Clear the pause when the model reports completion or a blocker. */
  complete(agent: Agent): void {
    this.clear(agent, 'completed')
  }

  /** Drop in-memory state when the agent is disposed. */
  dispose(agent: Agent): void {
    const key = sessionKey(agent)
    this.paused.delete(key)
    this.explicitCancel.delete(key)
    this.restoredWarnings.delete(key)
    this.coordinator?.abortChild(key)
    this.coordinator?.disposeRoot(key)
  }

  /** Whether the session is currently paused. */
  isPaused(agent: Agent): boolean {
    return this.paused.has(sessionKey(agent))
  }

  /** The current paused reason, for status text. */
  reasonOf(agent: Agent): string | undefined {
    return this.paused.get(sessionKey(agent))?.reason
  }

  /** Release parked children without blocking the command result. */
  private releaseChildren(agent: Agent): void {
    void this.coordinator?.release(agent, 'resume').catch((error: unknown) => {
      console.error('[dsh-ultracode] resuming paused children failed:', error)
    })
  }

  private markPaused(agent: Agent, reason: PauseReason, turn: number): void {
    const atSeq = lastSeq(agent)
    this.paused.set(sessionKey(agent), { reason, turn, atSeq })
    appendPauseEvent(agent, {
      paused: true,
      reason,
      turn,
      atSeq,
      updatedAt: Date.now(),
    })
  }

  private clear(agent: Agent, reason: ClearReason): void {
    if (!this.paused.delete(sessionKey(agent))) return
    appendPauseEvent(agent, {
      paused: false,
      reason,
      turn: openTurn(agent) || latestTurnEnd(agent.session.snapshotEvents())?.turn || 0,
      atSeq: lastSeq(agent),
      updatedAt: Date.now(),
    })
  }
}

/**
 * Jobs live only in the process registry. A pause restored from a persisted
 * log therefore cannot resume its recorded jobs; say so rather than letting
 * the user believe Play brought them back.
 */
function jobRestartWarning(manifest: PauseManifestEvent | undefined): string | undefined {
  if (manifest === undefined) return undefined
  const lost = manifest.jobs.filter(job => job.status === 'running' || job.status === 'stopping')
  if (lost.length === 0) return undefined
  const subject = lost.length === 1 ? '1 background job' : `${lost.length} background jobs`
  const object = lost.length === 1 ? 'it' : 'them'
  return `${subject} did not survive the process restart; restart ${object} from the saved plan or checkpoint.`
}
