/**
 * Post-turn background review — the automatic half of the self-improvement
 * loop, modelled on Hermes' fork-after-the-turn design.
 *
 * On a completed turn, once the configured counters say a review is due, we
 * fork the agent into a child session seeded with the finished conversation
 * and give it ONE instruction: decide whether this conversation produced a
 * durable, reusable skill update, and make it with `skill_manage`.
 *
 * Why a fork rather than an injected message: the main transcript must stay
 * clean, and the child's tool calls must not appear in the user's session.
 * `delivery: 'caller'` also keeps the child's completion notice out of the
 * parent's inbox.
 *
 * The child inherits the parent's toolset (DSH has no per-activation tool
 * filter), so the prompt restricts it to skill tools and the write guards in
 * `skill_manage` still apply: read-before-write, duplicate refusal, credential
 * scan, and staged approval when enabled.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedConfig, ResolvedReviewConfig } from './config.js'
import { DigestBuffer } from './digest.js'
import { appendGateLog, selectGate, type GateOutcome, type ReviewGate } from './gate.js'

/** Per-session review counters. */
export interface ReviewState {
  /** Completed turns since the last review. */
  turns: number
  /** Tool results since the last review. */
  tools: number
  /** Epoch ms of the last successful start. */
  lastReviewAt?: number
  /** Reviews started for this session. */
  count: number
  /** A review is running; never overlap. */
  inFlight: boolean
  /** Epoch ms of the last gate call (Jev mode only). */
  lastGateAt?: number
}

export type ReviewDecision =
  | { due: true; reason: 'tools' | 'turns' | 'forced' | 'gate' }
  | { due: false; reason: string }

/** Pure trigger policy, exported for tests. */
export function reviewDecision(state: ReviewState, policy: ResolvedReviewConfig, now: number): ReviewDecision {
  if (state.inFlight) return { due: false, reason: 'a review is already running' }
  if (state.count >= policy.maxPerSession) return { due: false, reason: 'session review budget exhausted' }
  if (state.lastReviewAt !== undefined) {
    const elapsed = now - state.lastReviewAt
    if (elapsed < policy.cooldownMinutes * 60_000) {
      return { due: false, reason: 'cooldown' }
    }
  }
  if (state.tools >= policy.toolCallThreshold) return { due: true, reason: 'tools' }
  if (state.turns >= policy.turnInterval) return { due: true, reason: 'turns' }
  return { due: false, reason: 'not due yet' }
}

export function isRootAgent(agent: Agent): boolean {
  const header = agent.session.header
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

const REVIEW_PROMPT = [
  'You are the skill-review pass for the conversation above. It is a completed turn; the user is not waiting for you and will not see your reply.',
  '',
  'Decide whether this turn produced a durable, reusable lesson for the skill library, and apply it with `skill_manage`.',
  '',
  'Signals that warrant an update (any one is enough):',
  '- the user corrected your approach, or stated a standing preference ("from now on", "always", "never");',
  '- a non-trivial workflow succeeded after trial and error, and would be rediscovered next time;',
  '- a skill that was loaded or used in this conversation turned out wrong, incomplete, or outdated;',
  '- a repeated task appeared that a procedure would make routine.',
  '',
  'Do not save: one-off facts, incident narration (PR/issue numbers, dates, chat quotes), secrets, environment trivia, or anything already covered by the loaded skill or AGENTS.md.',
  '',
  'Preference order — pick the earliest that fits:',
  '1. PATCH a skill that was loaded or used in this conversation (load it with `skill(name)` first — the write guard refuses a patch you have not read).',
  '2. PATCH an existing umbrella skill that covers this class of task (`skill_manage(action="list")` to find it).',
  '3. CREATE a new class-level skill: numbered procedure, pitfalls with the reason they matter, and how to verify success. Keep the body under ~12 KB; put depth in `references/` via write_file.',
  '',
  'Rules:',
  '- Use only `skill` and `skill_manage`. Do not run shell commands, do not read or edit other files, do not ask questions.',
  '- Write lessons, not logs: a generalizable rule plus the mechanism it protects, once, at the step it affects.',
  '- Do not create a near-duplicate; the tool will refuse it and tell you which skill to patch.',
  '',
  'If nothing here warrants a change, reply with exactly `no skill update` and stop. That is a valid and common outcome.',
].join('\n')

const REVIEW_FLAG = 'review.json'

/** Effective review state: the runtime toggle wins over static config. */
export async function reviewEnabled(stateDir: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, REVIEW_FLAG), 'utf8')) as { enabled?: unknown }
    if (typeof raw.enabled === 'boolean') return raw.enabled
  } catch {
    // No override.
  }
  return fallback
}

export async function setReviewEnabled(stateDir: string, enabled: boolean): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, REVIEW_FLAG), `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

export interface ReviewController {
  enabled(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<void>
  status(): Promise<string>
  /** Start one review now, bypassing the counters (still one at a time). */
  force(agent: Agent): Promise<string>
}

/** Shared slot so the command surface can reach the controller. */
export interface ReviewRef {
  controller?: ReviewController
}

/** Tools the review child may use. Everything else is removed when the host allows it. */
export const REVIEW_TOOLS = ['skill', 'skill_manage'] as const

export const name = 'self-evolve-review'
export const inject = ['agents', 'subagents']

interface ReviewPluginOptions {
  config: ResolvedConfig
  ref: ReviewRef
  /** Test seam: replace the configured gate. */
  gate?: ReviewGate
}

export function apply(ctx: Context, options: ReviewPluginOptions): void {
  const { config, ref } = options
  const policy = config.review
  const digests = new DigestBuffer()
  const selection = options.gate === undefined
    ? selectGate(policy, ctx.logger)
    : { gate: options.gate, mode: 'jev' as const }
  const states = new Map<string, ReviewState>()
  const stateFor = (id: string): ReviewState => {
    const existing = states.get(id)
    if (existing !== undefined) return existing
    const created: ReviewState = { turns: 0, tools: 0, count: 0, inFlight: false }
    states.set(id, created)
    return created
  }

  type StartTrigger = 'auto' | 'forced' | 'gate'

  /** Start one review child; returns false when it was skipped or failed. */
  const startReview = async (agent: Agent, state: ReviewState, trigger: StartTrigger): Promise<boolean> => {
    if (state.inFlight) return false
    const decision: ReviewDecision = trigger === 'auto'
      ? reviewDecision(state, policy, Date.now())
      : { due: true, reason: trigger }
    if (!decision.due) return false

    state.inFlight = true
    const previousCount = state.count
    const previousLast = state.lastReviewAt
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMinutes * 60_000)

    try {
      const activation = await ctx.subagents.startActivation({
        provider: policy.provider,
        label: 'skill review',
        request: {
          prompt: [{ type: 'text', text: REVIEW_PROMPT }],
          parent: agent,
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      restrictChildTools(ctx, activation.childId)
      state.count = previousCount + 1
      state.lastReviewAt = Date.now()
      state.tools = 0
      state.turns = 0
      ctx.logger.info('review started for %s (%s)', agent.id, trigger)
      void activation.result
        .then((result) => {
          ctx.logger.info('review finished for %s: %s', agent.id, result.stopReason)
        })
        .catch((error: unknown) => {
          ctx.logger.warn('review failed for %s: %s', agent.id, String(error))
        })
        .finally(() => {
          clearTimeout(timeout)
          state.inFlight = false
        })
      return true
    } catch (error) {
      clearTimeout(timeout)
      state.inFlight = false
      state.count = previousCount
      state.lastReviewAt = previousLast
      ctx.logger.warn('review could not start for %s: %s', agent.id, String(error))
      return false
    }
  }

  const onTurnEnd = async (agent: Agent): Promise<void> => {
    if (!isRootAgent(agent)) return
    if (!(await reviewEnabled(config.stateDir, policy.enabled))) return
    const state = stateFor(agent.id)
    state.turns += 1
    if (!reviewDecision(state, policy, Date.now()).due) return
    // Let the turn/end append settle so the fork seed includes this turn.
    await new Promise((resolve) => setTimeout(resolve, 0))

    if (selection.mode === 'jev') {
      const gateCooldown = policy.jev.cooldownMinutes * 60_000
      if (state.lastGateAt !== undefined && Date.now() - state.lastGateAt < gateCooldown) return
      const toolCalls = state.tools
      const digest = digests.build(agent.id, toolCalls)
      const outcome: GateOutcome = digest === undefined
        ? { review: true, source: 'counters', reason: 'fallback: empty digest' }
        : await selection.gate.decide(digest)
      state.lastGateAt = Date.now()
      state.turns = 0
      state.tools = 0
      digests.clearSkills(agent.id)
      void appendGateLog(config.stateDir, {
        at: new Date().toISOString(),
        session: agent.id,
        turn: digest?.turn ?? 0,
        decision: outcome.review ? 'review' : 'skip',
        source: outcome.source,
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        ...(outcome.probability === undefined ? {} : { probability: outcome.probability }),
        toolCalls,
        ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
      })
      if (!outcome.review) {
        ctx.logger.info('review skipped by gate for %s: %s', agent.id, outcome.reason)
        return
      }
    }
    await startReview(agent, state, selection.mode === 'jev' ? 'gate' : 'auto')
  }

  // Count tool activity for the current turn's session. Reviews and other
  // subagent children are excluded by the root check.
  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined || !isRootAgent(agent)) return
    stateFor(agent.id).tools += 1
    if (exec.name !== 'skill' || result.isError) return
    const skillName = (exec.arguments as { name?: unknown } | null | undefined)?.name
    if (typeof skillName === 'string') digests.noteSkill(agent.id, skillName)
  })

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        digests.noteTurn(session.id, event.data.turn)
        return
      case 'user/message':
        digests.noteUser(session.id, event.data.content, event.data.source.kind)
        return
      case 'assistant/message':
        digests.noteAssistant(session.id, event.data.message.content)
        return
      case 'turn/end': {
        if (event.data.reason.kind !== 'completed') return
        const agent = ctx.agents.get(session.id)
        if (agent === undefined) return
        void onTurnEnd(agent)
        return
      }
      default:
        return
    }
  })

  const controller: ReviewController = {
    enabled: () => reviewEnabled(config.stateDir, policy.enabled),
    setEnabled: (enabled) => setReviewEnabled(config.stateDir, enabled),
    async status() {
      const on = await reviewEnabled(config.stateDir, policy.enabled)
      return `review ${on ? 'on' : 'off'} — every ${policy.turnInterval} turns or ${policy.toolCallThreshold} tool calls, cooldown ${policy.cooldownMinutes}m, max ${policy.maxPerSession}/session, provider "${policy.provider}", gate "${selection.mode}"`
    },
    async force(agent) {
      if (!isRootAgent(agent)) return 'review only runs for a top-level session'
      const state = stateFor(agent.id)
      const started = await startReview(agent, state, 'forced')
      return started ? 'review started in a forked child session' : 'review not started (already running, budget exhausted, or the subagent service refused)'
    },
  }
  ref.controller = controller
  if (process.env.DSH_SELF_EVOLVE_DEBUG === '1') {
    process.stderr.write(
      `[self-evolve] review ready: provider=${policy.provider} gate=${selection.mode} turns=${policy.turnInterval} tools=${policy.toolCallThreshold} cooldown=${policy.cooldownMinutes}m max=${policy.maxPerSession}\n`,
    )
  }
  ctx.effect(() => () => {
    if (ref.controller === controller) ref.controller = undefined
  })
}

/**
 * Narrow the review child to the skill tools.
 *
 * DSH has no per-activation tool filter, but the tool runtime exposes
 * `restrict` for the calling agent scope. We only have the child id after the
 * activation is published, so the child's first request may already be in
 * flight; the restriction still binds every later step. Best effort: a host
 * without a tool runtime on the child context simply keeps the prompt-level
 * instruction.
 */
function restrictChildTools(ctx: Context, childId: Parameters<Context["agents"]["get"]>[0]): void {
  try {
    const child = ctx.agents.get(childId)
    const runtime = (child?.ctx as Context | undefined)?.tools as
      | { restrict?: (filter: { allow: readonly string[] }) => unknown }
      | undefined
    if (runtime?.restrict === undefined) return
    runtime.restrict({ allow: REVIEW_TOOLS })
  } catch (error) {
    ctx.logger.warn('review: could not restrict child tools: %s', String(error))
  }
}
