import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/command.js'
import { approvalEnabled, listPending, stageSkillWrite } from '../src/approval.js'
import { directoryLocation } from '../src/store.js'
import { stampMetadata } from '../src/skillfile.js'
import { resolveConfig } from '../src/config.js'

let root: string
let stateDir: string

interface Invocation {
  rawInput: string
}

interface Handler {
  (invocation: Invocation): Promise<{ kind: 'success' | 'error'; text: string }>
}

function setup(): Handler {
  const captured: { handler?: Handler } = {}
  const ctx = {
    commands: {
      register(definition: { handler: Handler }) {
        captured.handler = definition.handler
        return () => undefined
      },
    },
  } as unknown as Context
  apply(ctx, resolveConfig({ skillsRoot: root, stateDir }))
  if (captured.handler === undefined) throw new Error('command was not registered')
  return captured.handler
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'se-cmd-skills-'))
  stateDir = await mkdtemp(join(tmpdir(), 'se-cmd-state-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

describe('/skills command', () => {
  it('lists, approves and applies a staged write', async () => {
    const handler = setup()
    const location = directoryLocation('user', root, 'cmd-skill')
    const manifest = await stageSkillWrite(stateDir, {
      action: 'create',
      location,
      file: stampMetadata({
        frontmatter: { name: 'cmd-skill', description: 'A command-path procedure.' },
        body: '1. Do it',
      }, { now: '2026-08-19T00:00:00.000Z', create: true }),
    })

    const listed = await handler({ rawInput: 'pending' })
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain(manifest.id)

    const diff = await handler({ rawInput: `diff ${manifest.id}` })
    expect(diff.text).toContain('+1. Do it')

    const approved = await handler({ rawInput: `approve ${manifest.id}` })
    expect(approved.kind).toBe('success')
    expect(await readFile(join(root, 'cmd-skill', 'SKILL.md'), 'utf8')).toContain('Do it')
    expect(await listPending(stateDir)).toEqual([])
  })

  it('rejects a staged write', async () => {
    const handler = setup()
    const location = directoryLocation('user', root, 'reject-me')
    const manifest = await stageSkillWrite(stateDir, {
      action: 'create',
      location,
      file: stampMetadata({
        frontmatter: { name: 'reject-me', description: 'A command-path procedure.' },
        body: '1. Do it',
      }, { now: '2026-08-19T00:00:00.000Z', create: true }),
    })
    const rejected = await handler({ rawInput: `reject ${manifest.id}` })
    expect(rejected.text).toMatch(/rejected/)
    expect(await listPending(stateDir)).toEqual([])
  })

  it('toggles the runtime approval gate', async () => {
    const handler = setup()
    expect(await approvalEnabled(stateDir, false)).toBe(false)
    const on = await handler({ rawInput: 'approval on' })
    expect(on.kind).toBe('success')
    expect(await approvalEnabled(stateDir, false)).toBe(true)
    await handler({ rawInput: 'approval off' })
    expect(await approvalEnabled(stateDir, true)).toBe(false)
  })

  it('returns an error for unknown subcommands and missing ids', async () => {
    const handler = setup()
    expect((await handler({ rawInput: 'nonsense' })).kind).toBe('error')
    expect((await handler({ rawInput: 'approve nope' })).kind).toBe('error')
  })
})
