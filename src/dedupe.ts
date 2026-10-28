/**
 * Duplicate detection for `skill_manage(create)`.
 *
 * The failure mode this prevents is a library that grows one narrow skill per
 * session: the second skill about the same class of task should patch the
 * first, not sit beside it. Matching is lexical on purpose — zero dependencies,
 * deterministic, and good enough to catch "debug-oomkilled-pods" vs
 * "diagnose-oom-kills".
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'how',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'then',
  'this', 'to', 'use', 'using', 'when', 'where', 'which', 'while', 'with', 'you',
  'your', 'skill', 'skills', 'task', 'tasks',
])

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  return new Set(tokens)
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** Overlap coefficient: ignores length asymmetry, which long descriptions create. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / Math.min(a.size, b.size)
}

export interface DuplicateCandidate {
  name: string
  description: string
  scope: string
}

export interface DuplicateMatch extends DuplicateCandidate {
  score: number
}

/**
 * Score one proposed skill against the existing catalog.
 *
 * Name tokens matter most (they are what the model and the user scan), the
 * description overlap breaks ties. Scores are 0..1.
 */
export function similarity(name: string, description: string, candidate: DuplicateCandidate): number {
  const nameScore = jaccard(tokenize(name), tokenize(candidate.name))
  const descriptionScore = overlap(tokenize(description), tokenize(candidate.description))
  return 0.25 * nameScore + 0.75 * descriptionScore
}

/** Return up to `limit` candidates at or above `threshold`, best first. */
export function findDuplicates(
  name: string,
  description: string,
  candidates: readonly DuplicateCandidate[],
  threshold: number,
  limit = 3,
): DuplicateMatch[] {
  if (threshold <= 0) return []
  const matches: DuplicateMatch[] = []
  for (const candidate of candidates) {
    if (candidate.name === name) continue
    const score = similarity(name, description, candidate)
    if (score >= threshold) matches.push({ ...candidate, score })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, limit)
}
