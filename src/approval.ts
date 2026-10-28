/**
 * Staged write approval.
 *
 * When `writeApproval` is on, every mutation is computed exactly as it would
 * be applied, written into `<stateDir>/pending/<id>/`, and left for a human.
 * Approval re-validates that the target has not changed since staging (content
 * hash), then applies the staged bytes atomically. Nothing is ever applied
 * from a manifest whose base drifted — that is the whole point of the gate.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  archiveSkillAt, directoryLocation, flatLocation, pathExists, readTextIfExists,
  writeNewSkill, writeSkillAt, writeTextAtomic,
  type SkillLayout, type SkillLocation,
} from './store.js'
import { parseSkillFile, serializeSkillFile, type SkillFile } from './skillfile.js'
import type { SkillScope } from './roots.js'

export type PendingAction =
  | 'create' | 'patch' | 'edit' | 'pin' | 'unpin' | 'delete' | 'write_file' | 'remove_file'

export interface PendingManifest {
  id: string
  action: PendingAction
  name: string
  scope: SkillScope
  root: string
  layout: SkillLayout
  /** Absolute path the action would write, or the instruction file for delete. */
  target: string
  createdAt: string
  sessionId?: string
  summary: string
  diff: string
  additions: number
  deletions: number
  /** sha256 of the target content at staging time; absent when the target must not exist. */
  baseHash?: string
  /** Content file name inside the pending dir; empty for delete/remove_file. */
  staged: string
  /** Resource path for write_file/remove_file. */
  resourcePath?: string
}

export class ApprovalError extends Error {}

const ID_PATTERN = /^[0-9a-z-]{6,64}$/
const CONTENT_FILE = 'content'
const MANIFEST_FILE = 'manifest.json'

export function pendingRoot(stateDir: string): string {
  return join(stateDir, 'pending')
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

interface Op {
  type: ' ' | '-' | '+'
  text: string
}

function diffOps(before: string, after: string): Op[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const index = i * width + j
      table[index] = a[i] === b[j]
        ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      ops.push({ type: '-', text: a[i] ?? '' })
      i += 1
    } else {
      ops.push({ type: '+', text: b[j] ?? '' })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: '-', text: a[i] ?? '' })
    i += 1
  }
  while (j < m) {
    ops.push({ type: '+', text: b[j] ?? '' })
    j += 1
  }
  return ops
}

export interface DiffResult {
  text: string
  additions: number
  deletions: number
}

/** Compact unified diff with three context lines; safe on small files. */
export function unifiedDiff(before: string, after: string, label: string): DiffResult {
  const beforeLines = before === '' ? 0 : before.split('\n').length
  const afterLines = after === '' ? 0 : after.split('\n').length
  if (beforeLines * afterLines > 1_000_000) {
    return {
      text: `(diff omitted: ${beforeLines} -> ${afterLines} lines)`,
      additions: Math.max(0, afterLines - beforeLines),
      deletions: Math.max(0, beforeLines - afterLines),
    }
  }
  const ops = diffOps(before, after)
  const changed = ops
    .map((op, index) => (op.type === ' ' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) return { text: '', additions: 0, deletions: 0 }

  const context = 3
  const hunks: Array<[number, number]> = []
  let start = Math.max(0, (changed[0] ?? 0) - context)
  let end = Math.min(ops.length, (changed[0] ?? 0) + context + 1)
  for (const index of changed.slice(1)) {
    if (index <= end + context) {
      end = Math.min(ops.length, index + context + 1)
    } else {
      hunks.push([start, end])
      start = Math.max(0, index - context)
      end = Math.min(ops.length, index + context + 1)
    }
  }
  hunks.push([start, end])

  // Position each hunk in the old and new files.
  let oldLine = 1
  let newLine = 1
  let cursor = 0
  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`]
  let additions = 0
  let deletions = 0
  for (let h = 0; h < hunks.length; h += 1) {
    const [hunkStart, hunkEnd] = hunks[h] as [number, number]
    while (cursor < hunkStart) {
      const op = ops[cursor] as Op
      if (op.type !== '+') oldLine += 1
      if (op.type !== '-') newLine += 1
      cursor += 1
    }
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (; cursor < hunkEnd; cursor += 1) {
      const op = ops[cursor] as Op
      body.push(`${op.type}${op.text}`)
      if (op.type !== '+') {
        oldCount += 1
        oldLine += 1
      }
      if (op.type !== '-') {
        newCount += 1
        newLine += 1
      }
      if (op.type === '+') additions += 1
      if (op.type === '-') deletions += 1
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine - oldCount
    const newStart = newCount === 0 ? newLine - 1 : newLine - newCount
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    lines.push(...body)
  }
  return { text: lines.join('\n'), additions, deletions }
}

async function writeManifest(dir: string, manifest: PendingManifest): Promise<void> {
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function stage(stateDir: string, manifest: PendingManifest, content?: string): Promise<PendingManifest> {
  const dir = join(pendingRoot(stateDir), manifest.id)
  await mkdir(dir, { recursive: true })
  if (content !== undefined) await writeFile(join(dir, CONTENT_FILE), content, 'utf8')
  // Manifest last: a crash mid-stage leaves an orphan content file, never a
  // manifest that points at missing bytes.
  await writeManifest(dir, manifest)
  return manifest
}

export interface StageSkillParams {
  action: 'create' | 'patch' | 'edit' | 'pin' | 'unpin'
  location: SkillLocation
  file: SkillFile
  /** Existing instruction text, required for every action but create. */
  oldText?: string
  sessionId?: string
}

/** Stage a complete SKILL.md write. */
export async function stageSkillWrite(stateDir: string, params: StageSkillParams): Promise<PendingManifest> {
  const now = new Date()
  const newText = serializeSkillFile(params.file)
  const diff = unifiedDiff(params.oldText ?? '', newText, `${params.location.name}/SKILL.md`)
  const manifest: PendingManifest = {
    id: newId(now),
    action: params.action,
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.location.filePath,
    createdAt: now.toISOString(),
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    summary: `${params.action} ${params.location.name} (${params.location.scope} scope)`,
    diff: diff.text,
    additions: diff.additions,
    deletions: diff.deletions,
    ...(params.oldText === undefined ? {} : { baseHash: hash(params.oldText) }),
    staged: CONTENT_FILE,
  }
  return stage(stateDir, manifest, newText)
}

export interface StageDeleteParams {
  location: SkillLocation
  oldText: string
  sessionId?: string
}

/** Stage a deletion (applied as an archive move). */
export async function stageDelete(stateDir: string, params: StageDeleteParams): Promise<PendingManifest> {
  const now = new Date()
  const diff = unifiedDiff(params.oldText, '', `${params.location.name}/SKILL.md`)
  const manifest: PendingManifest = {
    id: newId(now),
    action: 'delete',
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.location.filePath,
    createdAt: now.toISOString(),
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    summary: `delete ${params.location.name} -> archive (${params.location.scope} scope)`,
    diff: diff.text,
    additions: 0,
    deletions: diff.deletions,
    baseHash: hash(params.oldText),
    staged: '',
  }
  return stage(stateDir, manifest)
}

export interface StageResourceParams {
  location: SkillLocation
  relativePath: string
  target: string
  content: string
  previous?: string
  sessionId?: string
}

/** Stage a supporting-file write. */
export async function stageResourceWrite(stateDir: string, params: StageResourceParams): Promise<PendingManifest> {
  const now = new Date()
  const diff = unifiedDiff(params.previous ?? '', params.content, `${params.location.name}/${params.relativePath}`)
  const manifest: PendingManifest = {
    id: newId(now),
    action: 'write_file',
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.target,
    createdAt: now.toISOString(),
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    summary: `write_file ${params.location.name}/${params.relativePath}`,
    diff: diff.text,
    additions: diff.additions,
    deletions: diff.deletions,
    ...(params.previous === undefined ? {} : { baseHash: hash(params.previous) }),
    staged: CONTENT_FILE,
    resourcePath: params.relativePath,
  }
  return stage(stateDir, manifest, params.content)
}

/** Stage a supporting-file removal. */
export async function stageResourceRemove(
  stateDir: string,
  params: { location: SkillLocation; relativePath: string; target: string; previous: string; sessionId?: string },
): Promise<PendingManifest> {
  const now = new Date()
  const diff = unifiedDiff(params.previous, '', `${params.location.name}/${params.relativePath}`)
  const manifest: PendingManifest = {
    id: newId(now),
    action: 'remove_file',
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.target,
    createdAt: now.toISOString(),
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    summary: `remove_file ${params.location.name}/${params.relativePath}`,
    diff: diff.text,
    additions: 0,
    deletions: diff.deletions,
    baseHash: hash(params.previous),
    staged: '',
    resourcePath: params.relativePath,
  }
  return stage(stateDir, manifest)
}

/** Read one manifest, validating the id so it cannot escape the pending dir. */
export async function readPending(stateDir: string, id: string): Promise<PendingManifest | undefined> {
  if (!ID_PATTERN.test(id)) throw new ApprovalError(`invalid pending id "${id}"`)
  try {
    const raw = JSON.parse(await readFile(join(pendingRoot(stateDir), id, MANIFEST_FILE), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return undefined
    return raw as PendingManifest
  } catch {
    return undefined
  }
}

export async function listPending(stateDir: string): Promise<PendingManifest[]> {
  let ids: string[]
  try {
    ids = (await readdir(pendingRoot(stateDir))).filter((id) => ID_PATTERN.test(id))
  } catch {
    return []
  }
  const manifests: PendingManifest[] = []
  for (const id of ids) {
    const manifest = await readPending(stateDir, id)
    if (manifest !== undefined) manifests.push(manifest)
  }
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return manifests
}

function locationFromManifest(manifest: PendingManifest): SkillLocation {
  return manifest.layout === 'dir'
    ? directoryLocation(manifest.scope, manifest.root, manifest.name)
    : flatLocation(manifest.scope, manifest.root, manifest.name)
}

/** Verify the target has not drifted since staging. */
async function assertBaseUnchanged(manifest: PendingManifest): Promise<string | undefined> {
  const current = await readTextIfExists(manifest.target)
  if (manifest.action === 'create') {
    if (current !== undefined) {
      throw new ApprovalError(`"${manifest.name}" already exists; the staged create is stale`)
    }
    return undefined
  }
  if (manifest.baseHash === undefined) {
    // A resource write that creates a new file: the target must still be absent.
    if (current !== undefined) {
      throw new ApprovalError(`target ${manifest.target} appeared since this write was staged; reject it and stage again`)
    }
    return undefined
  }
  if (current === undefined) {
    throw new ApprovalError(`target ${manifest.target} no longer exists; the staged write is stale`)
  }
  if (hash(current) !== manifest.baseHash) {
    throw new ApprovalError(`target ${manifest.target} changed since this write was staged; reject it and stage again`)
  }
  return current
}

export interface ApproveOptions {
  archiveDir: string
}

/** Apply one staged write. Returns a human-readable outcome line. */
export async function approvePending(stateDir: string, id: string, options: ApproveOptions): Promise<string> {
  const manifest = await readPending(stateDir, id)
  if (manifest === undefined) throw new ApprovalError(`no pending write "${id}"`)
  await assertBaseUnchanged(manifest)
  const pendingDir = join(pendingRoot(stateDir), id)
  const location = locationFromManifest(manifest)

  switch (manifest.action) {
    case 'create': {
      const text = await readFile(join(pendingDir, manifest.staged), 'utf8')
      const file = parseSkillFile(text)
      if (file === undefined) throw new ApprovalError('staged SKILL.md no longer parses')
      await writeNewSkill(location, file, { maxSkillBytes: Number.MAX_SAFE_INTEGER })
      break
    }
    case 'patch':
    case 'edit':
    case 'pin':
    case 'unpin': {
      const text = await readFile(join(pendingDir, manifest.staged), 'utf8')
      const file = parseSkillFile(text)
      if (file === undefined) throw new ApprovalError('staged SKILL.md no longer parses')
      await writeSkillAt(location, file, { maxSkillBytes: Number.MAX_SAFE_INTEGER })
      break
    }
    case 'delete': {
      const archived = await archiveSkillAt(location, options.archiveDir, new Date())
      await rm(pendingDir, { recursive: true, force: true })
      return `deleted ${manifest.name}: archived to ${archived}`
    }
    case 'write_file': {
      const content = await readFile(join(pendingDir, manifest.staged), 'utf8')
      await writeTextAtomic(manifest.target, content)
      break
    }
    case 'remove_file': {
      await rm(manifest.target, { force: true })
      break
    }
  }
  await rm(pendingDir, { recursive: true, force: true })
  return `applied ${manifest.action} ${manifest.name} (${manifest.additions} added, ${manifest.deletions} removed)`
}

/** Drop one staged write without applying it. */
export async function rejectPending(stateDir: string, id: string): Promise<string> {
  const manifest = await readPending(stateDir, id)
  if (manifest === undefined) throw new ApprovalError(`no pending write "${id}"`)
  await rm(join(pendingRoot(stateDir), id), { recursive: true, force: true })
  return `rejected ${manifest.action} ${manifest.name}`
}

/** Remove staged writes older than the TTL. */
export async function prunePending(stateDir: string, ttlDays: number, now: Date): Promise<number> {
  if (ttlDays <= 0) return 0
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000
  let pruned = 0
  for (const manifest of await listPending(stateDir)) {
    const created = Date.parse(manifest.createdAt)
    if (Number.isFinite(created) && created < cutoff) {
      await rm(join(pendingRoot(stateDir), manifest.id), { recursive: true, force: true })
      pruned += 1
    }
  }
  return pruned
}

const APPROVAL_FILE = 'approval.json'

/** Effective approval state: the runtime override wins over the static config. */
export async function approvalEnabled(stateDir: string, fallback: boolean): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, APPROVAL_FILE), 'utf8')) as { enabled?: unknown }
    if (typeof raw.enabled === 'boolean') return raw.enabled
  } catch {
    // No override.
  }
  return fallback
}

export async function setApprovalEnabled(stateDir: string, enabled: boolean): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, APPROVAL_FILE), `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

/** Whether a target exists, exposed for staging decisions. */
export async function targetExists(path: string): Promise<boolean> {
  return pathExists(path)
}
