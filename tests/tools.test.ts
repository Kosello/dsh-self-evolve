import { mkdtemp, readFile, rm, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig, type Config } from '../src/config.js'
import { registerSkillManageTool } from '../src/tools.js'
import { stampMetadata } from '../src/skillfile.js'
import { directoryLocation, flatLocation, writeNewSkill } from '../src/store.js'
import { approvePending, listPending } from '../src/approval.js'

let workspace: string
let root: string
let stateDir: string
let cwd: string

interface Captured {
  tool?: ToolDefinition
  listeners: Array<{ event: string; handler: (first: unknown, second: unknown) => void }>
}

function setup(overrides: Config = {}): { captured: Captured; exec: ToolRunContext } {
  const captured: Captured = { listeners: [] }
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        captured.tool = definition
        return () => undefined
      },
    },
    on(event: string, handler: (first: unknown, second: unknown) => void) {
      captured.listeners.push({ event, handler })
    },
    logger: { info() {}, warn() {}, debug() {} },
  } as unknown as Context
  const config = resolveConfig({ skillsRoot: root, stateDir, ...overrides })
  registerSkillManageTool(ctx, config)
  const exec = {
    agent: { id: 'agent-1', session: { header: { cwd } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { captured, exec }
}

function tool(captured: Captured): ToolDefinition {
  if (captured.tool === undefined) throw new Error('tool was not registered')
  return captured.tool
}

async function run(captured: Captured, args: Record<string, unknown>, exec: ToolRunContext): Promise<string> {
  return await tool(captured).execute(args, exec) as string
}

function markLoaded(captured: Captured, exec: ToolRunContext, name: string): void {
  for (const listener of captured.listeners) {
    if (listener.event !== 'tools/result') continue
    listener.handler({ name: 'skill', arguments: { name }, agent: exec.agent }, { isError: false })
  }
}

async function seed(name: string, body = 'old body'): Promise<void> {
  await writeNewSkill(
    directoryLocation('user', root, name),
    stampMetadata({ frontmatter: { name, description: 'A seeded procedure for a class of task.' }, body }, {
      now: '2026-08-19T00:00:00.000Z',
      create: true,
    }),
    { maxSkillBytes: 15360 },
  )
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'se-tool-'))
  root = join(workspace, 'skills')
  stateDir = join(workspace, 'state')
  cwd = join(workspace, 'cwd')
  await mkdir(cwd, { recursive: true })
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('skill_manage create / list', () => {
  it('creates a skill and lists it', async () => {
    const { captured, exec } = setup()
    const out = await run(captured, {
      action: 'create',
      name: 'debug-oom-killed-pods',
      description: 'Diagnose Kubernetes pods killed by the OOM killer.',
      body: '1. Read the last state\n2. Raise the memory limit',
    }, exec)
    expect(out).toMatch(/saved/)
    const written = await readFile(join(root, 'debug-oom-killed-pods', 'SKILL.md'), 'utf8')
    expect(written).toContain('OOM killer')

    const listed = await run(captured, { action: 'list' }, exec)
    expect(listed).toContain('debug-oom-killed-pods')
  })

  it('refuses near-duplicates and points at the existing skill', async () => {
    const { captured, exec } = setup()
    await run(captured, {
      action: 'create',
      name: 'debug-oom-killed-pods',
      description: 'Diagnose Kubernetes pods killed by the OOM killer and raise memory limits.',
      body: '1. Read events',
    }, exec)
    const out = await run(captured, {
      action: 'create',
      name: 'diagnose-oom-kills',
      description: 'Diagnose pods killed by the OOM killer and adjust memory limits.',
      body: '1. Read events',
    }, exec)
    expect(out).toMatch(/overlaps existing skills/)
    expect(out).toContain('debug-oom-killed-pods')
  })

  it('refuses credentials in a skill body', async () => {
    const { captured, exec } = setup()
    const out = await run(captured, {
      action: 'create',
      name: 'leaky-skill',
      description: 'A procedure for a class of task.',
      body: `token: AKIA${'Q'.repeat(16)}`,
    }, exec)
    expect(out).toMatch(/refused/)
    await expect(stat(join(root, 'leaky-skill'))).rejects.toThrow()
  })
})

describe('read-before-write', () => {
  it('refuses a patch until the skill is loaded, then applies it', async () => {
    await seed('seeded-skill')
    const { captured, exec } = setup()

    const refused = await run(captured, {
      action: 'patch', name: 'seeded-skill', find: 'old body', replace: 'new body',
    }, exec)
    expect(refused).toMatch(/has not been loaded/)

    markLoaded(captured, exec, 'seeded-skill')
    const applied = await run(captured, {
      action: 'patch', name: 'seeded-skill', find: 'old body', replace: 'new body',
    }, exec)
    expect(applied).toMatch(/updated/)
    expect(await readFile(join(root, 'seeded-skill', 'SKILL.md'), 'utf8')).toContain('new body')
  })

  it('patches a flat single-file skill in place', async () => {
    await writeNewSkill(flatLocation('user', root, 'flat-skill'), stampMetadata({
      frontmatter: { name: 'flat-skill', description: 'A seeded procedure for a class of task.' },
      body: 'old body',
    }, { now: '2026-08-19T00:00:00.000Z', create: true }), { maxSkillBytes: 15360 })
    const { captured, exec } = setup()
    markLoaded(captured, exec, 'flat-skill')
    const out = await run(captured, { action: 'patch', name: 'flat-skill', find: 'old body', replace: 'new body' }, exec)
    expect(out).toMatch(/updated/)
    expect(await readFile(join(root, 'flat-skill.md'), 'utf8')).toContain('new body')
  })
})

describe('project scope', () => {
  it('writes under <project>/.dsh/skills when asked', async () => {
    await writeFile(join(cwd, '.git'), 'gitdir: elsewhere\n')
    const { captured, exec } = setup()
    const out = await run(captured, {
      action: 'create',
      scope: 'project',
      name: 'repo-specific',
      description: 'Procedure specific to this repository.',
      body: '1. Do the repo thing',
    }, exec)
    expect(out).toContain('project scope')
    const written = await readFile(join(cwd, '.dsh', 'skills', 'repo-specific', 'SKILL.md'), 'utf8')
    expect(written).toContain('repo thing')
  })
})

describe('staged approval through the tool', () => {
  it('stages a create instead of writing it, then applies on approval', async () => {
    const { captured, exec } = setup({ writeApproval: true })
    const out = await run(captured, {
      action: 'create',
      name: 'staged-skill',
      description: 'A staged procedure for a class of task.',
      body: '1. Do it',
    }, exec)
    expect(out).toMatch(/Staged for approval/)
    await expect(stat(join(root, 'staged-skill', 'SKILL.md'))).rejects.toThrow()

    const pending = await listPending(stateDir)
    expect(pending).toHaveLength(1)
    await approvePending(stateDir, pending[0]?.id as string, { archiveDir: join(stateDir, 'archive') })
    expect(await readFile(join(root, 'staged-skill', 'SKILL.md'), 'utf8')).toContain('Do it')
  })
})
