import { describe, expect, it } from 'vitest'
import { maxDurationFor, maxRoundsFor, resolveConfig } from '../src/config.js'

describe('config', () => {
  it('applies defaults and validates positive integers', () => {
    const config = resolveConfig()
    expect(config.maxRounds).toBe(120)
    expect(config.maxDurationMs).toBe(60 * 60 * 1000)
    expect(config.noProgressRounds).toBe(3)
    expect(() => resolveConfig({ maxRounds: 0 })).toThrow(/positive integer/)
    expect(() => resolveConfig({ maxDurationMs: 1.5 })).toThrow(/positive integer/)
  })

  it('lets a skill metadata cap lower the global round cap', () => {
    const config = resolveConfig({ maxRounds: 60 })
    expect(maxRoundsFor('tdd', 120, config)).toBe(60)
    expect(maxRoundsFor('tdd', 30, config)).toBe(30)
    expect(maxRoundsFor('wayfinder', undefined, resolveConfig())).toBe(120)
  })

  it('uses a shorter duration for non-pipeline skills', () => {
    const config = resolveConfig()
    expect(maxDurationFor('wayfinder', config)).toBe(60 * 60 * 1000)
    expect(maxDurationFor('tdd', config)).toBe(30 * 60 * 1000)
  })
})
