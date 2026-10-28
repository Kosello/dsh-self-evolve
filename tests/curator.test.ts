import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { curatorDue, lastActivityMs, runCurator } from '../src/curator.js'
import { loadLedger, recordUse, saveLedger } from '../src/ledger.js'
import { parseSkillFile, stampMetadata, withPinned } from '../src/skillfile.js'
import { serializeSkillFile } from '../src/skillfile.js'
import type { ResolvedConfig } from '../src/config.js'

let root: string
let stateDir: string

const NOW = new Date('2026-08-19T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    skillsRoot: root,
    stateDir,
    staleDays: 30,
    archiveDays: 90,
    maxSkillBytes: 15360,
    maxResourceBytes: 65536,
    curatorIntervalHours: 24,
    guidance: true,
    readBeforeWrite: true,
    writeApproval: false,
    duplicateThreshold: 0.55,
    secretScan: true,
    lint: true,
    projectRootMarkers: ['.git'],
    pendingTtlDays: 14,
    review: {
      enabled: false,
      turnInterval: 10,
      toolCallThreshold: 15,
      cooldownMinutes: 20,
      maxPerSession: 8,
      provider: 'fork',
      timeoutMinutes: 5,
      gate: 'counters',
      jev: {
        model: 'jev-latest',
        baseURL: 'https://api.typesafe.ai',
        apiKeyEnv: 'TYPESAFE_API_KEY',
        timeoutMs: 2000,
        confidentNo: 0.75,
        cooldownMinutes: 5,
      },
    },
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'se-cur-skills-'))
  stateDir = await mkdtemp(join(tmpdir(), 'se-cur-state-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

/** Write a skill whose metadata + file mtime say it was last touched `ageDays` ago. */
async function agedSkill(name: string, ageDays: number, options: { pinned?: boolean; authored?: boolean } = {}): Promise<void> {
  const touchedAt = new Date(NOW.getTime() - ageDays * DAY_MS)
  let file = options.authored === false
    ? { frontmatter: { name, description: 'd' }, body: 'body' }
    : stampMetadata({ frontmatter: { name, description: 'd' }, body: 'body' }, { now: touchedAt.toISOString(), create: true })
  if (options.pinned === true) file = withPinned(file, true)
  await mkdir(join(root, name), { recursive: true })
  const path = join(root, name, 'SKILL.md')
  await writeFile(path, serializeSkillFile(file))
  await utimes(path, touchedAt, touchedAt)
}

async function skillMetadata(name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = parseSkillFile(await readFile(join(root, name, 'SKILL.md'), 'utf8'))
    return parsed?.frontmatter.metadata as Record<string, unknown> | undefined
  } catch {
    return undefined
  }
}

describe('curatorDue', () => {
  it('runs on a fresh ledger, respects the interval, disables at 0', () => {
    expect(curatorDue({ skills: {} }, 24, NOW)).toBe(true)
    expect(curatorDue({ skills: {}, lastCuratorRunAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString() }, 24, NOW)).toBe(false)
    expect(curatorDue({ skills: {}, lastCuratorRunAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() }, 24, NOW)).toBe(true)
    expect(curatorDue({ skills: {} }, 0, NOW)).toBe(false)
  })
})

describe('lastActivityMs', () => {
  it('takes the max of ledger use, updatedAt, and mtime', () => {
    const ledger = { skills: { x: { lastUsedAt: '2026-08-10T00:00:00.000Z', uses: 3 } } }
    const updated = '2026-08-15T00:00:00.000Z'
    expect(lastActivityMs(ledger, 'x', updated, Date.parse('2026-08-01T00:00:00.000Z')))
      .toBe(Date.parse(updated))
  })
})

describe('runCurator', () => {
  it('marks stale, archives, skips pinned, never touches foreign skills', async () => {
    await agedSkill('fresh-skill', 5)
    await agedSkill('stale-skill', 45)
    await agedSkill('ancient-skill', 120)
    await agedSkill('pinned-old', 120, { pinned: true })
    await agedSkill('human-old', 400, { authored: false })

    const report = await runCurator(config(), NOW)
    expect(report).toBeDefined()
    expect(report?.scanned).toBe(4)
    expect(report?.markedStale).toEqual(['stale-skill'])
    expect(report?.archived).toEqual(['ancient-skill'])
    expect(report?.skippedPinned).toEqual(['pinned-old'])

    expect((await skillMetadata('stale-skill'))?.status).toBe('stale')
    expect((await skillMetadata('fresh-skill'))?.status).toBeUndefined()
    expect(await skillMetadata('ancient-skill')).toBeUndefined()
    expect((await skillMetadata('pinned-old'))?.status).toBeUndefined()
    // Foreign skill untouched and still in place (it carries no metadata).
    const human = parseSkillFile(await readFile(join(root, 'human-old', 'SKILL.md'), 'utf8'))
    expect(human?.frontmatter.name).toBe('human-old')
    expect(human?.frontmatter.metadata).toBeUndefined()

    const archived = await readdir(join(stateDir, 'archive'))
    expect(archived.some((entry) => entry.startsWith('ancient-skill-'))).toBe(true)
  })

  it('a recorded use reactivates a stale skill on the next pass', async () => {
    await agedSkill('revived-skill', 45)
    let report = await runCurator(config(), NOW)
    expect(report?.markedStale).toEqual(['revived-skill'])

    const ledger = await loadLedger(stateDir)
    recordUse(ledger, 'revived-skill', NOW)
    delete ledger.lastCuratorRunAt
    await saveLedger(stateDir, ledger)

    report = await runCurator(config(), new Date(NOW.getTime() + 1000))
    expect(report?.markedStale).toEqual([])
    expect((await skillMetadata('revived-skill'))?.status).toBeUndefined()
  })

  it('a stale mark does not reset the clock: the skill still ages into archive', async () => {
    await agedSkill('aging-skill', 45)
    let report = await runCurator(config(), NOW)
    expect(report?.markedStale).toEqual(['aging-skill'])

    // 60 more days pass (105 total) — the stale-marking write must not count
    // as activity, so the skill crosses the 90-day archive threshold.
    const later = new Date(NOW.getTime() + 60 * DAY_MS)
    report = await runCurator(config(), later)
    expect(report?.archived).toEqual(['aging-skill'])
    expect(await skillMetadata('aging-skill')).toBeUndefined()
  })

  it('respects the interval and prunes dead ledger entries', async () => {
    await agedSkill('only-skill', 1)
    const ledger = await loadLedger(stateDir)
    recordUse(ledger, 'ghost-skill', NOW)
    await saveLedger(stateDir, ledger)

    const first = await runCurator(config(), NOW)
    expect(first).toBeDefined()
    const second = await runCurator(config(), new Date(NOW.getTime() + 60_000))
    expect(second).toBeUndefined()

    const after = await loadLedger(stateDir)
    expect(after.skills['ghost-skill']).toBeUndefined()
    expect(after.lastCuratorRunAt).toBe(NOW.toISOString())
  })
})
