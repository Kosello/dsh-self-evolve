import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findProjectRoot, resolveSkillRoots, rootForScope } from '../src/roots.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'se-roots-'))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('findProjectRoot', () => {
  it('walks up to the nearest marker', async () => {
    const project = join(workspace, 'project')
    const deep = join(project, 'src', 'feature')
    await mkdir(deep, { recursive: true })
    await writeFile(join(project, '.git'), 'gitdir: elsewhere\n')
    expect(await findProjectRoot(deep, ['.git'])).toBe(project)
  })

  it('returns undefined when no marker exists', async () => {
    expect(await findProjectRoot(workspace, ['.git'])).toBeUndefined()
  })
})

describe('resolveSkillRoots', () => {
  it('builds the project root under .dsh/skills, falling back to cwd', async () => {
    const roots = await resolveSkillRoots(join(workspace, 'user-skills'), workspace, ['.git'])
    expect(roots.user).toBe(join(workspace, 'user-skills'))
    expect(roots.project).toBe(join(workspace, '.dsh', 'skills'))
  })

  it('omits project scope without a cwd', async () => {
    const roots = await resolveSkillRoots(join(workspace, 'user-skills'), undefined, ['.git'])
    expect(roots.project).toBeUndefined()
    expect(() => rootForScope(roots, 'project')).toThrow(/no working directory/)
  })
})
