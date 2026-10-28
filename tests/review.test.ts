import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveConfig, type Config } from '../src/config.js'
import { apply, reviewDecision, reviewEnabled, setReviewEnabled, type ReviewRef, type ReviewState } from '../src/review.js'

let root: string
let stateDir: string

interface SpawnCall {
  provider: string
  label: string
  delivery: string
  prompt: string
  parent: unknown
}

interface Harness {
  ref: ReviewRef
  calls: SpawnCall[]
  restricted: Array<{ allow: readonly string[] }>
  emitTurnEnd(sessionId: string, kind?: 'completed' | 'error' | 'aborted'): Promise<void>
  emitToolResult(agent: Agent): void
  resolveReview(): Promise<void>
  agent: Agent
  subagent: Agent
}

function rootAgent(id = 'root'): Agent {
  return { id, session: { header: { delegationDepth: 0 } } } as unknown as Agent
}

function childAgent(id = 'child'): Agent {
  return { id, session: { header: { origin: 'subagent', delegationDepth: 1 } } } as unknown as Agent
}

function harness(configOverrides: Config = {}): Harness {
  const calls: SpawnCall[] = []
  const restricted: Array<{ allow: readonly string[] }> = []
  const handlers = new Map<string, (first: unknown, second: unknown) => void>()
  const agents = new Map<string, Agent>()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })

  const ctx = {
    agents: { get: (id: string) => agents.get(id) },
    subagents: {
      startActivation: async (spec: {
        provider: string; label: string; delivery: string; request: { prompt: Array<{ text: string }>; parent: unknown }
      }) => {
        calls.push({
          provider: spec.provider,
          label: spec.label,
          delivery: spec.delivery,
          prompt: spec.request.prompt.map((block) => block.text).join('\n'),
          parent: spec.request.parent,
        })
        return {
          childId: `child-${calls.length}`,
          result: gate.then(() => ({ stopReason: 'completed', output: [] })),
          dispose: async () => undefined,
        }
      },
    },
    on(event: string, handler: (first: unknown, second: unknown) => void) {
      handlers.set(event, handler)
    },
    effect(effect: () => (() => void) | void) {
      effect()
    },
    logger: { info() {}, warn() {}, debug() {} },
  } as unknown as Context

  const config = resolveConfig({
    skillsRoot: root,
    stateDir,
    review: { enabled: true, turnInterval: 1, toolCallThreshold: 100, cooldownMinutes: 0, maxPerSession: 8, timeoutMinutes: 1 },
    ...configOverrides,
  })
  const ref: ReviewRef = {}
  apply(ctx, { config, ref })

  const agent = rootAgent()
  const subagent = childAgent()
  const reviewChild = {
    id: 'child-1',
    session: { header: { origin: 'subagent', delegationDepth: 1 } },
    ctx: { tools: { restrict: (filter: { allow: readonly string[] }) => { restricted.push(filter) } } },
  } as unknown as Agent
  agents.set(agent.id, agent)
  agents.set(subagent.id, subagent)
  agents.set(reviewChild.id, reviewChild)

  return {
    ref,
    calls,
    restricted,
    agent,
    subagent,
    async emitTurnEnd(sessionId, kind = 'completed') {
      handlers.get('session/event')?.({ id: sessionId }, { type: 'turn/end', data: { reason: { kind } } })
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
    emitToolResult(target) {
      handlers.get('tools/result')?.({ agent: target }, { isError: false })
    },
    resolveReview() {
      release()
      return new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'se-review-skills-'))
  stateDir = await mkdtemp(join(tmpdir(), 'se-review-state-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

const baseState: ReviewState = { turns: 0, tools: 0, count: 0, inFlight: false }

function policy(overrides: Partial<ReturnType<typeof resolveConfig>['review']> = {}) {
  return { ...resolveConfig({}).review, ...overrides }
}

describe('reviewDecision', () => {
  it('is not due before either threshold', () => {
    expect(reviewDecision(baseState, policy(), Date.now()).due).toBe(false)
  })

  it('fires on tool count or turn count', () => {
    expect(reviewDecision({ ...baseState, tools: 15 }, policy(), Date.now())).toMatchObject({ due: true, reason: 'tools' })
    expect(reviewDecision({ ...baseState, turns: 10 }, policy(), Date.now())).toMatchObject({ due: true, reason: 'turns' })
  })

  it('respects cooldown, in-flight and session budget', () => {
    const now = Date.now()
    expect(reviewDecision({ ...baseState, turns: 10, lastReviewAt: now - 60_000 }, policy(), now).due).toBe(false)
    expect(reviewDecision({ ...baseState, turns: 10, inFlight: true }, policy(), now).due).toBe(false)
    expect(reviewDecision({ ...baseState, turns: 10, count: 8 }, policy(), now).due).toBe(false)
  })
})

describe('post-turn review', () => {
  it('forks a review child after a completed turn', async () => {
    const h = harness()
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ provider: 'fork', label: 'skill review', delivery: 'caller' })
    expect(h.calls[0]?.parent).toBe(h.agent)
    expect(h.calls[0]?.prompt).toContain('skill_manage')
    expect(h.calls[0]?.prompt).toContain('no skill update')
    expect(h.restricted[0]?.allow).toEqual(['skill', 'skill_manage'])
    await h.resolveReview()
  })

  it('never reviews a subagent session', async () => {
    const h = harness()
    await h.emitTurnEnd(h.subagent.id)
    expect(h.calls).toHaveLength(0)
  })

  it('skips non-completed turns', async () => {
    const h = harness()
    await h.emitTurnEnd(h.agent.id, 'error')
    expect(h.calls).toHaveLength(0)
  })

  it('does nothing while disabled, and follows the runtime toggle', async () => {
    const h = harness({ review: { enabled: false, turnInterval: 1, cooldownMinutes: 0 } })
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(0)

    await setReviewEnabled(stateDir, true)
    expect(await reviewEnabled(stateDir, false)).toBe(true)
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(1)
    await h.resolveReview()
  })

  it('applies the cooldown between reviews', async () => {
    const h = harness({ review: { enabled: true, turnInterval: 1, cooldownMinutes: 60 } })
    await h.emitTurnEnd(h.agent.id)
    await h.resolveReview()
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(1)
  })

  it('does not overlap reviews', async () => {
    const h = harness({ review: { enabled: true, turnInterval: 1, cooldownMinutes: 0 } })
    await h.emitTurnEnd(h.agent.id)
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(1)
    await h.resolveReview()
  })

  it('counts tool results toward the trigger', async () => {
    const h = harness({ review: { enabled: true, turnInterval: 100, toolCallThreshold: 2, cooldownMinutes: 0 } })
    h.emitToolResult(h.agent)
    h.emitToolResult(h.agent)
    await h.emitTurnEnd(h.agent.id)
    expect(h.calls).toHaveLength(1)
    await h.resolveReview()
  })

  it('force starts a review immediately and reports status', async () => {
    const h = harness({ review: { enabled: false, turnInterval: 100, toolCallThreshold: 100 } })
    const controller = h.ref.controller
    expect(controller).toBeDefined()
    expect(await controller?.status()).toContain('review off')
    const message = await controller?.force(h.agent)
    expect(message).toMatch(/review started/)
    expect(h.calls).toHaveLength(1)
    await h.resolveReview()
  })

  it('force refuses subagent agents', async () => {
    const h = harness()
    const message = await h.ref.controller?.force(h.subagent)
    expect(message).toMatch(/top-level session/)
    expect(h.calls).toHaveLength(0)
  })
})
