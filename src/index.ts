/**
 * dsh-self-evolve (fork): agent-authored procedural memory for DeepSeek
 * Harness, ported to the 0.2.x plugin API.
 *
 * Three pieces:
 * - `skill_manage` — the online loop. The agent saves a proven procedure as a
 *   SKILL.md in a scanned root, where `dsh-skill-filesystem` surfaces it to
 *   later sessions with progressive disclosure for free.
 * - static prompt guidance telling the model WHEN to save or patch a skill;
 * - a mechanical curator — stale marks and archive moves for skills that stop
 *   earning their place, pinned skills exempt, foreign skills untouched.
 *
 * M1 adds the safety rails the upstream proof-of-concept lacked: read-before-
 * write, duplicate detection, credential scanning, advisory lint, project
 * scope, flat-file support and an optional human approval gate.
 *
 * The Hermes offline GEPA evolution loop is a separate system by design and
 * out of scope here.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type Config, resolveConfig } from './config.js'
import { registerSkillManageTool } from './tools.js'
import { runCurator } from './curator.js'
import { prunePending } from './approval.js'
import * as guidance from './guidance.js'
import * as command from './command.js'
import * as review from './review.js'
import type { ReviewRef } from './review.js'

export { Config } from './config.js'
export {
  AUTHOR_MARKER, isAgentAuthored, isPinned, isValidSkillName, parseSkillFile,
  serializeSkillFile, stampMetadata, withPinned, withStatus,
} from './skillfile.js'
export { runCurator } from './curator.js'
export type { CurationReport } from './curator.js'
export { approvalEnabled, listPending, approvePending, rejectPending, setApprovalEnabled } from './approval.js'
export { findDuplicates, similarity } from './dedupe.js'
export { lintSkill, scanSecrets } from './lint.js'
export { reviewDecision, reviewEnabled, setReviewEnabled } from './review.js'
export type { ReviewController, ReviewState } from './review.js'
export { createJevGate, decisionFromAnswer, selectGate } from './gate.js'
export type { GateOutcome, ReviewGate } from './gate.js'
export { DigestBuffer } from './digest.js'
export type { TurnDigest } from './digest.js'

export const name = 'self-evolve'
export const inject = ['tools']

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  registerSkillManageTool(ctx, resolved)

  // Prompt guidance only where a systemPrompt service is composed.
  if (resolved.guidance) ctx.plugin(guidance)

  // Post-turn reviewer: a nested plugin so a tree without the subagent
  // service simply leaves it pending instead of failing the whole plugin.
  const reviewRef: ReviewRef = {}
  ctx.plugin(review, { config: resolved, ref: reviewRef })

  // Approval + review commands only where an interactive command surface exists.
  ctx.plugin(command, { config: resolved, review: reviewRef })

  // One curation pass per interval, off the startup path. setTimeout keeps
  // apply() synchronous; the effect disposal cancels a pending pass on
  // plugin teardown/HMR.
  if (resolved.curatorIntervalHours > 0) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        runCurator(resolved, new Date()).then((report) => {
          if (report === undefined) return
          ctx.logger.info(
            'curator: scanned %d agent-authored skill(s), %d marked stale, %d archived%s',
            report.scanned, report.markedStale.length, report.archived.length,
            report.skippedPinned.length > 0 ? `, ${report.skippedPinned.length} pinned skipped` : '',
          )
        }).catch((error: unknown) => {
          ctx.logger.warn('curator pass failed: %s', String(error))
        })
      }, 30_000)
      return () => clearTimeout(timer)
    })
  }

  // Old staged writes expire instead of accumulating forever.
  void prunePending(resolved.stateDir, resolved.pendingTtlDays, new Date()).catch((error: unknown) => {
    ctx.logger.warn('pending prune failed: %s', String(error))
  })

  ctx.logger.info(
    'self-evolve ready (skills root: %s, stale after %dd, archive after %dd, approval: %s)',
    resolved.skillsRoot, resolved.staleDays, resolved.archiveDays, resolved.writeApproval ? 'on' : 'off',
  )
}
