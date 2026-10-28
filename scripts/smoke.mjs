/**
 * End-to-end smoke test: the built plugin writes a skill through its real
 * `skill_manage` tool, then the real `dsh-skill` registry and
 * `dsh-skill-filesystem` provider discover it.
 *
 * This is the "picked up by the harness" half of the proof; the unit tests
 * cover the guards, and the scratch-profile boot proves the plugin loads
 * inside a real host.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import registry from '@deepseek-ai/dsh-skill'
import * as provider from '@deepseek-ai/dsh-skill-filesystem'
import * as plugin from '../dist/index.js'

const SKILL = 'smoke-pickup'

const root = await mkdtemp(join(tmpdir(), 'se-smoke-skills-'))
const stateDir = await mkdtemp(join(tmpdir(), 'se-smoke-state-'))
const cwd = await mkdtemp(join(tmpdir(), 'se-smoke-cwd-'))

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

try {
  // 1. Apply the built plugin against a stub host and capture its tool.
  const captured = { tool: undefined }
  const ctx = {
    tools: { register(definition) { captured.tool = definition; return () => undefined } },
    on() {},
    effect(effect) { effect(); return () => undefined },
    logger: { info() {}, warn() {}, debug() {} },
    plugin() {},
  }
  plugin.apply(ctx, { skillsRoot: root, stateDir })

  if (captured.tool === undefined) {
    fail('skill_manage was not registered')
    process.exit(1)
  }

  const exec = {
    agent: { id: 'smoke-agent', session: { header: { cwd } } },
    signal: new AbortController().signal,
  }
  const output = await captured.tool.execute({
    action: 'create',
    name: SKILL,
    description: 'Prove that skill_manage writes are discovered by dsh-skill-filesystem.',
    body: '1. Write the skill through skill_manage\n2. List the catalog through the real provider',
  }, exec)
  console.log(`tool: ${output}`)
  if (typeof output !== 'string' || !output.includes('saved')) {
    fail('skill_manage did not report a saved skill')
  }

  // 2. Boot the real skill registry + filesystem provider over that root.
  const app = new Context()
  app.plugin(registry)
  app.plugin(provider, { customSkillDirs: [root], includeDefaultRoots: false, watch: false })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const skills = await app.skills.list({ cwd })
  const found = skills.find((skill) => skill.name === SKILL)
  console.log(`catalog: ${skills.map((skill) => skill.name).join(', ') || '(empty)'}`)

  if (found === undefined) {
    fail('dsh-skill-filesystem did not discover the written skill')
  } else {
    console.log(`discovered: ${found.name} -> ${found.path}`)
    console.log('PASS')
  }
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
}
