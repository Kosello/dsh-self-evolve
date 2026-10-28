import { describe, expect, it } from 'vitest'
import { ReadRegistry } from '../src/guards.js'

describe('ReadRegistry', () => {
  it('tracks loads per agent', () => {
    const registry = new ReadRegistry()
    const one = {}
    const two = {}
    registry.mark(one, 'alpha')
    expect(registry.has(one, 'alpha')).toBe(true)
    expect(registry.has(two, 'alpha')).toBe(false)
  })

  it('falls back to a shared set when the agent is unknown', () => {
    const registry = new ReadRegistry()
    registry.mark(undefined, 'beta')
    expect(registry.has(undefined, 'beta')).toBe(true)
  })

  it('resets one agent without touching others', () => {
    const registry = new ReadRegistry()
    const agent = {}
    registry.mark(agent, 'gamma')
    registry.reset(agent)
    expect(registry.has(agent, 'gamma')).toBe(false)
  })
})
