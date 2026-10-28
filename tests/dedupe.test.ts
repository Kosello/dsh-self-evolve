import { describe, expect, it } from 'vitest'
import { findDuplicates, jaccard, overlap, similarity, tokenize, type DuplicateCandidate } from '../src/dedupe.js'

const candidates = [
  { name: 'debug-oomkilled-pods', description: 'Diagnose Kubernetes pods killed by the OOM killer and raise the right memory limit.', scope: 'user' },
  { name: 'release-notes', description: 'Draft release notes from merged pull requests and publish them.', scope: 'user' },
  { name: 'postgres-backup-restore', description: 'Take and restore PostgreSQL logical backups safely.', scope: 'project' },
]

describe('tokenize', () => {
  it('drops stopwords and short tokens', () => {
    const tokens = tokenize('How to debug the OOM-killed pods when a pod is restarted')
    expect(tokens.has('debug')).toBe(true)
    expect(tokens.has('oom')).toBe(true)
    expect(tokens.has('the')).toBe(false)
    expect(tokens.has('to')).toBe(false)
  })
})

describe('similarity', () => {
  it('scores a near-duplicate name and description high', () => {
    const score = similarity(
      'diagnose-oom-kills',
      'Diagnose pods killed by the OOM killer and adjust memory limits.',
      candidates[0] as DuplicateCandidate,
    )
    expect(score).toBeGreaterThan(0.55)
  })

  it('scores unrelated skills low', () => {
    const score = similarity('release-notes', 'Draft release notes from merged pull requests.', candidates[2] as DuplicateCandidate)
    expect(score).toBeLessThan(0.3)
  })

  it('jaccard and overlap behave on empty sets', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
    expect(overlap(new Set(['a']), new Set(['a', 'b', 'c']))).toBe(1)
  })
})

describe('findDuplicates', () => {
  it('returns the closest matches above threshold, best first', () => {
    const matches = findDuplicates(
      'diagnose-oom-kills',
      'Diagnose pods killed by the OOM killer and adjust memory limits.',
      candidates,
      0.45,
    )
    expect(matches[0]?.name).toBe('debug-oomkilled-pods')
  })

  it('returns nothing when detection is disabled', () => {
    expect(findDuplicates('anything', 'anything at all', candidates, 0)).toEqual([])
  })

  it('never matches the same name', () => {
    expect(findDuplicates('release-notes', 'Draft release notes from merged pull requests.', candidates, 0.1)).toEqual([])
  })
})
