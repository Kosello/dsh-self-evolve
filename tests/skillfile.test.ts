import { describe, expect, it } from 'vitest'
import {
  AUTHOR_MARKER, isAgentAuthored, isPinned, isValidSkillName, metadataString,
  parseSkillFile, serializeSkillFile, stampMetadata, withPinned, withStatus,
} from '../src/skillfile.js'

const VALID = `---
name: debug-oomkilled-pods
description: Diagnose OOMKilled pods in Kubernetes.
metadata:
  authoredBy: dsh-self-evolve
  createdAt: 2026-08-01T00:00:00.000Z
  updatedAt: 2026-08-01T00:00:00.000Z
  version: 1
---

## Procedure

1. Get pod status.
2. Check events.
`

describe('isValidSkillName', () => {
  it('accepts kebab-case', () => {
    expect(isValidSkillName('debug-oomkilled-pods')).toBe(true)
    expect(isValidSkillName('a1-b2')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName('Has-Caps')).toBe(false)
    expect(isValidSkillName('under_score')).toBe(false)
    expect(isValidSkillName('-leading')).toBe(false)
    expect(isValidSkillName('trailing-')).toBe(false)
    expect(isValidSkillName('a'.repeat(65))).toBe(false)
    expect(isValidSkillName('../escape')).toBe(false)
  })
})

describe('parse/serialize', () => {
  it('round-trips a valid skill', () => {
    const parsed = parseSkillFile(VALID)
    expect(parsed).toBeDefined()
    expect(parsed?.frontmatter.name).toBe('debug-oomkilled-pods')
    expect(parsed?.body).toContain('## Procedure')
    const again = parseSkillFile(serializeSkillFile(parsed as NonNullable<typeof parsed>))
    expect(again?.frontmatter).toEqual(parsed?.frontmatter)
  })
  it('rejects missing frontmatter or required fields', () => {
    expect(parseSkillFile('no frontmatter')).toBeUndefined()
    expect(parseSkillFile('---\ndescription: x\n---\nbody')).toBeUndefined()
    expect(parseSkillFile('---\nname: x\n---\nbody')).toBeUndefined()
  })
})

describe('authorship and lifecycle metadata', () => {
  it('detects the agent-authored marker', () => {
    const file = parseSkillFile(VALID)
    expect(file && isAgentAuthored(file)).toBe(true)
    const foreign = parseSkillFile('---\nname: x\ndescription: y\n---\nbody')
    expect(foreign && isAgentAuthored(foreign)).toBe(false)
  })

  it('stampMetadata creates version 1 with authorship', () => {
    const stamped = stampMetadata({ frontmatter: { name: 'x', description: 'y' }, body: 'b' }, {
      now: '2026-08-19T00:00:00.000Z',
      create: true,
    })
    const metadata = stamped.frontmatter.metadata as Record<string, unknown>
    expect(metadata.authoredBy).toBe(AUTHOR_MARKER)
    expect(metadata.version).toBe(1)
    expect(metadata.createdAt).toBe('2026-08-19T00:00:00.000Z')
  })

  it('stampMetadata bumps version and clears stale status on update', () => {
    const file = parseSkillFile(VALID)
    if (file === undefined) throw new Error('fixture')
    const stale = withStatus(file, 'stale')
    expect(metadataString(stale, 'status')).toBe('stale')
    const updated = stampMetadata(stale, { now: '2026-08-19T00:00:00.000Z' })
    const metadata = updated.frontmatter.metadata as Record<string, unknown>
    expect(metadata.version).toBe(2)
    expect(metadata.status).toBeUndefined()
  })

  it('pin round-trip', () => {
    const file = parseSkillFile(VALID)
    if (file === undefined) throw new Error('fixture')
    const pinned = withPinned(file, true)
    expect(isPinned(pinned)).toBe(true)
    expect(isPinned(withPinned(pinned, false))).toBe(false)
  })
})
