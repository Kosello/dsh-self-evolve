import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approvalEnabled, approvePending, listPending, prunePending, rejectPending,
  setApprovalEnabled, stageDelete, stageResourceWrite, stageSkillWrite,
} from '../src/approval.js'
import { directoryLocation, writeNewSkill } from '../src/store.js'
import { serializeSkillFile, stampMetadata, type SkillFile } from '../src/skillfile.js'

let root: string
let stateDir: string
let archiveDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'se-appr-skills-'))
  stateDir = await mkdtemp(join(tmpdir(), 'se-appr-state-'))
  archiveDir = join(stateDir, 'archive')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

function skill(name: string, body: string): SkillFile {
  return stampMetadata({ frontmatter: { name, description: 'procedure' }, body }, {
    now: '2026-08-19T00:00:00.000Z',
    create: true,
  })
}

async function seeded(name = 'staged-skill'): Promise<{ location: ReturnType<typeof directoryLocation>; file: SkillFile; text: string }> {
  const location = directoryLocation('user', root, name)
  const file = skill(name, 'old body')
  await writeNewSkill(location, file, { maxSkillBytes: 15360 })
  return { location, file, text: serializeSkillFile(file) }
}

describe('staged SKILL.md writes', () => {
  it('stages without touching the target, then applies on approval', async () => {
    const { location, file, text } = await seeded()
    const updated = { frontmatter: file.frontmatter, body: 'new body' }
    const manifest = await stageSkillWrite(stateDir, { action: 'patch', location, file: updated, oldText: text })

    expect((await listPending(stateDir)).map((entry) => entry.id)).toEqual([manifest.id])
    expect(await readFile(location.filePath, 'utf8')).toContain('old body')

    const outcome = await approvePending(stateDir, manifest.id, { archiveDir })
    expect(outcome).toMatch(/applied patch/)
    expect(await readFile(location.filePath, 'utf8')).toContain('new body')
    expect(await listPending(stateDir)).toEqual([])
  })

  it('refuses to apply when the target drifted since staging', async () => {
    const { location, file, text } = await seeded()
    const manifest = await stageSkillWrite(stateDir, {
      action: 'patch',
      location,
      file: { frontmatter: file.frontmatter, body: 'new body' },
      oldText: text,
    })
    await writeFile(location.filePath, serializeSkillFile({ frontmatter: file.frontmatter, body: 'human edit' }), 'utf8')
    await expect(approvePending(stateDir, manifest.id, { archiveDir })).rejects.toThrow(/changed since/)
  })

  it('stages and applies a brand-new skill', async () => {
    const location = directoryLocation('user', root, 'brand-new')
    const manifest = await stageSkillWrite(stateDir, { action: 'create', location, file: skill('brand-new', 'steps') })
    await expect(stat(location.filePath)).rejects.toThrow()
    await approvePending(stateDir, manifest.id, { archiveDir })
    expect(await readFile(location.filePath, 'utf8')).toContain('steps')
  })

  it('stages deletion as an archive move', async () => {
    const { location, text } = await seeded('delete-me')
    const manifest = await stageDelete(stateDir, { location, oldText: text })
    const outcome = await approvePending(stateDir, manifest.id, { archiveDir })
    expect(outcome).toMatch(/archived/)
    await expect(stat(location.filePath)).rejects.toThrow()
    expect((await listPending(stateDir))).toEqual([])
  })

  it('rejects a staged write without applying it', async () => {
    const { location, file, text } = await seeded()
    const manifest = await stageSkillWrite(stateDir, {
      action: 'patch',
      location,
      file: { frontmatter: file.frontmatter, body: 'nope' },
      oldText: text,
    })
    await rejectPending(stateDir, manifest.id)
    expect(await readFile(location.filePath, 'utf8')).toContain('old body')
    expect(await listPending(stateDir)).toEqual([])
  })

  it('rejects traversal ids', async () => {
    await expect(approvePending(stateDir, '../etc/passwd', { archiveDir })).rejects.toThrow(/invalid pending id/)
  })
})

describe('staged resource writes', () => {
  it('stages and applies a supporting file', async () => {
    const { location } = await seeded('with-res')
    const target = join(location.dir, 'scripts', 'check.sh')
    const manifest = await stageResourceWrite(stateDir, {
      location, relativePath: 'scripts/check.sh', target, content: '#!/bin/sh\n',
    })
    await expect(stat(target)).rejects.toThrow()
    await approvePending(stateDir, manifest.id, { archiveDir })
    expect(await readFile(target, 'utf8')).toContain('#!/bin/sh')
  })
})

describe('approval override + pruning', () => {
  it('persists the runtime approval switch', async () => {
    expect(await approvalEnabled(stateDir, false)).toBe(false)
    await setApprovalEnabled(stateDir, true)
    expect(await approvalEnabled(stateDir, false)).toBe(true)
    await setApprovalEnabled(stateDir, false)
    expect(await approvalEnabled(stateDir, true)).toBe(false)
  })

  it('prunes staged writes past the TTL', async () => {
    const location = directoryLocation('user', root, 'old-stage')
    await stageSkillWrite(stateDir, { action: 'create', location, file: skill('old-stage', 'x') })
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    expect(await prunePending(stateDir, 14, future)).toBe(1)
    expect(await listPending(stateDir)).toEqual([])
  })
})
