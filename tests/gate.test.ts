import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig, type ResolvedJevConfig } from '../src/config.js'
import { DigestBuffer, textOf, truncate } from '../src/digest.js'
import {
  appendGateLog, buildJevRequest, createJevGate, decisionFromAnswer, selectGate,
  type JevFetch,
} from '../src/gate.js'
import type { TurnDigest } from '../src/digest.js'

const digest: TurnDigest = {
  sessionId: 's1',
  turn: 4,
  userMessage: 'No, use pnpm here. From now on never run npm install in this repo.',
  assistantMessage: 'Understood — switching to pnpm and recording the rule.',
  toolCalls: 7,
  skillsLoaded: ['repo-workflow'],
}

function jevConfig(overrides: Partial<ResolvedJevConfig> = {}): ResolvedJevConfig {
  return {
    model: 'jev-latest',
    baseURL: 'https://api.typesafe.ai',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 50,
    confidentNo: 0.75,
    cooldownMinutes: 5,
    ...overrides,
  }
}

function answer(body: unknown, status = 200): { status: number; text(): Promise<string> } {
  return { status, text: async () => JSON.stringify(body) }
}

const yesAnswer = {
  answers: {
    lesson: {
      type: 'choice',
      choice: 'yes',
      confidence: 0.91,
      probabilities: { yes: 0.91, no: 0.05, unclear: 0.04 },
    },
  },
}

const noAnswer = {
  answers: {
    lesson: {
      type: 'choice',
      choice: 'no',
      confidence: 0.88,
      probabilities: { yes: 0.06, no: 0.88, unclear: 0.06 },
    },
  },
}

let stateDir: string
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'se-gate-'))
})
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  delete process.env.TYPESAFE_API_KEY
})

describe('decisionFromAnswer', () => {
  it('skips only on a confident no', () => {
    expect(decisionFromAnswer(noAnswer.answers.lesson, 0.75)).toMatchObject({ review: false, choice: 'no' })
    expect(decisionFromAnswer({ ...noAnswer.answers.lesson, confidence: 0.4 }, 0.75)).toMatchObject({ review: true })
  })

  it('reviews on yes, unclear, and missing confidence', () => {
    expect(decisionFromAnswer(yesAnswer.answers.lesson, 0.75)).toMatchObject({ review: true, choice: 'yes' })
    expect(decisionFromAnswer({ choice: 'unclear', confidence: 0.3 }, 0.75)).toMatchObject({ review: true })
    expect(decisionFromAnswer({ choice: 'no' }, 0.75)).toMatchObject({ review: true })
  })

  it('falls back to review on malformed answers', () => {
    expect(decisionFromAnswer(undefined, 0.75)).toMatchObject({ review: true })
    expect(decisionFromAnswer({ confidence: 0.9 }, 0.75)).toMatchObject({ review: true })
  })
})

describe('buildJevRequest', () => {
  it('sends a digest, not tool output, and one choice question', () => {
    const request = buildJevRequest(digest, jevConfig()) as {
      model: string
      state: Record<string, unknown>
      questions: Record<string, { type: string; criteria: Record<string, string> }>
    }
    expect(request.model).toBe('jev-latest')
    expect(request.state).toMatchObject({ turn: 4, toolCalls: 7, skillsLoaded: ['repo-workflow'] })
    expect(Object.keys(request.questions)).toEqual(['lesson'])
    expect(request.questions.lesson?.type).toBe('choice')
    expect(Object.keys(request.questions.lesson?.criteria ?? {})).toEqual(['yes', 'no', 'unclear'])
    expect(JSON.stringify(request)).not.toContain('terminal')
  })
})

describe('createJevGate', () => {
  it('posts to the systemone endpoint with the API key', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const fetchImpl: JevFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      return answer(yesAnswer)
    }
    const gate = createJevGate({ config: jevConfig({ baseURL: 'https://api.typesafe.ai/' }), apiKey: 'k', fetch: fetchImpl })
    const outcome = await gate.decide(digest)
    expect(outcome).toMatchObject({ review: true, source: 'jev', choice: 'yes' })
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls[0]?.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(calls[0]?.body ?? '{}').questions.lesson.type).toBe('choice')
  })

  it('cancels a review on a confident no', async () => {
    const gate = createJevGate({ config: jevConfig(), apiKey: 'k', fetch: async () => answer(noAnswer) })
    const outcome = await gate.decide(digest)
    expect(outcome).toMatchObject({ review: false, source: 'jev', choice: 'no' })
  })

  it('retries a 429 once, then succeeds', async () => {
    let calls = 0
    const gate = createJevGate({
      config: jevConfig(),
      apiKey: 'k',
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1
        return calls === 1 ? answer({}, 429) : answer(yesAnswer)
      },
    })
    const outcome = await gate.decide(digest)
    expect(calls).toBe(2)
    expect(outcome.review).toBe(true)
  })

  it('falls back to review on HTTP errors and network failures', async () => {
    const bad = createJevGate({ config: jevConfig(), apiKey: 'k', fetch: async () => answer({}, 400) })
    expect(await bad.decide(digest)).toMatchObject({ review: true, source: 'counters' })
    expect((await bad.decide(digest)).reason).toContain('fallback')

    const broken = createJevGate({
      config: jevConfig(),
      apiKey: 'k',
      fetch: async () => { throw new Error('ECONNREFUSED') },
    })
    const outcome = await broken.decide(digest)
    expect(outcome.review).toBe(true)
    expect(outcome.reason).toContain('ECONNREFUSED')
  })

  it('opens the circuit after three failures', async () => {
    let calls = 0
    const gate = createJevGate({
      config: jevConfig(),
      apiKey: 'k',
      fetch: async () => { calls += 1; throw new Error('down') },
    })
    for (let index = 0; index < 5; index += 1) await gate.decide(digest)
    expect(calls).toBe(3)
    const last = await gate.decide(digest)
    expect(last.reason).toContain('circuit open')
  })

  it('aborts a call that exceeds the timeout', async () => {
    const gate = createJevGate({
      config: jevConfig({ timeoutMs: 10 }),
      apiKey: 'k',
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    const outcome = await gate.decide(digest)
    expect(outcome.review).toBe(true)
    expect(outcome.reason).toContain('aborted')
  })
})

describe('selectGate', () => {
  it('uses counters when configured', () => {
    const review = resolveConfig({ review: { gate: 'counters' } }).review
    expect(selectGate(review, { info() {}, warn() {} }).mode).toBe('counters')
  })

  it('falls back to counters when the key is missing', () => {
    const warnings: string[] = []
    const review = resolveConfig({ review: { gate: 'jev' } }).review
    const selection = selectGate(review, { info() {}, warn(message) { warnings.push(message) } })
    expect(selection.mode).toBe('counters')
    expect(selection.note).toBe('missing-api-key')
    expect(warnings).toHaveLength(1)
  })

  it('selects jev when the key is present', () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const review = resolveConfig({ review: { gate: 'jev' } }).review
    expect(selectGate(review, { info() {}, warn() {} }).mode).toBe('jev')
  })
})

describe('appendGateLog', () => {
  it('writes one JSON line per decision', async () => {
    await appendGateLog(stateDir, {
      at: '2026-10-28T10:00:00.000Z',
      session: 's1',
      turn: 4,
      decision: 'skip',
      source: 'jev',
      reason: 'confident no',
      choice: 'no',
      confidence: 0.88,
      toolCalls: 7,
      latencyMs: 120,
    })
    const lines = (await readFile(join(stateDir, 'gates.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ decision: 'skip', choice: 'no' })
  })
})

describe('DigestBuffer', () => {
  it('extracts text blocks and ignores non-text content', () => {
    expect(textOf([{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }])).toBe('hello\nworld')
    expect(textOf('plain')).toBe('plain')
    expect(textOf(null)).toBe('')
  })

  it('truncates long text', () => {
    expect(truncate('x'.repeat(10), 4)).toBe('xxxx…')
  })

  it('records direct user messages only, plus assistant text and skills', () => {
    const buffer = new DigestBuffer()
    buffer.noteUser('s', [{ type: 'text', text: 'injected' }], 'system-prompt')
    expect(buffer.build('s', 0)).toBeUndefined()

    buffer.noteUser('s', [{ type: 'text', text: 'direct' }], 'user')
    buffer.noteAssistant('s', [{ type: 'text', text: 'reply' }])
    buffer.noteTurn('s', 3)
    buffer.noteSkill('s', 'alpha')
    const built = buffer.build('s', 5)
    expect(built).toMatchObject({ turn: 3, userMessage: 'direct', assistantMessage: 'reply', toolCalls: 5, skillsLoaded: ['alpha'] })

    buffer.noteTurn('s', 4)
    expect(buffer.build('s', 0)?.skillsLoaded).toEqual([])
  })
})
