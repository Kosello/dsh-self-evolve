import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Agent } from '@deepseek-ai/dsh-agent';

/**
 * Plugin configuration schema and resolution.
 *
 * Every knob has a safe default: the plugin must be useful with an empty
 * config, and every hardening feature degrades to the upstream behavior when
 * disabled.
 */

interface ReviewConfig {
    /** Run the post-turn reviewer at all. Default false: it spends tokens. */
    enabled?: boolean;
    /** Review after this many completed user turns without a review. */
    turnInterval?: number;
    /** Or after this many tool calls accumulated since the last review. */
    toolCallThreshold?: number;
    /** Minimum minutes between two reviews of one session. */
    cooldownMinutes?: number;
    /** Hard cap on reviews per session lifetime. */
    maxPerSession?: number;
    /** Subagent provider used for the review child. Default "fork" (seeded). */
    provider?: string;
    /** Abort a review child that runs longer than this. */
    timeoutMinutes?: number;
    /** What decides whether a due review is worth running. Default "counters". */
    gate?: 'counters' | 'jev';
    /** Jev gate settings (used when gate is "jev"). */
    jev?: JevConfig;
}
interface JevConfig {
    /** Jev model id or alias. Default "jev-latest". */
    model?: string;
    /** API root. Default "https://api.typesafe.ai". */
    baseURL?: string;
    /** Environment variable holding the API key. Default "TYPESAFE_API_KEY". */
    apiKeyEnv?: string;
    /** Per-attempt timeout for the gate request. Default 2000 ms. */
    timeoutMs?: number;
    /**
     * Skip the review only when Jev answers "no" with at least this confidence.
     * Lower values skip more aggressively; 1 disables confident skips.
     */
    confidentNo?: number;
    /** Minimum minutes between two gate calls for one session. Default 5. */
    cooldownMinutes?: number;
}
interface Config {
    /** Absolute user-scope skills root the agent writes to. Default: <dsh home>/skills. */
    skillsRoot?: string;
    /** Absolute state dir (ledger, archive, staged writes). Default: <dsh home>/self-evolve. */
    stateDir?: string;
    /** Days without use before an agent-authored skill is marked stale. */
    staleDays?: number;
    /** Days without use before an agent-authored skill is archived. */
    archiveDays?: number;
    /** Maximum serialized SKILL.md size in bytes. */
    maxSkillBytes?: number;
    /** Maximum size of one skill resource file in bytes. */
    maxResourceBytes?: number;
    /** Minimum hours between curator passes. 0 disables the curator. */
    curatorIntervalHours?: number;
    /** Whether to contribute the self-improvement system prompt section. */
    guidance?: boolean;
    /** Require a successful skill load before mutating an existing skill. */
    readBeforeWrite?: boolean;
    /** Stage every mutating write for human approval instead of committing it. */
    writeApproval?: boolean;
    /**
     * Similarity at or above which `create` refuses and points at the existing
     * skill instead. 0 disables duplicate detection.
     */
    duplicateThreshold?: number;
    /** Scan skill text for credentials before writing (blocking). */
    secretScan?: boolean;
    /** Run the advisory linter (warnings plus blocking structural errors). */
    lint?: boolean;
    /** Markers used to find a project root above the session cwd. */
    projectRootMarkers?: string[];
    /** Days a staged write survives before it is pruned. */
    pendingTtlDays?: number;
    /** Post-turn background review (the automatic half of the loop). */
    review?: ReviewConfig;
}
declare const Config: z<Config>;
interface ResolvedConfig {
    skillsRoot: string;
    stateDir: string;
    staleDays: number;
    archiveDays: number;
    maxSkillBytes: number;
    maxResourceBytes: number;
    curatorIntervalHours: number;
    guidance: boolean;
    readBeforeWrite: boolean;
    writeApproval: boolean;
    duplicateThreshold: number;
    secretScan: boolean;
    lint: boolean;
    projectRootMarkers: string[];
    pendingTtlDays: number;
    review: ResolvedReviewConfig;
}
interface ResolvedReviewConfig {
    enabled: boolean;
    turnInterval: number;
    toolCallThreshold: number;
    cooldownMinutes: number;
    maxPerSession: number;
    provider: string;
    timeoutMinutes: number;
    gate: 'counters' | 'jev';
    jev: ResolvedJevConfig;
}
interface ResolvedJevConfig {
    model: string;
    baseURL: string;
    apiKeyEnv: string;
    timeoutMs: number;
    confidentNo: number;
    cooldownMinutes: number;
}

/**
 * SKILL.md read/write: YAML frontmatter parse/serialize, name validation,
 * and the agent-authored marker the curator keys on.
 *
 * The file format is the harness skill contract (`dsh-skill-filesystem`):
 * `<name>/SKILL.md` with `name` and `description` required, `whenToUse` and
 * an open `metadata` object optional. This plugin stamps its authorship and
 * lifecycle state into `metadata` so bundled and human-authored skills are
 * never confused with self-authored ones.
 */
/** metadata.authoredBy value marking a skill as owned by this plugin. */
declare const AUTHOR_MARKER = "dsh-self-evolve";
/** Lifecycle state the curator manages. Absent means active. */
type SkillStatus = 'active' | 'stale';
interface SkillFrontmatter {
    name: string;
    description: string;
    whenToUse?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
}
interface SkillFile {
    frontmatter: SkillFrontmatter;
    body: string;
}
/** kebab-case skill names only, mirroring the harness skill contract. */
declare function isValidSkillName(name: string): boolean;
/** Split a SKILL.md document into frontmatter and body. */
declare function parseSkillFile(text: string): SkillFile | undefined;
/** Serialize a skill back to SKILL.md text. */
declare function serializeSkillFile(file: SkillFile): string;
/** Whether this plugin authored the skill (the curator's ownership gate). */
declare function isAgentAuthored(file: SkillFile): boolean;
/** Whether the skill is pinned (curator transitions skip it). */
declare function isPinned(file: SkillFile): boolean;
interface StampOptions {
    now: string;
    create?: boolean;
}
/** Stamp authorship + lifecycle metadata (mutates a copy, returns it). */
declare function stampMetadata(file: SkillFile, options: StampOptions): SkillFile;
/** Set the curator-managed lifecycle status without bumping the version. */
declare function withStatus(file: SkillFile, status: SkillStatus): SkillFile;
/** Set or clear the pin flag. */
declare function withPinned(file: SkillFile, pinned: boolean): SkillFile;

/**
 * The curator: mechanical lifecycle maintenance for agent-authored skills.
 *
 * Hermes rules, faithfully: skills unused for `staleDays` are marked stale (a
 * frontmatter status the model sees when it loads them), skills unused for
 * `archiveDays` are archived — moved out of the scan root into the state dir,
 * never deleted. Pinned skills are exempt from both transitions, and the
 * curator NEVER touches a skill this plugin did not author.
 *
 * Only the user root is curated: project skills are repo-owned, exactly like
 * Hermes' rule for project skill directories.
 *
 * The LLM-review phase Hermes layers on top (keep/patch/consolidate votes by
 * a forked agent) is intentionally out of scope for M1.
 */

interface CurationReport {
    scanned: number;
    markedStale: string[];
    archived: string[];
    skippedPinned: string[];
}
/** One curation pass. Loads the ledger, applies transitions, saves the ledger. */
declare function runCurator(config: ResolvedConfig, now: Date): Promise<CurationReport | undefined>;

/**
 * Skill root resolution: user scope (<dsh home>/skills) plus the project scope
 * the harness itself scans (<project root>/.dsh/skills).
 *
 * The project root is the nearest ancestor of the session cwd that carries a
 * configured marker (`.git` by default), falling back to the cwd itself —
 * exactly the harness's own discovery rule. Project skills are repo-owned: the
 * curator never touches them, and writes there are opt-in per call.
 */
type SkillScope = 'user' | 'project';

/**
 * Skill store: filesystem operations across the user and project skill roots.
 *
 * Two on-disk layouts are supported, matching what `dsh-skill-filesystem`
 * scans: a directory package `<root>/<name>/SKILL.md` (what `create` writes by
 * default) and a flat file `<root>/<name>.md`. Lookup prefers the project root
 * over the user root and the directory layout over the flat one, mirroring the
 * harness provider's root ranking.
 *
 * Every mutating operation refuses to touch a skill this plugin did not
 * author: only files whose metadata carries the {@link AUTHOR_MARKER} stamp are
 * writable, so bundled and human-authored skills stay read-only. Deletion
 * always archives (a move outside every scan root); nothing is hard-deleted.
 */

type SkillLayout = 'dir' | 'flat';

/**
 * Staged write approval.
 *
 * When `writeApproval` is on, every mutation is computed exactly as it would
 * be applied, written into `<stateDir>/pending/<id>/`, and left for a human.
 * Approval re-validates that the target has not changed since staging (content
 * hash), then applies the staged bytes atomically. Nothing is ever applied
 * from a manifest whose base drifted — that is the whole point of the gate.
 */

type PendingAction = 'create' | 'patch' | 'edit' | 'pin' | 'unpin' | 'delete' | 'write_file' | 'remove_file';
interface PendingManifest {
    id: string;
    action: PendingAction;
    name: string;
    scope: SkillScope;
    root: string;
    layout: SkillLayout;
    /** Absolute path the action would write, or the instruction file for delete. */
    target: string;
    createdAt: string;
    sessionId?: string;
    summary: string;
    diff: string;
    additions: number;
    deletions: number;
    /** sha256 of the target content at staging time; absent when the target must not exist. */
    baseHash?: string;
    /** Content file name inside the pending dir; empty for delete/remove_file. */
    staged: string;
    /** Resource path for write_file/remove_file. */
    resourcePath?: string;
}
declare function listPending(stateDir: string): Promise<PendingManifest[]>;
interface ApproveOptions {
    archiveDir: string;
}
/** Apply one staged write. Returns a human-readable outcome line. */
declare function approvePending(stateDir: string, id: string, options: ApproveOptions): Promise<string>;
/** Drop one staged write without applying it. */
declare function rejectPending(stateDir: string, id: string): Promise<string>;
/** Effective approval state: the runtime override wins over the static config. */
declare function approvalEnabled(stateDir: string, fallback: boolean): Promise<boolean>;
declare function setApprovalEnabled(stateDir: string, enabled: boolean): Promise<void>;

interface DuplicateCandidate {
    name: string;
    description: string;
    scope: string;
}
interface DuplicateMatch extends DuplicateCandidate {
    score: number;
}
/**
 * Score one proposed skill against the existing catalog.
 *
 * Name tokens matter most (they are what the model and the user scan), the
 * description overlap breaks ties. Scores are 0..1.
 */
declare function similarity(name: string, description: string, candidate: DuplicateCandidate): number;
/** Return up to `limit` candidates at or above `threshold`, best first. */
declare function findDuplicates(name: string, description: string, candidates: readonly DuplicateCandidate[], threshold: number, limit?: number): DuplicateMatch[];

/**
 * Advisory linter and credential scanner.
 *
 * Errors block a write (credential-shaped text, empty body, unusable
 * description); warnings are returned to the model but never block. The rules
 * target the failure shapes observed in agent-authored skill libraries:
 * incident logs pasted as procedure, sprawling reference sets, and oversized
 * bodies that stay in context for the rest of the session.
 */

type IssueSeverity = 'error' | 'warn';
interface Issue {
    severity: IssueSeverity;
    rule: string;
    message: string;
}
/** Credential-shaped strings: blocking. */
declare function scanSecrets(text: string): Issue[];
interface LintOptions {
    /** Resource files in the skill directory, when known. */
    resourceCount?: number;
}
/** Structural + advisory checks; never mutates. */
declare function lintSkill(file: SkillFile, options?: LintOptions): Issue[];

/**
 * Bounded per-session digest for the review gate.
 *
 * Jev evaluates a natural-language state, so the gate needs a compact view of
 * the finished turn. We keep only what the decision depends on — the last
 * direct-human message, the last assistant message, which skills were loaded,
 * and the turn index — and never the tool output, which is where secrets and
 * bulk data live.
 */
interface TurnDigest {
    sessionId: string;
    turn: number;
    userMessage: string;
    assistantMessage: string;
    toolCalls: number;
    skillsLoaded: readonly string[];
}
/** Rolling digest state, keyed by session id. */
declare class DigestBuffer {
    private readonly sessions;
    private stateFor;
    /** Record a direct-human user message; synthetic injections are ignored. */
    noteUser(sessionId: string, content: unknown, sourceKind: string | undefined): void;
    noteAssistant(sessionId: string, content: unknown): void;
    noteTurn(sessionId: string, turn: number): void;
    noteSkill(sessionId: string, name: string): void;
    /** Build the gate input; undefined when the session produced nothing reviewable. */
    build(sessionId: string, toolCalls: number): TurnDigest | undefined;
    /** Clear the per-turn skill set after a gate decision. */
    clearSkills(sessionId: string): void;
    get size(): number;
}

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

interface GateOutcome {
    review: boolean;
    source: 'counters' | 'jev';
    reason: string;
    choice?: string;
    confidence?: number;
    probability?: number;
    latencyMs?: number;
}
interface ReviewGate {
    decide(digest: TurnDigest): Promise<GateOutcome>;
}
interface LoggerLike {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
}
/** Minimal fetch seam so tests never touch the network. */
interface JevFetchResponse {
    readonly status: number;
    text(): Promise<string>;
}
type JevFetch = (url: string, init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
}) => Promise<JevFetchResponse>;
interface AnswerDecision {
    review: boolean;
    reason: string;
    choice?: string;
    confidence?: number;
    probability?: number;
}
/**
 * Map a Jev `choice` answer to a gate decision.
 *
 * Skip only when the answer is "no" with at least `confidentNo`. Everything
 * else — yes, unclear, low confidence, missing fields — reviews.
 */
declare function decisionFromAnswer(answer: unknown, confidentNo: number): AnswerDecision;
interface JevGateOptions {
    config: ResolvedJevConfig;
    apiKey: string;
    fetch?: JevFetch;
    logger?: LoggerLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/** Create the Jev-backed gate with a per-process circuit breaker. */
declare function createJevGate(options: JevGateOptions): ReviewGate;
interface GateSelection {
    gate: ReviewGate;
    mode: 'counters' | 'jev';
    note?: string;
}
/** Choose the gate from config, degrading to counters when Jev is unusable. */
declare function selectGate(review: ResolvedReviewConfig, logger: LoggerLike, fetchImpl?: JevFetch): GateSelection;

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

/** Per-session review counters. */
interface ReviewState {
    /** Completed turns since the last review. */
    turns: number;
    /** Tool results since the last review. */
    tools: number;
    /** Epoch ms of the last successful start. */
    lastReviewAt?: number;
    /** Reviews started for this session. */
    count: number;
    /** A review is running; never overlap. */
    inFlight: boolean;
    /** Epoch ms of the last gate call (Jev mode only). */
    lastGateAt?: number;
}
type ReviewDecision = {
    due: true;
    reason: 'tools' | 'turns' | 'forced' | 'gate';
} | {
    due: false;
    reason: string;
};
/** Pure trigger policy, exported for tests. */
declare function reviewDecision(state: ReviewState, policy: ResolvedReviewConfig, now: number): ReviewDecision;
/** Effective review state: the runtime toggle wins over static config. */
declare function reviewEnabled(stateDir: string, fallback: boolean): Promise<boolean>;
declare function setReviewEnabled(stateDir: string, enabled: boolean): Promise<void>;
interface ReviewController {
    enabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<void>;
    status(): Promise<string>;
    /** Start one review now, bypassing the counters (still one at a time). */
    force(agent: Agent): Promise<string>;
}

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

declare const name = "self-evolve";
declare const inject: string[];
declare function apply(ctx: Context, config?: Config): void;

export { AUTHOR_MARKER, Config, type CurationReport, DigestBuffer, type GateOutcome, type ReviewController, type ReviewGate, type ReviewState, type TurnDigest, apply, approvalEnabled, approvePending, createJevGate, decisionFromAnswer, findDuplicates, inject, isAgentAuthored, isPinned, isValidSkillName, lintSkill, listPending, name, parseSkillFile, rejectPending, reviewDecision, reviewEnabled, runCurator, scanSecrets, selectGate, serializeSkillFile, setApprovalEnabled, setReviewEnabled, similarity, stampMetadata, withPinned, withStatus };
