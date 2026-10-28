/**
 * The curator: mechanical lifecycle maintenance for agent-authored skills.
 *
 * Hermes rules, faithfully: skills unused for `staleDays` are marked stale (a
 * frontmatter status the model sees when it loads them), skills unused for
 * `archiveDays` are archived — moved out of the scan root into the state dir,
 * never deleted. Pinned skills are exempt from both transitions, and the
 * curator NEVER touches a skill this plugin did not author.
 *
 * Only the user root is curated: project skills are repo-owned, exactly like
 * Hermes' rule for project skill directories.
 *
 * The LLM-review phase Hermes layers on top (keep/patch/consolidate votes by
 * a forked agent) is intentionally out of scope for M1.
 */

import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentAuthored, isPinned, metadataString, withStatus } from './skillfile.js'
import { archiveSkillAt, listSkills, writeSkillAt, type SkillEntry } from './store.js'
import { loadLedger, pruneLedger, saveLedger, type Ledger } from './ledger.js'
import type { ResolvedConfig } from './config.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export interface CurationReport {
  scanned: number
  markedStale: string[]
  archived: string[]
  skippedPinned: string[]
}

/** Most recent signal that a skill mattered: ledger use, write stamp, or file mtime. */
export function lastActivityMs(ledger: Ledger, name: string, updatedAt: string | undefined, mtimeMs: number): number {
  const candidates = [mtimeMs]
  const use = ledger.skills[name]?.lastUsedAt
  if (use !== undefined) {
    const parsed = Date.parse(use)
    if (Number.isFinite(parsed)) candidates.push(parsed)
  }
  if (updatedAt !== undefined) {
    const parsed = Date.parse(updatedAt)
    if (Number.isFinite(parsed)) candidates.push(parsed)
  }
  return Math.max(...candidates)
}

/** Whether enough time has passed since the last pass to run again. */
export function curatorDue(ledger: Ledger, intervalHours: number, now: Date): boolean {
  if (intervalHours <= 0) return false
  if (ledger.lastCuratorRunAt === undefined) return true
  const last = Date.parse(ledger.lastCuratorRunAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= intervalHours * HOUR_MS
}

/** One curation pass. Loads the ledger, applies transitions, saves the ledger. */
export async function runCurator(config: ResolvedConfig, now: Date): Promise<CurationReport | undefined> {
  const ledger = await loadLedger(config.stateDir)
  if (!curatorDue(ledger, config.curatorIntervalHours, now)) return undefined

  const report: CurationReport = { scanned: 0, markedStale: [], archived: [], skippedPinned: [] }
  const entries = await listSkills({ user: config.skillsRoot })
  const liveNames = new Set<string>()

  for (const entry of entries) {
    // Ownership gate: bundled, human-authored and project skills are invisible here.
    if (entry.location.scope !== 'user') continue
    if (!isAgentAuthored(entry.file)) continue
    report.scanned += 1
    liveNames.add(entry.name)

    const idleMs = now.getTime() - lastActivityMs(
      ledger,
      entry.name,
      metadataString(entry.file, 'updatedAt'),
      entry.mtimeMs,
    )

    if (isPinned(entry.file)) {
      if (idleMs >= config.staleDays * DAY_MS) report.skippedPinned.push(entry.name)
      continue
    }

    if (idleMs >= config.archiveDays * DAY_MS) {
      await archiveSkillAt(entry.location, join(config.stateDir, 'archive'), now)
      report.archived.push(entry.name)
      liveNames.delete(entry.name)
      continue
    }

    const currentStatus = metadataString(entry.file, 'status')
    if (idleMs >= config.staleDays * DAY_MS && currentStatus !== 'stale') {
      await writeStatusPreservingMtime(entry, 'stale')
      report.markedStale.push(entry.name)
    } else if (idleMs < config.staleDays * DAY_MS && currentStatus === 'stale') {
      // A recorded use since the stale mark reactivates the skill.
      await writeStatusPreservingMtime(entry, 'active')
    }
  }

  pruneLedger(ledger, liveNames)
  ledger.lastCuratorRunAt = now.toISOString()
  await saveLedger(config.stateDir, ledger)
  return report
}

/**
 * Write a status transition and restore the file's original mtime, so the
 * curator's own bookkeeping never counts as activity — without this, a stale
 * mark would reset the clock and the skill could never age into archiving.
 */
async function writeStatusPreservingMtime(entry: SkillEntry, status: 'stale' | 'active'): Promise<void> {
  await writeSkillAt(entry.location, withStatus(entry.file, status), {
    maxSkillBytes: Number.MAX_SAFE_INTEGER,
  })
  const original = new Date(entry.mtimeMs)
  await utimes(entry.location.filePath, original, original)
}
