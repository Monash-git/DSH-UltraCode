/** Pure view-model for the primary Send/Pause/Play composer action. */

import type { MouseEvent } from 'react'
import en from '../../locale/en.json' with { type: 'json' }

export interface UltraView {
  readonly paused?: boolean
  readonly reason?: string | null
  readonly pauseStatus?: {
    readonly phase?: string
    readonly acknowledged?: number
    readonly total?: number
    readonly forced?: number
    readonly warning?: string
  } | null
  readonly run?: { readonly phase?: string } | null
}

/** Owner-props share published by the `conversation.input.primary` seat. */
export interface PrimaryOwnerState {
  /** The draft has neither text nor attachments. */
  readonly empty: boolean
  /** The addressed agent is running. */
  readonly running: boolean
  /** The session is a subagent; pause/play is root-only. */
  readonly subagent: boolean
  /** The composer refuses interaction (removed, inert, owner-blocked, offline child). */
  readonly locked: boolean
  /** The input machine is adjudicating or submitting. */
  readonly machineBusy: boolean
  /** A picked file draft is still uploading or failed to upload. */
  readonly uploadsPending: boolean
  /** The default primary action is a clickable Stop right now. */
  readonly stopLive: boolean
}

/** Root pause progress folded from the durable manifest. */
export interface PauseProgress {
  readonly phase?: string
  readonly acknowledged?: number
  readonly total?: number
  readonly forced?: number
  readonly warning?: string
}

/** Everything the primary action needs: owner props plus projections and command state. */
export interface PrimaryState extends PrimaryOwnerState {
  readonly paused: boolean
  readonly phase: string | undefined
  /** A pause/resume command is in flight. */
  readonly pending: boolean
  /** Pausing/paused child acknowledgment progress, when the Host records one. */
  readonly pause?: PauseProgress
}

export type PrimaryKind = 'default' | 'pause' | 'play'

export type PrimaryLabelKey = 'pause' | 'pausing' | 'resume'

export interface PrimaryView {
  readonly kind: PrimaryKind
  readonly disabled: boolean
  /** The run is idle only because an owned background job is live. */
  readonly waitingOnJob: boolean
  readonly label: PrimaryLabelKey | undefined
  /** Pausing progress or forced-stop facts for the label. */
  readonly progress?: PauseProgress
}

const DEFAULT_VIEW: PrimaryView = Object.freeze({
  kind: 'default',
  disabled: false,
  waitingOnJob: false,
  label: undefined,
})

/** Autopilot run phases that still have a live run to pause between turns. */
const ACTIVE_RUN_PHASES = new Set(['armed', 'running', 'waiting_job'])

/**
 * Map the composer state to the primary action.
 *
 * The plugin takes over only for a root session with an empty draft while it
 * is running, waiting on a job, or paused. Text always keeps the shipped
 * Send/Steer action, which is also what cancels a pause by starting a new
 * direction. Subagents, locked composers, and transient input-machine states
 * render the default action unchanged.
 */
export function primaryView(state: PrimaryState): PrimaryView {
  if (state.subagent || state.locked) return DEFAULT_VIEW
  if (!state.empty || state.machineBusy || state.uploadsPending) return DEFAULT_VIEW
  const progress = state.pause
  if (state.paused) {
    if (progress?.phase === 'pausing') {
      return { kind: 'pause', disabled: true, waitingOnJob: false, label: 'pausing', progress }
    }
    return {
      kind: 'play',
      disabled: state.pending || progress?.phase === 'resuming',
      waitingOnJob: false,
      label: 'resume',
      ...progress === undefined ? {} : { progress },
    }
  }
  const activePhase = state.phase !== undefined && ACTIVE_RUN_PHASES.has(state.phase)
  if (!state.running && !activePhase) return DEFAULT_VIEW
  const pausing = state.pending || progress?.phase === 'pausing'
  return {
    kind: 'pause',
    // A running session without a live Stop cannot service a pause either.
    // Waiting-on-job Pause does not depend on the default Stop.
    disabled: pausing || (state.running && !state.stopLive),
    waitingOnJob: state.phase === 'waiting_job',
    label: pausing ? 'pausing' : 'pause',
    ...progress === undefined ? {} : { progress },
  }
}

/** Localized label, tooltip, and visible status for one applied primary view. */
export interface PrimaryText {
  readonly label?: string
  readonly title?: string
  readonly status?: string
}

const FALLBACK_LABEL: Readonly<Record<PrimaryLabelKey, string>> = {
  pause: en.pause,
  pausing: en.pausing,
  resume: en.resume,
}

/** Resolve a primary view to its accessible label/tooltip. */
export function primaryText(view: PrimaryView, t?: (key: string) => string): PrimaryText {
  if (view.label === undefined) return {}
  const lookup = (key: keyof typeof en): string => t?.(key) ?? en[key]
  let label = t?.(view.label) ?? FALLBACK_LABEL[view.label]
  if (view.label === 'pausing' && view.progress !== undefined && (view.progress.total ?? 0) > 0) {
    label = format(lookup('pausingProgress'), {
      acknowledged: view.progress.acknowledged ?? 0,
      total: view.progress.total ?? 0,
    })
  }
  if (view.waitingOnJob) {
    const waiting = lookup('waitingJob')
    const title = `${label} — ${waiting}`
    return { label: title, title, status: waiting }
  }
  if (view.kind === 'play' && (view.progress?.forced ?? 0) > 0) {
    const forced = format(lookup('pausedForced'), { forced: view.progress?.forced ?? 0 })
    const title = `${label} — ${forced}`
    return { label: title, title, status: forced }
  }
  return { label, title: label }
}

/** Substitute `{name}` placeholders in one localized template. */
function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''))
}

/** The host command that implements one owned primary action. */
export function primaryCommand(kind: PrimaryKind): '/pause' | '/resume' | undefined {
  if (kind === 'pause') return '/pause'
  if (kind === 'play') return '/resume'
  return undefined
}

/** Handlers the registered component supplies to its custom button. */
export interface PrimaryHandlers {
  readonly keepFocus: (event: MouseEvent<HTMLButtonElement>) => void
  readonly activate: () => void
}

/** Props shared by the custom Pause/Play button and its tests. */
export interface PrimaryButtonProps {
  readonly type: 'button'
  readonly 'aria-label': string
  readonly 'aria-busy'?: true
  readonly title: string
  readonly disabled: boolean
  readonly onMouseDown: (event: MouseEvent<HTMLButtonElement>) => void
  readonly onClick: () => void
}

/** Build the custom button's props, preserving the editor focus via `keepFocus`. */
export function primaryButtonProps(
  view: PrimaryView,
  text: PrimaryText,
  handlers: PrimaryHandlers,
  pending: boolean,
): PrimaryButtonProps {
  return {
    type: 'button',
    'aria-label': text.label ?? '',
    ...(pending ? { 'aria-busy': true as const } : {}),
    title: text.title ?? '',
    disabled: view.disabled,
    onMouseDown: handlers.keepFocus,
    onClick: handlers.activate,
  }
}
