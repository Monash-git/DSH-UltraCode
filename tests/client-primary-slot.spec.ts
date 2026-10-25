import { describe, expect, it, vi } from 'vitest'
import { applyClient, executeHostCommand, NS } from '../src/client/adapter.js'

interface CommandReply {
  readonly ok: boolean
  readonly value?: { readonly result: { readonly kind: string; readonly text?: string } }
  readonly error?: { readonly message?: string }
}

/** Fake client host exposing the slot registry and the Host command transport. */
function bench() {
  const execute = vi.fn<(sessionId: string, line: string, attachments?: readonly unknown[]) => Promise<CommandReply>>()
  execute.mockResolvedValue({ ok: true, value: { result: { kind: 'success', text: 'ok' } } })
  const register = vi.fn((spec: Record<string, unknown>, component: unknown) => ({ spec, component }))
  const inject = vi.fn((name: string, callback: () => unknown) => callback())
  const localeRegister = vi.fn()
  const effect = vi.fn((callback: () => unknown) => callback())
  const ctx = {
    slots: { inject, register },
    remote: { commands: { execute } },
    locale: { register: localeRegister },
    effect,
  }
  return { ctx, execute, register, inject, localeRegister }
}

describe('primary composer slot adapter', () => {
  it('registers only conversation.input.primary, never the activity seat', () => {
    const { ctx, inject, register } = bench()
    const component = (): null => null
    applyClient(ctx as never, component)

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls.map(call => call[0])).toEqual(['conversation.input.primary'])
    expect(register).toHaveBeenCalledTimes(1)
    const [spec, registered] = register.mock.calls[0]!
    expect(spec).toMatchObject({
      name: 'conversation.input.primary',
      locale: NS,
    })
    expect(spec.name).not.toBe('conversation.input.activity')
    expect(registered).toBe(component)
  })

  it('registers the ultracode locale dictionary', () => {
    const { ctx, localeRegister } = bench()
    applyClient(ctx as never, () => null)
    expect(localeRegister).toHaveBeenCalledWith(NS, expect.objectContaining({
      en: expect.objectContaining({ pause: 'Pause', resume: 'Resume', pausing: 'Pausing…' }),
      zh: expect.objectContaining({ pause: '暂停', resume: '继续' }),
    }))
  })

  it('injects a command executor bound to the addressed session', async () => {
    const { ctx, execute, register } = bench()
    applyClient(ctx as never, () => null)
    const spec = register.mock.calls[0]![0] as {
      inject: (sessionId: string) => { executeCommand: (line: string) => Promise<void> }
    }
    const injected = spec.inject('session-1')

    await injected.executeCommand('/pause')
    expect(execute).toHaveBeenLastCalledWith('session-1', '/pause', [])
    await injected.executeCommand('/resume')
    expect(execute).toHaveBeenLastCalledWith('session-1', '/resume', [])
  })

  it('surfaces a transport failure from the Host command', async () => {
    const execute = vi.fn(async (): Promise<CommandReply> => ({
      ok: false,
      error: { message: 'remote offline' },
    }))
    await expect(executeHostCommand({ execute }, 'session-1', '/pause')).rejects.toThrow('remote offline')
  })

  it('surfaces an error result from the Host command', async () => {
    const execute = vi.fn(async (): Promise<CommandReply> => ({
      ok: true,
      value: { result: { kind: 'error', text: 'No paused session to resume.' } },
    }))
    await expect(executeHostCommand({ execute }, 'session-1', '/resume'))
      .rejects.toThrow('No paused session to resume.')
  })
})
