/**
 * Plugin configuration schema and resolution.
 *
 * Every knob has a safe default: the plugin must be useful with an empty
 * config, and every hardening feature degrades to the upstream behavior when
 * disabled.
 */

import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'

export interface Config {
  /** Absolute user-scope skills root the agent writes to. Default: <dsh home>/skills. */
  skillsRoot?: string
  /** Absolute state dir (ledger, archive, staged writes). Default: <dsh home>/self-evolve. */
  stateDir?: string
  /** Days without use before an agent-authored skill is marked stale. */
  staleDays?: number
  /** Days without use before an agent-authored skill is archived. */
  archiveDays?: number
  /** Maximum serialized SKILL.md size in bytes. */
  maxSkillBytes?: number
  /** Maximum size of one skill resource file in bytes. */
  maxResourceBytes?: number
  /** Minimum hours between curator passes. 0 disables the curator. */
  curatorIntervalHours?: number
  /** Whether to contribute the self-improvement system prompt section. */
  guidance?: boolean
  /** Require a successful skill load before mutating an existing skill. */
  readBeforeWrite?: boolean
  /** Stage every mutating write for human approval instead of committing it. */
  writeApproval?: boolean
  /**
   * Similarity at or above which `create` refuses and points at the existing
   * skill instead. 0 disables duplicate detection.
   */
  duplicateThreshold?: number
  /** Scan skill text for credentials before writing (blocking). */
  secretScan?: boolean
  /** Run the advisory linter (warnings plus blocking structural errors). */
  lint?: boolean
  /** Markers used to find a project root above the session cwd. */
  projectRootMarkers?: string[]
  /** Days a staged write survives before it is pruned. */
  pendingTtlDays?: number
  /** Post-turn background review (the automatic half of the loop). */
  review?: ReviewConfig
}

export interface ReviewConfig {
  /** Run the post-turn reviewer at all. Default false: it spends tokens. */
  enabled?: boolean
  /** Review after this many completed user turns without a review. */
  turnInterval?: number
  /** Or after this many tool calls accumulated since the last review. */
  toolCallThreshold?: number
  /** Minimum minutes between two reviews of one session. */
  cooldownMinutes?: number
  /** Hard cap on reviews per session lifetime. */
  maxPerSession?: number
  /** Subagent provider used for the review child. Default "fork" (seeded). */
  provider?: string
  /** Abort a review child that runs longer than this. */
  timeoutMinutes?: number
  /** What decides whether a due review is worth running. Default "counters". */
  gate?: 'counters' | 'jev'
  /** Jev gate settings (used when gate is "jev"). */
  jev?: JevConfig
}

export interface JevConfig {
  /** Jev model id or alias. Default "jev-latest". */
  model?: string
  /** API root. Default "https://api.typesafe.ai". */
  baseURL?: string
  /** Environment variable holding the API key. Default "TYPESAFE_API_KEY". */
  apiKeyEnv?: string
  /** Per-attempt timeout for the gate request. Default 2000 ms. */
  timeoutMs?: number
  /**
   * Skip the review only when Jev answers "no" with at least this confidence.
   * Lower values skip more aggressively; 1 disables confident skips.
   */
  confidentNo?: number
  /** Minimum minutes between two gate calls for one session. Default 5. */
  cooldownMinutes?: number
}

export const Config: z<Config> = z.object({
  skillsRoot: z.string().description('Absolute user-scope skills root the agent writes to (default: <dsh home>/skills)'),
  stateDir: z.string().description('Absolute state directory for the ledger, archive and staged writes (default: <dsh home>/self-evolve)'),
  staleDays: z.natural().description('Days without use before an agent-authored skill is marked stale (default: 30)'),
  archiveDays: z.natural().description('Days without use before an agent-authored skill is archived (default: 90)'),
  maxSkillBytes: z.natural().min(1024).description('Maximum serialized SKILL.md size in bytes (default: 15360)'),
  maxResourceBytes: z.natural().min(1024).description('Maximum skill resource file size in bytes (default: 65536)'),
  curatorIntervalHours: z.natural().description('Minimum hours between curator passes; 0 disables (default: 24)'),
  guidance: z.boolean().description('Contribute the self-improvement system prompt section (default: true)'),
  readBeforeWrite: z.boolean().description('Require a successful skill load before mutating an existing skill (default: true)'),
  writeApproval: z.boolean().description('Stage mutating writes for human approval instead of committing them (default: false)'),
  duplicateThreshold: z.number().min(0).max(1).description('Similarity at or above which create refuses a near-duplicate; 0 disables (default: 0.55)'),
  secretScan: z.boolean().description('Block writes whose text contains credential-shaped strings (default: true)'),
  lint: z.boolean().description('Run the advisory linter on writes (default: true)'),
  projectRootMarkers: z.array(z.string()).description('Markers that identify a project root (default: [".git"])'),
  pendingTtlDays: z.natural().description('Days a staged write survives before pruning (default: 14)'),
  review: z.object({
    enabled: z.boolean().description('Run the post-turn background reviewer (default: false — it spends tokens)'),
    turnInterval: z.natural().description('Review after this many completed turns without one (default: 10)'),
    toolCallThreshold: z.natural().description('Or after this many tool calls since the last review (default: 15)'),
    cooldownMinutes: z.natural().description('Minimum minutes between reviews of one session (default: 20)'),
    maxPerSession: z.natural().description('Hard cap on reviews per session (default: 8)'),
    provider: z.string().description('Subagent provider for the review child (default: fork)'),
    timeoutMinutes: z.natural().description('Abort a review child after this many minutes (default: 5)'),
    gate: z.union([z.const('counters'), z.const('jev')]).description('What decides whether a due review runs: counters or jev (default: counters)'),
    jev: z.object({
      model: z.string().description('Jev model id or alias (default: jev-latest)'),
      baseURL: z.string().description('TypeSafe API root (default: https://api.typesafe.ai)'),
      apiKeyEnv: z.string().description('Environment variable holding the API key (default: TYPESAFE_API_KEY)'),
      timeoutMs: z.natural().description('Per-attempt timeout in milliseconds (default: 2000)'),
      confidentNo: z.number().min(0).max(1).description('Skip only when Jev answers "no" with at least this confidence (default: 0.75)'),
      cooldownMinutes: z.natural().description('Minimum minutes between gate calls per session (default: 5)'),
    }),
  }),
})

export interface ResolvedConfig {
  skillsRoot: string
  stateDir: string
  staleDays: number
  archiveDays: number
  maxSkillBytes: number
  maxResourceBytes: number
  curatorIntervalHours: number
  guidance: boolean
  readBeforeWrite: boolean
  writeApproval: boolean
  duplicateThreshold: number
  secretScan: boolean
  lint: boolean
  projectRootMarkers: string[]
  pendingTtlDays: number
  review: ResolvedReviewConfig
}

export interface ResolvedReviewConfig {
  enabled: boolean
  turnInterval: number
  toolCallThreshold: number
  cooldownMinutes: number
  maxPerSession: number
  provider: string
  timeoutMinutes: number
  gate: 'counters' | 'jev'
  jev: ResolvedJevConfig
}

export interface ResolvedJevConfig {
  model: string
  baseURL: string
  apiKeyEnv: string
  timeoutMs: number
  confidentNo: number
  cooldownMinutes: number
}

export const DEFAULT_PROJECT_MARKERS: readonly string[] = ['.git']

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const home = resolveDshHome()
  return {
    skillsRoot: config.skillsRoot ?? join(home, 'skills'),
    stateDir: config.stateDir ?? join(home, 'self-evolve'),
    staleDays: config.staleDays ?? 30,
    archiveDays: config.archiveDays ?? 90,
    maxSkillBytes: config.maxSkillBytes ?? 15360,
    maxResourceBytes: config.maxResourceBytes ?? 65536,
    curatorIntervalHours: config.curatorIntervalHours ?? 24,
    guidance: config.guidance ?? true,
    readBeforeWrite: config.readBeforeWrite ?? true,
    writeApproval: config.writeApproval ?? false,
    duplicateThreshold: config.duplicateThreshold ?? 0.55,
    secretScan: config.secretScan ?? true,
    lint: config.lint ?? true,
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_MARKERS],
    pendingTtlDays: config.pendingTtlDays ?? 14,
    review: {
      enabled: config.review?.enabled ?? false,
      turnInterval: config.review?.turnInterval ?? 10,
      toolCallThreshold: config.review?.toolCallThreshold ?? 15,
      cooldownMinutes: config.review?.cooldownMinutes ?? 20,
      maxPerSession: config.review?.maxPerSession ?? 8,
      provider: config.review?.provider ?? 'fork',
      timeoutMinutes: config.review?.timeoutMinutes ?? 5,
      gate: config.review?.gate === 'jev' ? 'jev' : 'counters',
      jev: {
        model: config.review?.jev?.model ?? 'jev-latest',
        baseURL: config.review?.jev?.baseURL ?? 'https://api.typesafe.ai',
        apiKeyEnv: config.review?.jev?.apiKeyEnv ?? 'TYPESAFE_API_KEY',
        timeoutMs: config.review?.jev?.timeoutMs ?? 2000,
        confidentNo: config.review?.jev?.confidentNo ?? 0.75,
        cooldownMinutes: config.review?.jev?.cooldownMinutes ?? 5,
      },
    },
  }
}
