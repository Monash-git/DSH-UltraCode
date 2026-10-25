/**
 * Host-side park gate for local subagents.
 *
 * The root pause coordinator sends one host-authored control message into a
 * running child's inbox. At the child's next `agent/pre-step` boundary the
 * gate consumes that message (it never reaches the model), flushes the child
 * session, records a durable checkpoint, acknowledges the root, and awaits a
 * release promise. The child stays `running` with its turn open, so its
 * context, tools, and (for workflow children) the pending workflow result are
 * preserved without a new model request.
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Stable text for the hidden control message; never model-visible. */
export const PAUSE_CONTROL_TEXT = 'Ultra host pause: checkpoint and park until the root session resumes.'

/** One deterministic pause acknowledgment produced at a child pre-step. */
export interface ParkAcknowledgement {
  readonly pauseId: string
  readonly checkpointAt: number
  readonly checkpointSeq: number
  /** Artifact paths the checkpoint captured, when the session presented any. */
  readonly artifacts?: readonly string[]
}

/** Build the host-only control message that wakes a child toward its park point. */
export function pauseControlMessage(pauseId: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: PAUSE_CONTROL_TEXT }],
    source: { kind: 'ultracode', form: 'pause', pauseId },
  })
}

/** Whether a claimed message is the host pause control rather than model input. */
export function isPauseControlMessage(message: UserMessage): boolean {
  const source = message.source
  return source.kind === 'ultracode' && source.form === 'pause'
}

/** Build the model-visible message that resumes a child after a forced stop. */
export function pauseResumeMessage(): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'The root session resumed. Continue your task from where it stopped. '
        + 'If your previous turn was interrupted, inspect your checkpoint and artifacts, then continue.',
    }],
    source: { kind: 'ultracode', form: 'notice', summary: 'root session resumed' },
  })
}

/** One waiting child: an acknowledgment and a release latch. */
export interface ParkEntry {
  readonly pauseId: string
  /** Resolves once the child reaches and flushes its park point. */
  readonly acknowledged: Promise<ParkAcknowledgement>
  /** Resolves when the root releases the child. */
  readonly released: Promise<'resume' | 'abort'>
  /** Record the checkpoint as the child's acknowledgment (first one wins). */
  acknowledge(value: ParkAcknowledgement): void
  /** Release a parked child, or cancel an unclaimed park request. */
  release(kind: 'resume' | 'abort'): void
  /** Wait for release; rejects when the turn signal aborts first. */
  wait(signal: AbortSignal): Promise<'resume'>
}

class ParkEntryImpl implements ParkEntry {
  private acknowledgedValue: ParkAcknowledgement | undefined
  private acknowledgedResolve!: (value: ParkAcknowledgement) => void
  private releasedValue: 'resume' | 'abort' | undefined
  private releasedResolve!: (value: 'resume' | 'abort') => void

  readonly acknowledged = new Promise<ParkAcknowledgement>(resolve => {
    this.acknowledgedResolve = resolve
  })

  readonly released = new Promise<'resume' | 'abort'>(resolve => {
    this.releasedResolve = resolve
  })

  constructor(readonly pauseId: string) {}

  acknowledge(value: ParkAcknowledgement): void {
    if (this.acknowledgedValue !== undefined) return
    this.acknowledgedValue = value
    this.acknowledgedResolve(value)
  }

  release(kind: 'resume' | 'abort'): void {
    if (this.releasedValue !== undefined) return
    this.releasedValue = kind
    this.releasedResolve(kind)
  }

  async wait(signal: AbortSignal): Promise<'resume'> {
    if (signal.aborted) throw signal.reason ?? new Error('pause aborted')
    let removeAbort = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new Error('pause aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', onAbort)
    })
    try {
      const kind = await Promise.race([this.released, aborted])
      if (kind === 'abort') throw signal.reason ?? new Error('pause aborted')
      return 'resume'
    } finally {
      removeAbort()
    }
  }
}

/** Per-child park entries keyed by durable child session id. */
export class ParkGate {
  private readonly entries = new Map<string, ParkEntryImpl>()

  /** Register a park request for one child, reusing an existing same-pause entry. */
  request(childId: string, pauseId: string): ParkEntry {
    const existing = this.entries.get(childId)
    if (existing !== undefined && existing.pauseId === pauseId) return existing
    const entry = new ParkEntryImpl(pauseId)
    this.entries.set(childId, entry)
    return entry
  }

  /** The active request for one child, if any. */
  get(childId: string): ParkEntry | undefined {
    return this.entries.get(childId)
  }

  /** Release one child; returns whether a request existed. */
  release(childId: string, kind: 'resume' | 'abort' = 'resume'): boolean {
    const entry = this.entries.get(childId)
    if (entry === undefined) return false
    entry.release(kind)
    this.entries.delete(childId)
    return true
  }

  /** Drop one child's request without requiring it to have reached the gate. */
  forget(childId: string): void {
    this.entries.delete(childId)
  }

  /** Release and forget every request (plugin unload or root disposal). */
  dispose(kind: 'resume' | 'abort' = 'abort'): void {
    for (const entry of this.entries.values()) entry.release(kind)
    this.entries.clear()
  }
}
