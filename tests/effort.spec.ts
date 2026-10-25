import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { installUltraEffort } from '../src/effort.js'

function deepSeekInfo(provider: string, model: string, efforts: string[] = ['off', 'low', 'high', 'max']) {
  return {
    provider,
    id: model,
    name: model,
    reasoning: {
      efforts: efforts.map(id => ({ id, name: id })),
      defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
    },
  }
}

function fakeLlm() {
  const requests: LlmCallConfig[] = []
  const llm = {
    resolveModelInfo: vi.fn(async (provider: string, model: string) => deepSeekInfo(provider, model, model === 'off-only' ? ['off'] : undefined)),
    resolveCallConfig: vi.fn(async (config: LlmCallConfig) => config),
    prepareCall: vi.fn(async (config: LlmCallConfig) => ({
      config,
      stream: (options: LlmCallConfig) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })),
    stream: vi.fn((options: LlmCallConfig) => {
      requests.push(options)
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }),
  }
  const ctx = { get: (name: string) => name === 'llm' ? llm : undefined } as unknown as Context
  return { llm, ctx, requests }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iterable) { /* drain */ }
}

describe('Ultra effort decoration', () => {
  it('adds Ultra after Max only for a supported DeepSeek model', async () => {
    const { ctx, llm } = fakeLlm()
    installUltraEffort(ctx)
    const info = await llm.resolveModelInfo('deepseek-official', 'mock')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max', 'ultra'])

    const noMax = await llm.resolveModelInfo('deepseek-official', 'mock')
    expect(noMax.reasoning?.efforts.at(-1)?.id).toBe('ultra')

    const other = await llm.resolveModelInfo('other', 'mock')
    expect(other.reasoning?.efforts.some(effort => effort.id === 'ultra')).toBe(false)

    const offOnly = await llm.resolveModelInfo('deepseek-official', 'off-only')
    expect(offOnly.reasoning?.efforts.some(effort => effort.id === 'ultra')).toBe(false)
  })

  it('stores ultra in resolveCallConfig but sends max through prepareCall and stream', async () => {
    const { ctx, llm, requests } = fakeLlm()
    installUltraEffort(ctx)

    const resolved = await llm.resolveCallConfig({
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    expect(resolved.reasoningEffort).toBe('ultra')

    const prepared = await llm.prepareCall({
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
    })
    expect(prepared.config.reasoningEffort).toBe('max')
    await collect(prepared.stream({
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
      messages: [],
    }))
    expect(requests.at(-1)?.reasoningEffort).toBe('max')

    await collect(llm.stream({
      provider: 'deepseek-official',
      model: 'mock',
      reasoningEffort: 'ultra',
      messages: [],
    }))
    expect(requests.at(-1)?.reasoningEffort).toBe('max')
  })

  it('restores the original methods on dispose', async () => {
    const { ctx, llm } = fakeLlm()
    const restore = installUltraEffort(ctx)
    restore()
    const info = await llm.resolveModelInfo('deepseek-official', 'mock')
    expect(info.reasoning?.efforts.some(effort => effort.id === 'ultra')).toBe(false)
  })
})
