/**
 * Usage ledger: when each self-authored skill was last loaded, and when the
 * curator last ran. One JSON file under the plugin's state dir — deliberately
 * not a skill-frontmatter field, so recording a use never rewrites SKILL.md
 * (which would churn mtimes, watchers, and the skill catalog).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface SkillUsage {
  lastUsedAt: string
  uses: number
}

export interface Ledger {
  skills: Record<string, SkillUsage>
  lastCuratorRunAt?: string
}

export function ledgerPath(stateDir: string): string {
  return join(stateDir, 'usage.json')
}

export async function loadLedger(stateDir: string): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(ledgerPath(stateDir), 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null && typeof (raw as Ledger).skills === 'object') {
      return raw as Ledger
    }
  } catch {
    // Missing or corrupt ledger: start fresh — worst case skills look
    // unused since their mtime, which only delays curation, never deletes.
  }
  return { skills: {} }
}

export async function saveLedger(stateDir: string, ledger: Ledger): Promise<void> {
  const path = ledgerPath(stateDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

/** Record one use of a skill (loaded via the skill tool, or written). */
export function recordUse(ledger: Ledger, name: string, now: Date): void {
  const existing = ledger.skills[name]
  ledger.skills[name] = {
    lastUsedAt: now.toISOString(),
    uses: (existing?.uses ?? 0) + 1,
  }
}

/** Drop ledger entries for skills that no longer exist on disk. */
export function pruneLedger(ledger: Ledger, liveNames: ReadonlySet<string>): void {
  for (const name of Object.keys(ledger.skills)) {
    if (!liveNames.has(name)) delete ledger.skills[name]
  }
}
