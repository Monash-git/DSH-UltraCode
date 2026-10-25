/**
 * Durable pause/resume for every root session.
 *
 * A pause is a log-only `ultracode/pause` event plus, when a skill run is
 * active, a `paused_user`/`paused_resume` run phase. Resume is one appended
 * user message; nothing rewrites history.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { continuationNudge, genericResumeNudge } from './prompts.js'
import {
  appendPauseEvent,
  appendRunEvent,
  hasHumanMessageAfter,
  isRootAgent,
  isUnfinishedPhase,
  lastSeq,
  latestTurnEnd,
  openTurn,
  sessionKey,
  todoSummary,
  type RunState,
} from './state.js'
import type { ClearReason, PauseReason } from './types.js'

export interface PauseOutcome {
  readonly ok: boolean
  readonly text: string
}

const RESUMABLE_TURN_END = new Set(['aborted', 'interrupted', 'error', 'max-tokens'])

/** Owns the per-session pause state and the resume commands. */
export class PauseController {
  private readonly paused = new Map<string, { reason: PauseReason | ClearReason; turn: number; atSeq: number }>()
  private readonly explicitCancel = new Set<string>()

  constructor(
    private readonly config: ResolvedConfig,
    private readonly runs: Map<string, RunState>,
  ) {}

  /** Load durable state and promote a crash-interrupted turn to paused. */
  onCreated(agent: Agent): void {
    if (!isRootAgent(agent)) return
    const key = sessionKey(agent)
    const events = agent.session.snapshotEvents()
    let latestPause: { paused: boolean; reason: PauseReason | ClearReason; turn: number; atSeq: number } | undefined
    let pauseSeq = -1
    for (const event of events) {
      if (event.type === 'ultracode/pause') {
        latestPause = event.data
        pauseSeq = event.seq
      }
    }
    if (latestPause?.paused === true) {
      this.paused.set(key, {
        reason: latestPause.reason,
        turn: latestPause.turn,
        atSeq: latestPause.atSeq,
      })
    } else {
      this.paused.delete(key)
    }

    const run = this.runs.get(key)
    if (run !== undefined && isUnfinishedPhase(run.phase)) {
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

  /** Clear a paused state when the user starts a new direction. */
  onPreStep(agent: Agent, messages: readonly UserMessage[]): boolean {
    if (!isRootAgent(agent) || !this.paused.has(sessionKey(agent))) return false
    if (!messages.some(message => message.source.kind === 'user')) return false
    this.clear(agent, 'cleared')
    const run = this.runs.get(sessionKey(agent))
    if (run !== undefined && (run.phase === 'paused_user' || run.phase === 'paused_resume')) {
      run.phase = 'cancelled'
      run.reason = 'user continued with a new message'
      appendRunEvent(agent, run)
    }
    return true
  }

  /** Pause immediately; cancel the active turn when there is one. */
  pause(agent: Agent): PauseOutcome {
    if (!isRootAgent(agent)) return { ok: false, text: 'Pause is only available to the root session.' }
    const key = sessionKey(agent)
    if (this.paused.has(key)) return { ok: true, text: 'Session is already paused.' }
    const turn = openTurn(agent) || latestTurnEnd(agent.session.snapshotEvents())?.turn || 0
    this.markPaused(agent, 'user', turn)
    const run = this.runs.get(key)
    if (run !== undefined && (run.phase === 'running' || run.phase === 'armed')) {
      run.phase = 'paused_user'
      run.reason = 'paused by user'
      appendRunEvent(agent, run)
    }
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    return { ok: true, text: 'Session paused.' }
  }

  /** Resume a paused autopilot run or a generic interrupted turn. */
  resume(agent: Agent): PauseOutcome {
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
      run.round += 1
      run.phase = 'running'
      run.reason = 'resumed by user'
      appendRunEvent(agent, run)
      this.clear(agent, 'resumed')
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: continuationNudge(run.skill, run.round, run.maxRounds, todoSummary(agent), 'resumed by user'),
        }],
        source: { kind: 'autopilot' },
      }))
      return { ok: true, text: `Autopilot resumed for ${run.skill}.` }
    }
    if (!this.paused.has(key)) {
      return { ok: false, text: 'No paused session to resume.' }
    }
    this.clear(agent, 'resumed')
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: genericResumeNudge(todoSummary(agent)) }],
      source: { kind: 'ultracode' },
    }))
    return { ok: true, text: 'Session resumed.' }
  }

  /** Mark an explicit off/unload so turn-stopping does not record a pause. */
  requestCancel(agent: Agent): void {
    this.explicitCancel.add(sessionKey(agent))
    this.clear(agent, 'cleared')
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
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
    if (run !== undefined && run.phase === 'running') {
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
      if (run !== undefined && run.phase === 'running') {
        run.phase = 'paused_user'
        run.reason = 'turn interrupted'
        appendRunEvent(agent, run)
      }
      return 'paused'
    }
    if (this.paused.has(key)) {
      this.clear(agent, 'completed')
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
  }

  /** Whether the session is currently paused. */
  isPaused(agent: Agent): boolean {
    return this.paused.has(sessionKey(agent))
  }

  /** The current paused reason, for status text. */
  reasonOf(agent: Agent): string | undefined {
    return this.paused.get(sessionKey(agent))?.reason
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
