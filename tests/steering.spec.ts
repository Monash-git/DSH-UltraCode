import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { installBusyEnterDefault } from '../src/steering.js'

function fakeContext(row: unknown) {
  const update = vi.fn(async () => {})
  const settings = {
    describe: () => row === undefined ? [] : [row],
    update,
  }
  const ctx = {
    inject: (_names: string[], callback: (scoped: unknown) => void) => {
      const scoped = {
        settings,
        on: () => () => {},
      }
      callback(scoped)
      return Promise.resolve({ dispose: async () => {} })
    },
  } as unknown as Context
  return { ctx, update }
}

describe('busy-enter default', () => {
  it('writes steer when the user has no explicit choice', () => {
    const { ctx, update } = fakeContext({
      ns: 'ui-conversation',
      revision: 2,
      value: { busyEnter: 'queue' },
      user: {},
    })
    installBusyEnterDefault(ctx, resolveConfig())
    expect(update).toHaveBeenCalledWith('ui-conversation', { busyEnter: 'steer' }, 2)
  })

  it('preserves an explicit queue choice', () => {
    const { ctx, update } = fakeContext({
      ns: 'ui-conversation',
      revision: 2,
      value: { busyEnter: 'queue' },
      user: { busyEnter: 'queue' },
    })
    installBusyEnterDefault(ctx, resolveConfig())
    expect(update).not.toHaveBeenCalled()
  })

  it('does nothing in preserve mode', () => {
    const { ctx, update } = fakeContext({
      ns: 'ui-conversation',
      revision: 2,
      value: { busyEnter: 'queue' },
      user: {},
    })
    installBusyEnterDefault(ctx, resolveConfig({ busyEnterDefault: 'preserve' }))
    expect(update).not.toHaveBeenCalled()
  })
})
