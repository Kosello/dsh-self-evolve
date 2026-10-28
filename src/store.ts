/**
 * Skill store: filesystem operations across the user and project skill roots.
 *
 * Two on-disk layouts are supported, matching what `dsh-skill-filesystem`
 * scans: a directory package `<root>/<name>/SKILL.md` (what `create` writes by
 * default) and a flat file `<root>/<name>.md`. Lookup prefers the project root
 * over the user root and the directory layout over the flat one, mirroring the
 * harness provider's root ranking.
 *
 * Every mutating operation refuses to touch a skill this plugin did not
 * author: only files whose metadata carries the {@link AUTHOR_MARKER} stamp are
 * writable, so bundled and human-authored skills stay read-only. Deletion
 * always archives (a move outside every scan root); nothing is hard-deleted.
 */

import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  isAgentAuthored, isValidSkillName, parseSkillFile, serializeSkillFile,
  type SkillFile,
} from './skillfile.js'
import type { SkillRoots, SkillScope } from './roots.js'

export class StoreError extends Error {}

export type SkillLayout = 'dir' | 'flat'

export interface SkillLocation {
  scope: SkillScope
  root: string
  layout: SkillLayout
  /** Directory that owns the skill (for flat layouts this is the root). */
  dir: string
  /** Absolute path of the instruction file (`SKILL.md` or `<name>.md`). */
  filePath: string
  name: string
}

export interface SkillEntry {
  name: string
  file: SkillFile
  location: SkillLocation
  /** Instruction-file mtime, the fallback recency signal when the ledger has none. */
  mtimeMs: number
}

export function directoryLocation(scope: SkillScope, root: string, name: string): SkillLocation {
  return { scope, root, layout: 'dir', dir: join(root, name), filePath: join(root, name, 'SKILL.md'), name }
}

export function flatLocation(scope: SkillScope, root: string, name: string): SkillLocation {
  return { scope, root, layout: 'flat', dir: root, filePath: join(root, `${name}.md`), name }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return exists(path)
}

/** Read a text file, or undefined when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Refuse to write through a symlink: the target must be a regular path. */
async function assertNotSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new StoreError(`"${path}" is a symlink; refusing to write through it`)
    }
  } catch (error) {
    if (error instanceof StoreError) throw error
    // ENOENT: nothing to check.
  }
}

/** Write atomically (temp file + rename) so watchers never see a half file. */
async function atomicWrite(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Write arbitrary text atomically (temp file + rename). */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await atomicWrite(path, text)
}

/** Read and parse one skill at a known location; undefined when absent. */
export async function readSkillAt(location: SkillLocation): Promise<SkillFile | undefined> {
  const text = await readTextIfExists(location.filePath)
  if (text === undefined) return undefined
  const parsed = parseSkillFile(text)
  if (parsed === undefined) {
    throw new StoreError(`skill "${location.name}" exists but its instruction file is malformed`)
  }
  return parsed
}

/** Load a skill this plugin owns, for mutation. */
export async function readOwnedSkillAt(location: SkillLocation): Promise<SkillFile> {
  const file = await readSkillAt(location)
  if (file === undefined) {
    throw new StoreError(`no skill named "${location.name}" exists at ${location.filePath}`)
  }
  if (!isAgentAuthored(file)) {
    throw new StoreError(`skill "${location.name}" was not authored by the agent (bundled or human-authored skills are read-only here)`)
  }
  return file
}

/** Find the winning location for a name: project before user, dir before flat. */
export async function locateSkill(roots: SkillRoots, name: string): Promise<SkillLocation | undefined> {
  if (!isValidSkillName(name)) throw new StoreError(`invalid skill name "${name}" (kebab-case, max 64 chars)`)
  const candidates: SkillLocation[] = []
  if (roots.project !== undefined) {
    candidates.push(directoryLocation('project', roots.project, name), flatLocation('project', roots.project, name))
  }
  candidates.push(directoryLocation('user', roots.user, name), flatLocation('user', roots.user, name))
  for (const candidate of candidates) {
    if (await exists(candidate.filePath)) return candidate
  }
  return undefined
}

/** List every parseable skill under both roots, deduplicated by name. */
export async function listSkills(roots: SkillRoots): Promise<SkillEntry[]> {
  const seen = new Set<string>()
  const entries: SkillEntry[] = []
  const rootsInRank: Array<{ root: string; scope: SkillScope }> = roots.project === undefined
    ? [{ root: roots.user, scope: 'user' }]
    : [{ root: roots.project, scope: 'project' }, { root: roots.user, scope: 'user' }]

  for (const { root, scope } of rootsInRank) {
    let dirents
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    // Directory packages first: they win over a same-named flat file.
    for (const kind of ['dir', 'flat'] as const) {
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue
        let name: string
        if (kind === 'dir') {
          if (!dirent.isDirectory()) continue
          name = dirent.name
        } else {
          if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue
          name = dirent.name.slice(0, -3)
        }
        if (!isValidSkillName(name) || seen.has(name)) continue
        const location = kind === 'dir'
          ? directoryLocation(scope, root, name)
          : flatLocation(scope, root, name)
        const text = await readTextIfExists(location.filePath)
        if (text === undefined) continue
        const file = parseSkillFile(text)
        if (file === undefined) continue
        let mtimeMs = 0
        try {
          mtimeMs = (await stat(location.filePath)).mtimeMs
        } catch {
          continue
        }
        seen.add(name)
        entries.push({ name, file, location, mtimeMs })
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

export interface WriteOptions {
  maxSkillBytes: number
}

function assertSize(file: SkillFile, maxSkillBytes: number): string {
  const serialized = serializeSkillFile(file)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > maxSkillBytes) {
    throw new StoreError(
      `skill "${file.frontmatter.name}" is ${bytes} bytes; the cap is ${maxSkillBytes}. Tighten the body — a skill is a procedure, not a document dump.`,
    )
  }
  return serialized
}

/** Create a brand-new skill at a location that must not exist yet. */
export async function writeNewSkill(location: SkillLocation, file: SkillFile, options: WriteOptions): Promise<void> {
  if (!isValidSkillName(file.frontmatter.name)) {
    throw new StoreError(`invalid skill name "${file.frontmatter.name}" (kebab-case, max 64 chars)`)
  }
  if (await exists(location.filePath)) {
    throw new StoreError(`skill "${location.name}" already exists — use action "patch" or "edit" to change it`)
  }
  if (location.layout === 'dir' && await exists(location.dir)) {
    throw new StoreError(`directory ${location.dir} already exists but has no SKILL.md; inspect it before writing`)
  }
  await assertNotSymlink(location.filePath)
  await atomicWrite(location.filePath, assertSize(file, options.maxSkillBytes))
}

/** Update an existing skill in place, preserving its layout. */
export async function writeSkillAt(location: SkillLocation, file: SkillFile, options: WriteOptions): Promise<void> {
  if (!isValidSkillName(file.frontmatter.name)) {
    throw new StoreError(`invalid skill name "${file.frontmatter.name}" (kebab-case, max 64 chars)`)
  }
  if (!(await exists(location.filePath))) {
    throw new StoreError(`no skill named "${location.name}" exists to update`)
  }
  await assertNotSymlink(location.filePath)
  await atomicWrite(location.filePath, assertSize(file, options.maxSkillBytes))
}

/** Move a whole skill into the archive directory (never hard-delete). */
export async function archiveSkillAt(location: SkillLocation, archiveDir: string, now: Date): Promise<string> {
  if (!isValidSkillName(location.name)) throw new StoreError(`invalid skill name "${location.name}"`)
  if (!(await exists(location.filePath))) throw new StoreError(`no skill named "${location.name}" exists`)
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  const to = location.layout === 'dir'
    ? join(archiveDir, `${location.name}-${timestamp}`)
    : join(archiveDir, `${location.name}-${timestamp}.md`)
  await mkdir(archiveDir, { recursive: true })
  await rename(location.layout === 'dir' ? location.dir : location.filePath, to)
  return to
}

export interface ResourceWriteOptions {
  maxResourceBytes: number
}

/** Resolve a resource path inside a skill dir, rejecting escapes. */
export function resolveWithin(root: string, relativePath: string): string | undefined {
  if (relativePath === '' || isAbsolute(relativePath)) return undefined
  if (relativePath.includes('\0')) return undefined
  const normalized = normalize(relativePath)
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return undefined
  const absolute = resolve(root, normalized)
  const rootResolved = resolve(root)
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) return undefined
  return absolute
}

/** Resolve a resource path for a skill, refusing flat layouts and SKILL.md. */
export function resourceTarget(location: SkillLocation, relativePath: string): string {
  if (location.layout === 'flat') {
    throw new StoreError('flat single-file skills cannot carry resource files — use a directory-package skill')
  }
  const target = resolveWithin(location.dir, relativePath)
  if (target === undefined) {
    throw new StoreError(`invalid resource path "${relativePath}" (must stay inside the skill directory)`)
  }
  if (resolve(target) === resolve(location.filePath)) {
    throw new StoreError('SKILL.md is managed through create/patch/edit, not write_file')
  }
  return target
}

/** Write a resource file inside an owned skill's directory. */
export async function writeResourceAt(
  location: SkillLocation,
  relativePath: string,
  content: string,
  options: ResourceWriteOptions,
): Promise<string> {
  const target = resourceTarget(location, relativePath)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > options.maxResourceBytes) {
    throw new StoreError(`resource is ${bytes} bytes; the cap is ${options.maxResourceBytes}`)
  }
  await assertNotSymlink(target)
  await atomicWrite(target, content)
  return target
}

/** Remove a resource file inside an owned skill's directory. */
export async function removeResourceAt(location: SkillLocation, relativePath: string): Promise<void> {
  const target = resourceTarget(location, relativePath)
  await rm(target, { force: false })
}

/** Count resource files in a directory-package skill (capped). */
export async function countResources(location: SkillLocation, cap = 200): Promise<number> {
  if (location.layout === 'flat') return 0
  let count = 0
  const walk = async (dir: string): Promise<void> => {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (dirent.name === 'SKILL.md' || dirent.name.startsWith('.')) continue
      const path = join(dir, dirent.name)
      if (dirent.isDirectory()) await walk(path)
      else if (dirent.isFile()) count += 1
      if (count >= cap) return
    }
  }
  await walk(location.dir)
  return count
}
