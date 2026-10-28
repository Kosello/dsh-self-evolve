/**
 * Review gate: an advisory classifier consulted only after the deterministic
 * counters say a review is due.
 *
 * Two implementations:
 * - `counters` — a no-op that keeps the pre-Jev behaviour (the counters already
 *   decided);
 * - `jev` — one TypeSafe System One call asking whether the finished turn holds
 *   a durable lesson. The gate can only *cancel* a review it is confident is
 *   pointless; anything ambiguous, unavailable, or malformed falls back to
 *   "review", because a missed lesson is worse than a wasted review.
 *
 * The request carries a digest (user message, assistant message, tool count,
 * skills loaded) and never tool output, which is where secrets live.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedJevConfig, ResolvedReviewConfig } from './config.js'
import type { TurnDigest } from './digest.js'

export interface GateOutcome {
  review: boolean
  source: 'counters' | 'jev'
  reason: string
  choice?: string
  confidence?: number
  probability?: number
  latencyMs?: number
}

export interface ReviewGate {
  decide(digest: TurnDigest): Promise<GateOutcome>
}

export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Minimal fetch seam so tests never touch the network. */
export interface JevFetchResponse {
  readonly status: number
  text(): Promise<string>
}

export type JevFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<JevFetchResponse>

const defaultFetch: JevFetch = (url, init) => fetch(url, init)

export function createCountersGate(): ReviewGate {
  return {
    async decide() {
      return { review: true, source: 'counters', reason: 'counters due' }
    },
  }
}

const LESSON_QUESTION = {
  type: 'choice',
  instructions: [
    'This is one completed turn of a coding agent.',
    'Does it contain a durable, reusable lesson for the skill library — a user correction or standing preference,',
    'a non-trivial procedure that succeeded only after trial and error, or a loaded skill that proved wrong?',
  ].join(' '),
  criteria: {
    yes: 'The turn contains a correction, preference, or reusable procedure worth saving.',
    no: 'The turn was routine, one-off, or taught nothing that a future turn would reuse.',
    unclear: 'There may be a lesson, but the turn is ambiguous, incomplete, or too small to judge.',
  },
} as const

/** Request body for the gate call; exported for tests. */
export function buildJevRequest(digest: TurnDigest, config: ResolvedJevConfig): unknown {
  return {
    model: config.model,
    state: {
      turn: digest.turn,
      userMessage: digest.userMessage,
      assistantMessage: digest.assistantMessage,
      toolCalls: digest.toolCalls,
      skillsLoaded: digest.skillsLoaded,
    },
    questions: { lesson: LESSON_QUESTION },
  }
}

export interface AnswerDecision {
  review: boolean
  reason: string
  choice?: string
  confidence?: number
  probability?: number
}

/**
 * Map a Jev `choice` answer to a gate decision.
 *
 * Skip only when the answer is "no" with at least `confidentNo`. Everything
 * else — yes, unclear, low confidence, missing fields — reviews.
 */
export function decisionFromAnswer(answer: unknown, confidentNo: number): AnswerDecision {
  if (typeof answer !== 'object' || answer === null) {
    return { review: true, reason: 'fallback: no answer' }
  }
  const candidate = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown }
  if (typeof candidate.choice !== 'string') {
    return { review: true, reason: 'fallback: unrecognized answer' }
  }
  const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
    ? candidate.confidence
    : 0
  const probabilities = typeof candidate.probabilities === 'object' && candidate.probabilities !== null
    ? candidate.probabilities as Record<string, unknown>
    : {}
  const yes = typeof probabilities.yes === 'number' ? probabilities.yes : undefined

  if (candidate.choice === 'no' && confidence >= confidentNo) {
    return {
      review: false,
      reason: `confident no (confidence ${confidence.toFixed(2)})`,
      choice: 'no',
      confidence,
      ...(yes === undefined ? {} : { probability: yes }),
    }
  }
  if (candidate.choice === 'no') {
    return {
      review: true,
      reason: `no but not confident (confidence ${confidence.toFixed(2)})`,
      choice: 'no',
      confidence,
      ...(yes === undefined ? {} : { probability: yes }),
    }
  }
  return {
    review: true,
    reason: `${candidate.choice} (confidence ${confidence.toFixed(2)})`,
    choice: candidate.choice,
    confidence,
    ...(yes === undefined ? {} : { probability: yes }),
  }
}

interface JevAnswerBody {
  answers?: { lesson?: unknown }
  model?: unknown
}

export interface JevGateOptions {
  config: ResolvedJevConfig
  apiKey: string
  fetch?: JevFetch
  logger?: LoggerLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const CIRCUIT_THRESHOLD = 3

/** Create the Jev-backed gate with a per-process circuit breaker. */
export function createJevGate(options: JevGateOptions): ReviewGate {
  const config = options.config
  const fetchImpl = options.fetch ?? defaultFetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let failures = 0
  let open = false

  const fallback = (reason: string, startedAt: number): GateOutcome => ({
    review: true,
    source: 'counters',
    reason: `fallback: ${reason}`,
    latencyMs: now() - startedAt,
  })

  return {
    async decide(digest) {
      const startedAt = now()
      if (open) return fallback('circuit open', startedAt)

      const body = JSON.stringify(buildJevRequest(digest, config))
      const url = `${config.baseURL.replace(/\/+$/, '')}/v1/systemone`
      const headers = {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      }

      try {
        let response: JevFetchResponse | undefined
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.timeoutMs)
          try {
            response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal })
          } finally {
            clearTimeout(timer)
          }
          const retryable = response.status === 429 || response.status >= 500
          if (retryable && attempt === 0) {
            await sleep(150)
            continue
          }
          break
        }
        if (response === undefined) throw new Error('no response')
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`)
        }
        const parsed = JSON.parse(await response.text()) as JevAnswerBody
        const decision = decisionFromAnswer(parsed.answers?.lesson, config.confidentNo)
        failures = 0
        return {
          ...decision,
          source: 'jev',
          latencyMs: now() - startedAt,
        }
      } catch (error) {
        failures += 1
        const message = error instanceof Error ? error.message : String(error)
        if (failures >= CIRCUIT_THRESHOLD && !open) {
          open = true
          options.logger?.warn('review gate: circuit opened after %d failures (%s)', failures, message)
        }
        return fallback(message, startedAt)
      }
    },
  }
}

export interface GateSelection {
  gate: ReviewGate
  mode: 'counters' | 'jev'
  note?: string
}

/** Choose the gate from config, degrading to counters when Jev is unusable. */
export function selectGate(
  review: ResolvedReviewConfig,
  logger: LoggerLike,
  fetchImpl?: JevFetch,
): GateSelection {
  if (review.gate !== 'jev') return { gate: createCountersGate(), mode: 'counters' }
  const apiKey = process.env[review.jev.apiKeyEnv]?.trim()
  if (apiKey === undefined || apiKey === '') {
    logger.warn(
      'review gate "jev" selected but %s is empty; falling back to counters',
      review.jev.apiKeyEnv,
    )
    return { gate: createCountersGate(), mode: 'counters', note: 'missing-api-key' }
  }
  return {
    gate: createJevGate({ config: review.jev, apiKey, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }), logger }),
    mode: 'jev',
  }
}

export interface GateLogEntry {
  at: string
  session: string
  turn: number
  decision: 'review' | 'skip'
  source: 'counters' | 'jev'
  reason: string
  choice?: string
  confidence?: number
  probability?: number
  toolCalls: number
  latencyMs?: number
  /** The confidentNo in force when the decision was made. */
  threshold?: number
}

/** Append one JSON line to `<stateDir>/gates.jsonl`; logging never throws. */
export async function appendGateLog(stateDir: string, entry: GateLogEntry): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    await appendFile(join(stateDir, 'gates.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Observability must never break the loop.
  }
}
