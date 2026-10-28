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

import { parse, stringify } from 'yaml'

/** metadata.authoredBy value marking a skill as owned by this plugin. */
export const AUTHOR_MARKER = 'dsh-self-evolve'

/** Lifecycle state the curator manages. Absent means active. */
export type SkillStatus = 'active' | 'stale'

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface SkillFile {
  frontmatter: SkillFrontmatter
  body: string
}

/** kebab-case skill names only, mirroring the harness skill contract. */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64
}

/** Split a SKILL.md document into frontmatter and body. */
export function parseSkillFile(text: string): SkillFile | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  let data: unknown
  try {
    data = parse(match[1] ?? '')
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const frontmatter = data as Record<string, unknown>
  if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') return undefined
  return { frontmatter: frontmatter as SkillFrontmatter, body: match[2] ?? '' }
}

/** Serialize a skill back to SKILL.md text. */
export function serializeSkillFile(file: SkillFile): string {
  const yaml = stringify(file.frontmatter, { lineWidth: 0 }).trimEnd()
  const body = file.body.replace(/^\r?\n+/, '').trimEnd()
  return `---\n${yaml}\n---\n\n${body}\n`
}

/** Whether this plugin authored the skill (the curator's ownership gate). */
export function isAgentAuthored(file: SkillFile): boolean {
  const metadata = file.frontmatter.metadata
  return typeof metadata === 'object' && metadata !== null
    && (metadata as Record<string, unknown>).authoredBy === AUTHOR_MARKER
}

/** Read a metadata field as a string, or undefined. */
export function metadataString(file: SkillFile, key: string): string | undefined {
  const metadata = file.frontmatter.metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Whether the skill is pinned (curator transitions skip it). */
export function isPinned(file: SkillFile): boolean {
  const metadata = file.frontmatter.metadata
  return typeof metadata === 'object' && metadata !== null
    && (metadata as Record<string, unknown>).pinned === true
}

export interface StampOptions {
  now: string
  create?: boolean
}

/** Stamp authorship + lifecycle metadata (mutates a copy, returns it). */
export function stampMetadata(file: SkillFile, options: StampOptions): SkillFile {
  const previous = (typeof file.frontmatter.metadata === 'object' && file.frontmatter.metadata !== null)
    ? file.frontmatter.metadata
    : {}
  const previousVersion = Number((previous as Record<string, unknown>).version)
  const metadata: Record<string, unknown> = {
    ...previous,
    authoredBy: AUTHOR_MARKER,
    updatedAt: options.now,
    version: options.create === true ? 1 : (Number.isFinite(previousVersion) ? previousVersion + 1 : 1),
  }
  if (options.create === true) metadata.createdAt = options.now
  // Any write reactivates a stale skill: the agent touching it is a use.
  delete metadata.status
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body }
}

/** Set the curator-managed lifecycle status without bumping the version. */
export function withStatus(file: SkillFile, status: SkillStatus): SkillFile {
  const previous = (typeof file.frontmatter.metadata === 'object' && file.frontmatter.metadata !== null)
    ? file.frontmatter.metadata
    : {}
  const metadata: Record<string, unknown> = { ...previous }
  if (status === 'active') delete metadata.status
  else metadata.status = status
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body }
}

/** Set or clear the pin flag. */
export function withPinned(file: SkillFile, pinned: boolean): SkillFile {
  const previous = (typeof file.frontmatter.metadata === 'object' && file.frontmatter.metadata !== null)
    ? file.frontmatter.metadata
    : {}
  const metadata: Record<string, unknown> = { ...previous }
  if (pinned) metadata.pinned = true
  else delete metadata.pinned
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body }
}
