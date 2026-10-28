/**
 * Skill root resolution: user scope (<dsh home>/skills) plus the project scope
 * the harness itself scans (<project root>/.dsh/skills).
 *
 * The project root is the nearest ancestor of the session cwd that carries a
 * configured marker (`.git` by default), falling back to the cwd itself —
 * exactly the harness's own discovery rule. Project skills are repo-owned: the
 * curator never touches them, and writes there are opt-in per call.
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export type SkillScope = 'user' | 'project'

export interface SkillRoots {
  /** User-scope root, always present. */
  user: string
  /** Project-scope root, absent only when the session has no cwd. */
  project?: string
}

/** Walk up from `cwd` to the nearest ancestor containing any marker. */
export async function findProjectRoot(cwd: string, markers: readonly string[]): Promise<string | undefined> {
  let dir = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (marker === '') continue
      try {
        await stat(join(dir, marker))
        return dir
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Resolve both roots for one session. */
export async function resolveSkillRoots(
  userRoot: string,
  cwd: string | undefined,
  markers: readonly string[],
): Promise<SkillRoots> {
  if (cwd === undefined) return { user: userRoot }
  const projectRoot = (await findProjectRoot(cwd, markers)) ?? resolve(cwd)
  return { user: userRoot, project: join(projectRoot, '.dsh', 'skills') }
}

/** Root path for one scope; throws when project scope is unavailable. */
export function rootForScope(roots: SkillRoots, scope: SkillScope): string {
  if (scope === 'user') return roots.user
  if (roots.project === undefined) {
    throw new Error('project scope is unavailable: this session has no working directory')
  }
  return roots.project
}
