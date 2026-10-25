import { describe, expect, it, vi } from 'vitest'
import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }
import {
  primaryButtonProps,
  primaryCommand,
  primaryText,
  primaryView,
  type PrimaryState,
} from '../src/client/view.js'

const translate = (dictionary: Record<string, string>) => (key: string): string => dictionary[key] ?? key

/** One fake owner-props share, matching the DSH primary-slot owner contract. */
function owner(over: Partial<PrimaryState> = {}): PrimaryState {
  return {
    empty: true,
    running: false,
    subagent: false,
    locked: false,
    machineBusy: false,
    uploadsPending: false,
    stopLive: false,
    paused: false,
    phase: undefined,
    pending: false,
    pause: undefined,
    ...over,
  }
}

describe('primary composer action view-model', () => {
  it('leaves the default Send action in place when idle with an empty draft', () => {
    expect(primaryView(owner()).kind).toBe('default')
  })

  it('leaves the default Send action in place when idle with text', () => {
    expect(primaryView(owner({ empty: false })).kind).toBe('default')
  })

  it('shows Pause for a running root session with an empty draft', () => {
    expect(primaryView(owner({ running: true, stopLive: true }))).toMatchObject({
      kind: 'pause',
      disabled: false,
      label: 'pause',
      waitingOnJob: false,
    })
  })

  it('leaves Send/Steer in place when running with text', () => {
    expect(primaryView(owner({ running: true, stopLive: true, empty: false })).kind).toBe('default')
  })

  it('shows Pause while an autopilot run waits on an owned background job', () => {
    expect(primaryView(owner({ phase: 'waiting_job' }))).toMatchObject({
      kind: 'pause',
      disabled: false,
      label: 'pause',
      waitingOnJob: true,
    })
  })

  it('leaves Send/Steer in place while waiting on a job with text', () => {
    expect(primaryView(owner({ phase: 'waiting_job', empty: false })).kind).toBe('default')
  })

  it('keeps Pause available between turns of an active autopilot run', () => {
    expect(primaryView(owner({ phase: 'running' })).kind).toBe('pause')
    expect(primaryView(owner({ phase: 'armed' })).kind).toBe('pause')
  })

  it('shows Play while the session is paused', () => {
    expect(primaryView(owner({ paused: true }))).toMatchObject({
      kind: 'play',
      disabled: false,
      label: 'resume',
    })
  })

  it('lets the paused projection win over a stale running flag', () => {
    expect(primaryView(owner({ paused: true, running: true, stopLive: true })).kind).toBe('play')
  })

  it('leaves Send in place while paused with text so the new direction cancels the pause', () => {
    expect(primaryView(owner({ paused: true, empty: false })).kind).toBe('default')
  })

  it('renders the default action for subagents in every state', () => {
    expect(primaryView(owner({ subagent: true, running: true, stopLive: true })).kind).toBe('default')
    expect(primaryView(owner({ subagent: true, paused: true })).kind).toBe('default')
  })

  it('renders the default action for a locked composer in every state', () => {
    expect(primaryView(owner({ locked: true, running: true, stopLive: true })).kind).toBe('default')
    expect(primaryView(owner({ locked: true, paused: true })).kind).toBe('default')
  })

  it('renders the default action while the input machine is busy', () => {
    expect(primaryView(owner({ running: true, stopLive: true, machineBusy: true })).kind).toBe('default')
    expect(primaryView(owner({ paused: true, machineBusy: true })).kind).toBe('default')
  })

  it('renders the default action while uploads are pending', () => {
    expect(primaryView(owner({ running: true, stopLive: true, uploadsPending: true })).kind).toBe('default')
  })

  it('does not offer Pause for terminal or question-waiting run phases', () => {
    expect(primaryView(owner({ phase: 'waiting_user' })).kind).toBe('default')
    expect(primaryView(owner({ phase: 'completed' })).kind).toBe('default')
    expect(primaryView(owner({ phase: 'cancelled' })).kind).toBe('default')
    expect(primaryView(owner({ phase: 'exhausted' })).kind).toBe('default')
    expect(primaryView(owner({ phase: 'error' })).kind).toBe('default')
  })

  it('disables Pause while the pause command is in flight and labels it as progress', () => {
    expect(primaryView(owner({ running: true, stopLive: true, pending: true }))).toMatchObject({
      kind: 'pause',
      disabled: true,
      label: 'pausing',
    })
  })

  it('disables Play while the resume command is in flight', () => {
    expect(primaryView(owner({ paused: true, pending: true }))).toMatchObject({
      kind: 'play',
      disabled: true,
      label: 'resume',
    })
  })

  it('disables Pause when a running session has no live Stop', () => {
    expect(primaryView(owner({ running: true, stopLive: false })).disabled).toBe(true)
    expect(primaryView(owner({ running: true, stopLive: true })).disabled).toBe(false)
  })

  it('keeps waiting-on-job Pause enabled even though the default Stop is not live', () => {
    expect(primaryView(owner({ phase: 'waiting_job', stopLive: false }))).toMatchObject({
      kind: 'pause',
      disabled: false,
    })
  })
})

describe('primary composer action presentation', () => {
  it('localizes the Pause label and tooltip', () => {
    const view = primaryView(owner({ running: true, stopLive: true }))
    expect(primaryText(view, translate(en))).toEqual({ label: 'Pause', title: 'Pause' })
    expect(primaryText(view, translate(zh))).toEqual({ label: '暂停', title: '暂停' })
  })

  it('localizes the Play label and tooltip', () => {
    expect(primaryText(primaryView(owner({ paused: true })), translate(en))).toEqual({
      label: 'Resume',
      title: 'Resume',
    })
    expect(primaryText(primaryView(owner({ paused: true })), translate(zh))).toEqual({
      label: '继续',
      title: '继续',
    })
  })

  it('includes the localized waiting-on-job reason in the accessible label and status', () => {
    const view = primaryView(owner({ phase: 'waiting_job' }))
    expect(primaryText(view, translate(en))).toEqual({
      label: 'Pause — Waiting for background job',
      title: 'Pause — Waiting for background job',
      status: 'Waiting for background job',
    })
    expect(primaryText(view, translate(zh))).toEqual({
      label: '暂停 — 正在等待后台任务',
      title: '暂停 — 正在等待后台任务',
      status: '正在等待后台任务',
    })
  })

  it('announces pause progress while the command is in flight', () => {
    const view = primaryView(owner({ running: true, stopLive: true, pending: true }))
    expect(primaryText(view, translate(en))).toEqual({ label: 'Pausing…', title: 'Pausing…' })
  })

  it('shows acknowledged/total child progress while pausing', () => {
    const state = owner({
      paused: true,
      pause: { phase: 'pausing', acknowledged: 1, total: 3, forced: 0 },
    })
    const view = primaryView(state)
    expect(view).toMatchObject({ kind: 'pause', disabled: true, label: 'pausing' })
    expect(primaryText(view, translate(en))).toEqual({
      label: 'Pausing… (1/3 acknowledged)',
      title: 'Pausing… (1/3 acknowledged)',
    })
    expect(primaryText(view, translate(zh))).toEqual({
      label: '正在暂停…（1/3 已确认）',
      title: '正在暂停…（1/3 已确认）',
    })
  })

  it('keeps Play enabled after a forced child and labels the forced stop', () => {
    const state = owner({
      paused: true,
      pause: { phase: 'paused', acknowledged: 2, total: 3, forced: 1 },
    })
    const view = primaryView(state)
    expect(view).toMatchObject({ kind: 'play', disabled: false, label: 'resume' })
    expect(primaryText(view, translate(en))).toEqual({
      label: 'Resume — Paused — 1 stopped after timeout',
      title: 'Resume — Paused — 1 stopped after timeout',
      status: 'Paused — 1 stopped after timeout',
    })
    expect(primaryText(view, translate(zh))).toEqual({
      label: '继续 — 已暂停 — 1 个已超时强制停止',
      title: '继续 — 已暂停 — 1 个已超时强制停止',
      status: '已暂停 — 1 个已超时强制停止',
    })
  })

  it('warns that stopped background work restarts rather than resumes', () => {
    const warning = 'Background bash job job-1 (pnpm test) was stopped at pause and has no checkpoint; '
      + 'Play will restart it. This is a restart, not a resume.'
    const state = owner({
      paused: true,
      pause: { phase: 'paused', acknowledged: 0, total: 0, forced: 0, warning },
    })
    const view = primaryView(state)
    expect(view).toMatchObject({ kind: 'play', disabled: false, label: 'resume' })
    expect(primaryText(view, translate(en))).toEqual({
      label: `Resume — Restart required: ${warning}`,
      title: `Resume — Restart required: ${warning}`,
      status: `Restart required: ${warning}`,
    })
    expect(primaryText(view, translate(zh))).toEqual({
      label: `继续 — 需要重启：${warning}`,
      title: `继续 — 需要重启：${warning}`,
      status: `需要重启：${warning}`,
    })
  })

  it('combines a forced-stop fact with a restart warning on Play', () => {
    const state = owner({
      paused: true,
      pause: {
        phase: 'paused',
        acknowledged: 1,
        total: 1,
        forced: 2,
        warning: 'Workflow "audit" was stopped; restart its workflow.',
      },
    })
    expect(primaryText(primaryView(state), translate(en))).toEqual({
      label: 'Resume — Paused — 2 stopped after timeout Restart required: Workflow "audit" was stopped; restart its workflow.',
      title: 'Resume — Paused — 2 stopped after timeout Restart required: Workflow "audit" was stopped; restart its workflow.',
      status: 'Paused — 2 stopped after timeout Restart required: Workflow "audit" was stopped; restart its workflow.',
    })
  })

  it('disables Play while the resume command is releasing children', () => {
    expect(primaryView(owner({
      paused: true,
      pause: { phase: 'resuming', acknowledged: 3, total: 3, forced: 0 },
    }))).toMatchObject({ kind: 'play', disabled: true, label: 'resume' })
  })

  it('has no label for the default action', () => {
    expect(primaryText(primaryView(owner()), translate(en))).toEqual({})
  })

  it('maps each owned kind to its host command', () => {
    expect(primaryCommand('pause')).toBe('/pause')
    expect(primaryCommand('play')).toBe('/resume')
    expect(primaryCommand('default')).toBeUndefined()
  })

  it('attaches keepFocus and the click action to the custom button', () => {
    const keepFocus = vi.fn()
    const activate = vi.fn()
    const view = primaryView(owner({ running: true, stopLive: true }))
    const props = primaryButtonProps(view, primaryText(view, translate(en)), { keepFocus, activate }, false)
    expect(props).toMatchObject({
      type: 'button',
      'aria-label': 'Pause',
      title: 'Pause',
      disabled: false,
    })
    expect(props.onMouseDown).toBe(keepFocus)
    expect(props.onClick).toBe(activate)
    expect(props['aria-busy']).toBeUndefined()
  })

  it('marks the custom button busy and disabled while pausing', () => {
    const view = primaryView(owner({ running: true, stopLive: true, pending: true }))
    const props = primaryButtonProps(view, primaryText(view, translate(en)), {
      keepFocus: vi.fn(),
      activate: vi.fn(),
    }, true)
    expect(props).toMatchObject({
      'aria-busy': true,
      'aria-label': 'Pausing…',
      disabled: true,
    })
  })
})
