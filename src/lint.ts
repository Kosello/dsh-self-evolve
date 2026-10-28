/**
 * Advisory linter and credential scanner.
 *
 * Errors block a write (credential-shaped text, empty body, unusable
 * description); warnings are returned to the model but never block. The rules
 * target the failure shapes observed in agent-authored skill libraries:
 * incident logs pasted as procedure, sprawling reference sets, and oversized
 * bodies that stay in context for the rest of the session.
 */

import type { SkillFile } from './skillfile.js'

export type IssueSeverity = 'error' | 'warn'

export interface Issue {
  severity: IssueSeverity
  rule: string
  message: string
}

interface SecretPattern {
  rule: string
  pattern: RegExp
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  {
    rule: 'secret-assignment',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}['"]?/i,
  },
]

const DANGEROUS_PATTERNS: readonly SecretPattern[] = [
  { rule: 'pipe-to-shell', pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/ },
  { rule: 'rm-root', pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/ },
  { rule: 'chmod-777', pattern: /\bchmod\s+(?:-R\s+)?777\b/ },
]

const PLACEHOLDER = /example|placeholder|redacted|xxxx|dummy|\$\{|\$[A-Z_]+/i

/** Credential-shaped strings: blocking. */
export function scanSecrets(text: string): Issue[] {
  const issues: Issue[] = []
  for (const { rule, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    if (PLACEHOLDER.test(match[0])) continue
    issues.push({
      severity: 'error',
      rule: `secret:${rule}`,
      message: `looks like a credential (${rule}). Skills are loaded into every matching session — replace it with a placeholder such as $API_KEY.`,
    })
  }
  return issues
}

/** Destructive shell idioms: advisory. */
export function scanDangerous(text: string): Issue[] {
  const issues: Issue[] = []
  for (const { rule, pattern } of DANGEROUS_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    issues.push({
      severity: 'warn',
      rule: `danger:${rule}`,
      message: `contains a destructive shell idiom (${rule}); make the guard rails explicit in the step that runs it.`,
    })
  }
  return issues
}

export interface LintOptions {
  /** Resource files in the skill directory, when known. */
  resourceCount?: number
}

const INCIDENT_TOKEN = /(?:#[0-9]{3,}|\b[A-Z][A-Z0-9]+-[0-9]{2,}\b)/g
const MAX_BODY_CHARS = 24_000
const MAX_DESCRIPTION_CHARS = 1_024
const MAX_REFERENCES = 60

/** Structural + advisory checks; never mutates. */
export function lintSkill(file: SkillFile, options: LintOptions = {}): Issue[] {
  const issues: Issue[] = []
  const description = file.frontmatter.description.trim()
  const body = file.body.trim()

  if (description.length === 0) {
    issues.push({ severity: 'error', rule: 'description-empty', message: 'description is required; it is what future sessions match against.' })
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    issues.push({
      severity: 'error',
      rule: 'description-too-long',
      message: `description is ${description.length} chars; the cap is ${MAX_DESCRIPTION_CHARS}. Keep it one sentence.`,
    })
  }

  if (body.length === 0) {
    issues.push({ severity: 'error', rule: 'body-empty', message: 'the body is empty; a skill without a procedure is not a skill.' })
  } else if (body.length > MAX_BODY_CHARS) {
    issues.push({
      severity: 'warn',
      rule: 'oversized-body',
      message: `body is ${body.length} chars (>${MAX_BODY_CHARS}); a loaded skill stays in context for the rest of the session. Move depth into references/.`,
    })
  }

  const incidentTokens = body.match(INCIDENT_TOKEN) ?? []
  if (incidentTokens.length > 8) {
    issues.push({
      severity: 'warn',
      rule: 'incident-log-shape',
      message: `body contains ${incidentTokens.length} issue/PR-style references. Skills capture lessons, not logs: keep the generalizable rule and drop the ticket numbers.`,
    })
  }

  if ((options.resourceCount ?? 0) > MAX_REFERENCES) {
    issues.push({
      severity: 'warn',
      rule: 'references-sprawl',
      message: `${options.resourceCount} resource files (>${MAX_REFERENCES}). Consolidate into a few topical references instead of one file per session.`,
    })
  }

  return issues
}

/** Full scan for one write. */
export function scanSkill(file: SkillFile, options: { secretScan: boolean; lint: boolean; resourceCount?: number }): Issue[] {
  const issues: Issue[] = []
  if (options.lint) issues.push(...lintSkill(file, { resourceCount: options.resourceCount }))
  const serialized = `${file.frontmatter.description}\n${file.body}`
  if (options.secretScan) issues.push(...scanSecrets(serialized))
  issues.push(...scanDangerous(serialized))
  return issues
}

export function blockingIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => issue.severity === 'error')
}

export function formatIssues(issues: readonly Issue[]): string {
  if (issues.length === 0) return ''
  return issues
    .map((issue) => `${issue.severity === 'error' ? 'ERROR' : 'warning'} [${issue.rule}] ${issue.message}`)
    .join('\n')
}
