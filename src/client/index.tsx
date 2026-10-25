/**
 * Primary composer action: turn the main Send/Stop button into Pause/Play for
 * a running, waiting, or paused root session with an empty draft.
 *
 * DSH's optional `conversation.input.primary` single slot shares the shipped
 * default action and the composer state. This occupant renders that default
 * action unchanged everywhere it does not own the state, so Send/Stop/Steer,
 * uploads, and focus behavior stay exactly as shipped. Pause and Play are the
 * existing Host `/pause` and `/resume` commands; there is no second pause
 * button in the activity seat.
 */

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { applyClient, type PrimarySlotContext } from './adapter.js'
import {
  primaryButtonProps,
  primaryCommand,
  primaryText,
  primaryView,
  type PrimaryOwnerState,
  type PrimaryText,
  type UltraView,
} from './view.js'

type ProjectionHook = <T>(key: string, selector: (value: unknown) => T) => T | undefined

interface PrimaryActionProps extends PrimaryOwnerState {
  /** The shipped primary action, rendered unchanged when the plugin declines. */
  readonly defaultAction?: ReactNode
  /** DSH's editor-focus guard; must be attached to the custom button's mousedown. */
  readonly keepFocus?: (event: MouseEvent<HTMLButtonElement>) => void
  /** Session standard prop: the Host-computed `ultracode` projection. */
  readonly useProjection?: ProjectionHook
  /** Localized `ultracode` namespace lookup. */
  readonly t?: (key: string) => string
  /** Command executor injected by the adapter; bound to this session. */
  readonly executeCommand?: (line: string) => Promise<void>
}

/** Used when the slot is rendered without a projection seat. */
function noProjection<T>(_key: string, _selector: (value: unknown) => T): T | undefined {
  return undefined
}

function PauseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3.5" y="3" width="3.5" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3.5" height="10" rx="1" fill="currentColor" />
    </svg>
  )
}

function PlayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4.5 3.3c0-.8.9-1.3 1.6-.9l7 4.7c.6.4.6 1.4 0 1.8l-7 4.7c-.7.4-1.6-.1-1.6-.9V3.3Z" fill="currentColor" />
    </svg>
  )
}

/** Matches the shipped 34px primary circle (DSH `InputBar.module.css`). */
function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
    width: 34,
    height: 34,
    border: 'none',
    borderRadius: 999,
    background: 'var(--dsw-alias-button-info-fill)',
    color: '#fff',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    transform: 'translateY(-2px)',
    transition: 'background-color 100ms ease',
  }
}

function PrimaryAction(props: PrimaryActionProps): ReactNode {
  const {
    defaultAction = null,
    empty = false,
    running = false,
    subagent = false,
    locked = false,
    machineBusy = false,
    uploadsPending = false,
    stopLive = false,
    keepFocus = () => {},
    useProjection = noProjection,
    t,
    executeCommand = async () => {},
  } = props
  const projection = useProjection('ultracode', value => value as UltraView | undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const view = primaryView({
    empty,
    running,
    subagent,
    locked,
    machineBusy,
    uploadsPending,
    stopLive,
    paused: projection?.paused === true,
    phase: projection?.run?.phase,
    pending,
  })

  // Declining returns the exact shipped node, so Send/Stop/Steer and the
  // disabled/aria states stay the bar's own.
  if (view.kind === 'default') return defaultAction

  const text: PrimaryText = primaryText(view, t)
  const activate = (): void => {
    if (view.disabled) return
    const command = primaryCommand(view.kind)
    if (command === undefined) return
    setPending(true)
    setError(undefined)
    void executeCommand(command)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setPending(false) })
  }
  const button = primaryButtonProps(view, text, { keepFocus, activate }, pending)

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button {...button} style={primaryButtonStyle(view.disabled)}>
        {view.kind === 'play' ? <PlayIcon /> : <PauseIcon />}
      </button>
      {text.status === undefined ? null : (
        <span role="status" style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
          {text.status}
        </span>
      )}
      {error === undefined ? null : (
        <span role="status" style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>
          {error}
        </span>
      )}
    </span>
  )
}

/** Client plugin entry: register the primary-slot occupant and its locale. */
export function apply(ctx: PrimarySlotContext): void {
  applyClient(ctx, PrimaryAction)
}

const inject = ['slots', 'remote', 'remote.commands', 'locale']

export { inject }
