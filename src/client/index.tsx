/**
 * Composer activity control: pause a running root session and resume a paused
 * one without typing. This is a client plugin over the Host `/pause` and
 * `/resume` commands; it never replaces the Send/Stop button.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }
import { controlView, EMPTY, type Snapshot, type UltraView } from './view.js'

interface ProjectionStore<T> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

interface BindingLike {
  session: {
    getSnapshot(): { running?: boolean }
    subscribe?(listener: () => void): () => void
    projections?: {
      faceOf(key: string): ProjectionStore<unknown> | undefined
    }
  }
}

interface CommandsRemote {
  execute(
    sessionId: string,
    line: string,
    attachments?: readonly unknown[],
  ): Promise<{
    ok: boolean
    value?: { result: { kind: string; text?: string } }
    error?: { message?: string }
  }>
}

interface ClientContext {
  sessions: {
    binding(sessionId: string): BindingLike | undefined
    subagentAddress?(sessionId: string): unknown
  }
  remote: { commands: CommandsRemote }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
  }
  effect(callback: () => unknown): unknown
}

const NS = 'ultracode'

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

function createStore(ctx: ClientContext, sessionId: string): {
  getSnapshot: () => Snapshot
  subscribe: (listener: () => void) => () => void
  isSubagent: boolean
} {
  const binding = ctx.sessions.binding(sessionId)
  const isSubagent = typeof ctx.sessions.subagentAddress === 'function'
    && ctx.sessions.subagentAddress(sessionId) !== undefined
  if (binding === undefined || isSubagent) {
    return { getSnapshot: () => EMPTY, subscribe: NOOP_SUBSCRIBE, isSubagent }
  }
  const projection = binding.session.projections?.faceOf('ultracode') as ProjectionStore<UltraView> | undefined
  const compute = (): Snapshot => ({
    running: binding.session.getSnapshot().running === true,
    ultra: projection?.getSnapshot(),
  })
  // useSyncExternalStore requires an identity-stable snapshot between store
  // notifications; constructing a fresh object on every read causes React's
  // maximum-update-depth loop.
  let cached = compute()
  const getSnapshot = (): Snapshot => cached
  const update = (listener: () => void): void => {
    const next = compute()
    if (next.running === cached.running && next.ultra === cached.ultra) return
    cached = next
    listener()
  }
  const subscribe = (listener: () => void): (() => void) => {
    const disposers: Array<() => void> = []
    const offSession = binding.session.subscribe?.(() => update(listener))
    if (offSession !== undefined) disposers.push(offSession)
    const offProjection = projection?.subscribe?.(() => update(listener))
    if (offProjection !== undefined) disposers.push(offProjection)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
  return { getSnapshot, subscribe, isSubagent }
}

interface ControlProps {
  readonly locked?: boolean
  readonly onActiveChange?: (active: boolean) => void
  readonly t?: (key: string) => string
  readonly getSnapshot?: () => Snapshot
  readonly subscribe?: (listener: () => void) => () => void
  readonly isSubagent?: boolean
  readonly executeCommand?: (line: string) => Promise<void>
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

function Control(props: ControlProps): JSX.Element | null {
  const {
    locked = false,
    onActiveChange,
    t,
    getSnapshot = () => EMPTY,
    subscribe = NOOP_SUBSCRIBE,
    isSubagent = false,
    executeCommand = async () => {},
  } = props
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    onActiveChange?.(false)
    return () => onActiveChange?.(false)
  }, [onActiveChange])

  if (isSubagent) return null
  const view = controlView(snapshot)
  if (view === 'hidden') return null

  const label = view === 'play'
    ? (t?.('resume') ?? en.resume)
    : (t?.('pause') ?? en.pause)
  const disabled = locked || pending

  const onClick = async (): Promise<void> => {
    if (disabled) return
    setPending(true)
    setError(undefined)
    try {
      await executeCommand(view === 'play' ? '/resume' : '/pause')
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => { void onClick() }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 0,
          borderRadius: '50%',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {view === 'play' ? <PlayIcon /> : <PauseIcon />}
      </button>
      {error === undefined ? null : (
        <span role="status" style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>
          {error}
        </span>
      )}
    </span>
  )
}

function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity',
    locale: NS,
    inject: (sessionId: string) => {
      const store = createStore(ctx, sessionId)
      const executeCommand = async (line: string): Promise<void> => {
        const result = await ctx.remote.commands.execute(sessionId, line, [])
        if (!result.ok) throw new Error(result.error?.message ?? 'command failed')
        if (result.value?.result.kind === 'error') {
          throw new Error(result.value.result.text ?? 'command failed')
        }
      }
      return {
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        isSubagent: store.isSubagent,
        executeCommand,
      }
    },
  }, Control))
}

const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

export { apply, inject }
