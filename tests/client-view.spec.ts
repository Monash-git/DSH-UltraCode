import { describe, expect, it } from 'vitest'
import { controlView } from '../src/client/view.js'

describe('composer play/pause view-model', () => {
  it('shows pause while the agent is running', () => {
    expect(controlView({ running: true, ultra: undefined })).toBe('pause')
  })

  it('shows pause while an autopilot run is active', () => {
    expect(controlView({ running: false, ultra: { run: { phase: 'running' } } })).toBe('pause')
    expect(controlView({ running: false, ultra: { run: { phase: 'armed' } } })).toBe('pause')
  })

  it('shows play while paused', () => {
    expect(controlView({ running: false, ultra: { paused: true } })).toBe('play')
    expect(controlView({ running: false, ultra: { paused: true, run: { phase: 'paused_user' } } })).toBe('play')
  })

  it('hides when idle, waiting for a question, or terminal', () => {
    expect(controlView({ running: false, ultra: undefined })).toBe('hidden')
    expect(controlView({ running: false, ultra: { run: { phase: 'waiting_user' } } })).toBe('hidden')
    expect(controlView({ running: false, ultra: { run: { phase: 'completed' } } })).toBe('hidden')
    expect(controlView({ running: false, ultra: { run: { phase: 'cancelled' } } })).toBe('hidden')
  })
})
