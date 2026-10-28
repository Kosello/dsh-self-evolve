import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSkillFile, serializeSkillFile, stampMetadata } from '../src/skillfile.js'
import {
  archiveSkillAt, directoryLocation, flatLocation, listSkills, locateSkill,
  readOwnedSkillAt, readSkillAt, removeResourceAt, resolveWithin, StoreError,
  writeNewSkill, writeResourceAt, writeSkillAt,
} from '../src/store.js'
import type { SkillRoots } from '../src/roots.js'

let root: string
let projectRoot: string
let stateDir: string
let roots: SkillRoots

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'se-skills-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'se-project-'))
  stateDir = await mkdtemp(join(tmpdir(), 'se-state-'))
  roots = { user: root, project: join(projectRoot, '.dsh', 'skills') }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

function ownedSkill(name: string, body = 'steps') {
  return stampMetadata({ frontmatter: { name, description: 'd' }, body }, {
    now: '2026-08-19T00:00:00.000Z',
    create: true,
  })
}

describe('writeNewSkill / readSkillAt', () => {
  it('creates then reads back a directory package', async () => {
    const location = directoryLocation('user', root, 'my-skill')
    await writeNewSkill(location, ownedSkill('my-skill'), { maxSkillBytes: 15360 })
    const file = await readSkillAt(location)
    expect(file?.frontmatter.description).toBe('d')
    expect((await stat(join(root, 'my-skill', 'SKILL.md'))).isFile()).toBe(true)
  })

  it('create refuses to overwrite; update refuses missing', async () => {
    const location = directoryLocation('user', root, 'my-skill')
    await writeNewSkill(location, ownedSkill('my-skill'), { maxSkillBytes: 15360 })
    await expect(writeNewSkill(location, ownedSkill('my-skill'), { maxSkillBytes: 15360 }))
      .rejects.toThrow(StoreError)
    await expect(writeSkillAt(directoryLocation('user', root, 'absent'), ownedSkill('absent'), { maxSkillBytes: 15360 }))
      .rejects.toThrow(StoreError)
  })

  it('enforces the size cap', async () => {
    await expect(writeNewSkill(directoryLocation('user', root, 'big-one'), ownedSkill('big-one', 'x'.repeat(20000)), { maxSkillBytes: 15360 }))
      .rejects.toThrow(/cap/)
  })
})

describe('ownership gate', () => {
  it('readOwnedSkillAt rejects foreign skills', async () => {
    await mkdir(join(root, 'human-skill'), { recursive: true })
    await writeFile(join(root, 'human-skill', 'SKILL.md'), '---\nname: human-skill\ndescription: d\n---\nbody\n')
    await expect(readOwnedSkillAt(directoryLocation('user', root, 'human-skill'))).rejects.toThrow(/not authored by the agent/)
    await expect(readOwnedSkillAt(directoryLocation('user', root, 'absent-skill'))).rejects.toThrow(/no skill named/)
  })
})

describe('locateSkill', () => {
  it('prefers the project root over the user root', async () => {
    await writeNewSkill(directoryLocation('user', root, 'shared'), ownedSkill('shared', 'user'), { maxSkillBytes: 15360 })
    const projectLocation = directoryLocation('project', roots.project as string, 'shared')
    await writeNewSkill(projectLocation, ownedSkill('shared', 'project'), { maxSkillBytes: 15360 })
    const found = await locateSkill(roots, 'shared')
    expect(found?.scope).toBe('project')
    if (found === undefined) throw new Error('expected a location')
    expect((await readSkillAt(found))?.body).toContain('project')
  })

  it('prefers directory layout over flat within one root', async () => {
    await mkdir(join(root, 'both'), { recursive: true })
    await writeFile(join(root, 'both', 'SKILL.md'), serializeSkillFile(ownedSkill('both', 'dir')))
    await writeFile(join(root, 'both.md'), serializeSkillFile(ownedSkill('both', 'flat')))
    const found = await locateSkill({ user: root }, 'both')
    expect(found?.layout).toBe('dir')
  })

  it('finds flat skills and supports patching them', async () => {
    const location = flatLocation('user', root, 'flat-one')
    await writeNewSkill(location, ownedSkill('flat-one', 'flat'), { maxSkillBytes: 15360 })
    const found = await locateSkill({ user: root }, 'flat-one')
    expect(found?.layout).toBe('flat')
    if (found === undefined) throw new Error('expected a location')
    await writeSkillAt(found, ownedSkill('flat-one', 'updated'), { maxSkillBytes: 15360 })
    expect((await readSkillAt(found))?.body).toContain('updated')
  })
})

describe('archive', () => {
  it('moves a directory package out of the scan root', async () => {
    const location = directoryLocation('user', root, 'old-skill')
    await writeNewSkill(location, ownedSkill('old-skill'), { maxSkillBytes: 15360 })
    const archiveDir = join(stateDir, 'archive')
    const to = await archiveSkillAt(location, archiveDir, new Date('2026-08-19T00:00:00Z'))
    expect(await readSkillAt(location)).toBeUndefined()
    const restored = parseSkillFile(await readFile(join(to, 'SKILL.md'), 'utf8'))
    expect(restored?.frontmatter.name).toBe('old-skill')
  })

  it('archives a flat skill as a single file', async () => {
    const location = flatLocation('user', root, 'flat-old')
    await writeNewSkill(location, ownedSkill('flat-old'), { maxSkillBytes: 15360 })
    const to = await archiveSkillAt(location, join(stateDir, 'archive'), new Date('2026-08-19T00:00:00Z'))
    expect(to.endsWith('.md')).toBe(true)
    expect(await readSkillAt(location)).toBeUndefined()
  })
})

describe('resources', () => {
  it('writes and removes files inside the skill dir only', async () => {
    const location = directoryLocation('user', root, 'with-res')
    await writeNewSkill(location, ownedSkill('with-res'), { maxSkillBytes: 15360 })
    await writeResourceAt(location, 'scripts/check.sh', '#!/bin/sh\n', { maxResourceBytes: 65536 })
    expect(await readFile(join(root, 'with-res', 'scripts', 'check.sh'), 'utf8')).toContain('#!/bin/sh')
    await removeResourceAt(location, 'scripts/check.sh')
    await expect(readFile(join(root, 'with-res', 'scripts', 'check.sh'), 'utf8')).rejects.toThrow()
  })

  it('rejects traversal, absolute paths and SKILL.md manipulation', async () => {
    const location = directoryLocation('user', root, 'with-res')
    await writeNewSkill(location, ownedSkill('with-res'), { maxSkillBytes: 15360 })
    await expect(writeResourceAt(location, '../outside.txt', 'x', { maxResourceBytes: 65536 }))
      .rejects.toThrow(/invalid resource path/)
    await expect(writeResourceAt(location, '/abs.txt', 'x', { maxResourceBytes: 65536 }))
      .rejects.toThrow(/invalid resource path/)
    await expect(writeResourceAt(location, 'SKILL.md', 'x', { maxResourceBytes: 65536 }))
      .rejects.toThrow(/managed through/)
    await expect(removeResourceAt(location, 'SKILL.md')).rejects.toThrow(/managed through/)
  })

  it('refuses resources on flat skills', async () => {
    const location = flatLocation('user', root, 'flat-res')
    await writeNewSkill(location, ownedSkill('flat-res'), { maxSkillBytes: 15360 })
    await expect(writeResourceAt(location, 'scripts/x.sh', 'x', { maxResourceBytes: 65536 }))
      .rejects.toThrow(/flat single-file skills/)
  })
})

describe('resolveWithin', () => {
  it('is strict about escapes', () => {
    expect(resolveWithin('/a/b', 'ok.txt')).toBe('/a/b/ok.txt')
    expect(resolveWithin('/a/b', 'sub/ok.txt')).toBe('/a/b/sub/ok.txt')
    expect(resolveWithin('/a/b', '../nope')).toBeUndefined()
    expect(resolveWithin('/a/b', '/abs')).toBeUndefined()
    expect(resolveWithin('/a/b', '')).toBeUndefined()
    expect(resolveWithin('/a/b', 'x/../../nope')).toBeUndefined()
  })
})

describe('listSkills', () => {
  it('lists directory packages and flat files, skipping dot entries and junk', async () => {
    await writeNewSkill(directoryLocation('user', root, 'good-one'), ownedSkill('good-one'), { maxSkillBytes: 15360 })
    await writeNewSkill(flatLocation('user', root, 'flat-good'), ownedSkill('flat-good'), { maxSkillBytes: 15360 })
    await mkdir(join(root, '.system'), { recursive: true })
    await mkdir(join(root, 'broken'), { recursive: true })
    await writeFile(join(root, 'broken', 'SKILL.md'), 'not frontmatter')
    const entries = await listSkills({ user: root })
    expect(entries.map((entry) => entry.name)).toEqual(['flat-good', 'good-one'])
    expect(entries[0]?.mtimeMs).toBeGreaterThan(0)
  })

  it('deduplicates by name with the project root winning', async () => {
    await writeNewSkill(directoryLocation('user', root, 'dup'), ownedSkill('dup', 'user'), { maxSkillBytes: 15360 })
    await writeNewSkill(directoryLocation('project', roots.project as string, 'dup'), ownedSkill('dup', 'project'), { maxSkillBytes: 15360 })
    const entries = await listSkills(roots)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.location.scope).toBe('project')
  })

  it('returns empty for a missing root', async () => {
    expect(await listSkills({ user: join(root, 'nowhere') })).toEqual([])
  })
})
