/**
 * The model-facing `skill_manage` tool.
 *
 * This is the online half of the self-improvement loop: the agent saves a
 * proven procedure as a SKILL.md in a scanned skills root, and
 * `dsh-skill-filesystem` surfaces it in later sessions with progressive
 * disclosure for free.
 *
 * M1 hardening on top of the upstream tool:
 * - `list` so the model can see what exists before creating a duplicate;
 * - project scope, resolved from the session cwd;
 * - read-before-write (mutating an unloaded skill is refused);
 * - duplicate detection on create;
 * - credential scan (blocking) and advisory lint (warnings);
 * - optional staged writes for human approval.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import type { ResolvedConfig } from './config.js'
import { findDuplicates } from './dedupe.js'
import { ReadRegistry } from './guards.js'
import {
  approvalEnabled, listPending, stageDelete, stageResourceRemove, stageResourceWrite,
  stageSkillWrite,
} from './approval.js'
import { blockingIssues, formatIssues, scanDangerous, scanSecrets, scanSkill, type Issue } from './lint.js'
import { loadLedger, recordUse, saveLedger } from './ledger.js'
import { resolveSkillRoots, rootForScope, type SkillRoots, type SkillScope } from './roots.js'
import {
  archiveSkillAt, directoryLocation, listSkills, locateSkill, readOwnedSkillAt,
  readTextIfExists, removeResourceAt, resourceTarget,
  writeNewSkill, writeResourceAt, writeSkillAt,
  type SkillEntry, type SkillLocation,
} from './store.js'
import {
  isValidSkillName, parseSkillFile, serializeSkillFile, stampMetadata, withPinned,
  type SkillFile,
} from './skillfile.js'

const ACTIONS = ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'pin', 'unpin', 'list'] as const
type Action = (typeof ACTIONS)[number]

const MUTATING_ACTIONS: readonly Action[] = ['patch', 'edit', 'delete', 'write_file', 'remove_file', 'pin', 'unpin']

function applyPatch(file: SkillFile, find: string, replace: string): SkillFile {
  const text = serializeSkillFile(file)
  const first = text.indexOf(find)
  if (first === -1) {
    throw new Error('patch "find" text not found in the skill — load the skill and copy the exact text')
  }
  if (text.indexOf(find, first + 1) !== -1) {
    throw new Error('patch "find" text matches more than once — include more surrounding context to make it unique')
  }
  const patchedText = text.slice(0, first) + replace + text.slice(first + find.length)
  // Re-parse through the same path create uses; a patch that breaks the
  // frontmatter is refused instead of written.
  const patched = parseSkillFile(patchedText)
  if (patched === undefined) {
    throw new Error('patch would corrupt the SKILL.md structure (frontmatter must remain valid YAML with name and description)')
  }
  return patched
}


interface AgentShape {
  id?: unknown
  session?: { header?: { cwd?: unknown } }
}

function sessionCwd(exec: { agent?: unknown }): string | undefined {
  const cwd = (exec.agent as AgentShape | undefined)?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function sessionId(exec: { agent?: unknown }): string | undefined {
  const id = (exec.agent as AgentShape | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

async function touchLedger(config: ResolvedConfig, name: string): Promise<void> {
  const ledger = await loadLedger(config.stateDir)
  recordUse(ledger, name, new Date())
  await saveLedger(config.stateDir, ledger)
}

function warningText(issues: readonly Issue[]): string {
  const warnings = issues.filter((issue) => issue.severity === 'warn')
  if (warnings.length === 0) return ''
  return `\n\nLint warnings:\n${formatIssues(warnings)}`
}

function describeEntries(entries: readonly SkillEntry[]): string {
  return entries
    .map((entry) => {
      const description = entry.file.frontmatter.description.replace(/\s+/g, ' ').trim()
      const short = description.length > 90 ? `${description.slice(0, 87)}…` : description
      return `- ${entry.name} [${entry.location.scope}/${entry.location.layout}] ${short}`
    })
    .join('\n')
}

function readGuardMessage(name: string): string {
  return `Skill "${name}" has not been loaded in this session. Call skill(name="${name}") first — patching from the catalog description alone destroys the procedure. (Set readBeforeWrite=false to disable this guard.)`
}

function approvalMessage(manifest: { id: string; summary: string; additions: number; deletions: number }): string {
  return `Staged for approval: ${manifest.summary} (+${manifest.additions}/-${manifest.deletions}, id ${manifest.id}). Nothing has been written. Run /skills pending to review, /skills approve ${manifest.id} to apply, or /skills reject ${manifest.id} to discard.`
}

interface WriteContext {
  config: ResolvedConfig
  roots: SkillRoots
  exec: ToolRunContext
  reads: ReadRegistry
}

/** Commit (or stage) one complete SKILL.md write and record the use. */
async function commitSkillWrite(
  write: WriteContext,
  action: 'create' | 'patch' | 'edit' | 'pin' | 'unpin',
  location: SkillLocation,
  file: SkillFile,
  options: { oldText?: string; warnings: string },
): Promise<string> {
  const approval = await approvalEnabled(write.config.stateDir, write.config.writeApproval)
  const verb = action === 'create' ? 'saved' : 'updated'
  if (approval) {
    const manifest = await stageSkillWrite(write.config.stateDir, {
      action,
      location,
      file,
      ...(options.oldText === undefined ? {} : { oldText: options.oldText }),
      ...(sessionId(write.exec) === undefined ? {} : { sessionId: sessionId(write.exec) }),
    })
    return approvalMessage(manifest)
  }
  if (action === 'create') {
    await writeNewSkill(location, file, { maxSkillBytes: write.config.maxSkillBytes })
  } else {
    await writeSkillAt(location, file, { maxSkillBytes: write.config.maxSkillBytes })
  }
  write.reads.mark(write.exec.agent, file.frontmatter.name)
  await touchLedger(write.config, file.frontmatter.name)
  const where = `${location.scope} scope at ${location.filePath}`
  return `Skill "${file.frontmatter.name}" ${verb} (${where}).${options.warnings}`
}

/** Register the skill_manage tool on `ctx.tools`. */
export function registerSkillManageTool(ctx: Context, config: ResolvedConfig): void {
  const reads = new ReadRegistry()

  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: [
      'Save or maintain a learned skill (a reusable procedure) so future sessions follow it instead of rediscovering it.',
      'Use after a non-trivial problem: a multi-step fix found by trial and error, an error whose cause was hard to find, or a workflow the user corrected.',
      'A skill stores a PROCEDURE (steps, pitfalls, verification) — durable facts belong in memory or project notes, not here.',
      'Actions: list (what exists), create (new skill), patch (exact-text replace; PREFER this for small updates), edit (replace body/description), delete (archives, never destroys), write_file / remove_file (supporting files), pin / unpin (protect from curation).',
      'Read before write: load an existing skill with the skill tool in this session before patching, editing, deleting or pinning it.',
      'Scope: create with scope "user" (default, ~/.dsh/skills) or "project" (<project>/.dsh/skills).',
      'Only skills created through this tool can be modified; bundled and human-authored skills are read-only.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'What to do' },
      name: { type: 'string', description: 'Skill name in kebab-case, e.g. "debug-oomkilled-pods" (omit only for list)' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'create: which root to write to (default user)' },
      description: { type: 'string', description: 'create/edit: one sentence stating what the skill does and when to use it (what future sessions match against)' },
      when_to_use: { type: 'string', description: 'create/edit: optional extra trigger guidance' },
      body: { type: 'string', description: 'create/edit: numbered procedure, pitfalls, and how to verify success' },
      find: { type: 'string', description: 'patch: exact existing text to replace (must match exactly once)' },
      replace: { type: 'string', description: 'patch: replacement text' },
      path: { type: 'string', description: 'write_file/remove_file: resource path relative to the skill directory, e.g. "scripts/check.sh"' },
      content: { type: 'string', description: 'write_file: full file content' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const action = args.action as Action
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const write: WriteContext = {
        config,
        roots: await resolveSkillRoots(config.skillsRoot, sessionCwd(exec), config.projectRootMarkers),
        exec,
        reads,
      }
      try {
        if (action === 'list') {
          const entries = await listSkills(write.roots)
          const pending = await listPending(config.stateDir)
          const pendingLine = pending.length === 0
            ? ''
            : `\n\n${pending.length} staged write(s) awaiting approval — /skills pending.`
          if (entries.length === 0) {
            return `No skills found in the user or project roots.${pendingLine}`
          }
          const ledger = await loadLedger(config.stateDir)
          const body = entries.map((entry) => {
            const uses = ledger.skills[entry.name]?.uses ?? 0
            return describeEntries([entry]) + ` (uses: ${uses})`
          }).join('\n')
          return `Skills (${entries.length}):\n${body}${pendingLine}`
        }

        if (!isValidSkillName(name)) {
          return `Invalid skill name "${name}": use kebab-case (lowercase letters, digits, hyphens), max 64 chars.`
        }

        if (MUTATING_ACTIONS.includes(action)) {
          const location = await locateSkill(write.roots, name)
          if (location === undefined) {
            return `No skill named "${name}" exists in the user or project roots.`
          }
          if (config.readBeforeWrite && !reads.has(exec.agent, name)) {
            return readGuardMessage(name)
          }

          switch (action) {
            case 'patch': {
              if (args.find === undefined || args.replace === undefined) {
                return 'patch requires "find" and "replace".'
              }
              const file = await readOwnedSkillAt(location)
              const patched = stampMetadata(applyPatch(file, args.find, args.replace), { now: new Date().toISOString() })
              const issues = scanSkill(patched, { secretScan: config.secretScan, lint: config.lint })
              const blocking = blockingIssues(issues)
              if (blocking.length > 0) {
                return `skill_manage patch refused:\n${formatIssues(blocking)}`
              }
              return await commitSkillWrite(write, 'patch', location, patched, {
                oldText: await readTextIfExists(location.filePath),
                warnings: warningText(issues),
              })
            }
            case 'edit': {
              if (args.body === undefined && args.description === undefined && args.when_to_use === undefined) {
                return 'edit requires at least one of "body", "description" or "when_to_use".'
              }
              const file = await readOwnedSkillAt(location)
              const edited = stampMetadata({
                frontmatter: {
                  ...file.frontmatter,
                  ...(args.description === undefined ? {} : { description: args.description }),
                  ...(args.when_to_use === undefined ? {} : { whenToUse: args.when_to_use }),
                },
                body: args.body ?? file.body,
              }, { now: new Date().toISOString() })
              const issues = scanSkill(edited, { secretScan: config.secretScan, lint: config.lint })
              const blocking = blockingIssues(issues)
              if (blocking.length > 0) {
                return `skill_manage edit refused:\n${formatIssues(blocking)}`
              }
              return await commitSkillWrite(write, 'edit', location, edited, {
                oldText: await readTextIfExists(location.filePath),
                warnings: warningText(issues),
              })
            }
            case 'pin':
            case 'unpin': {
              const file = await readOwnedSkillAt(location)
              const pinned = withPinned(file, action === 'pin')
              return await commitSkillWrite(write, action, location, pinned, {
                oldText: await readTextIfExists(location.filePath),
                warnings: '',
              })
            }
            case 'delete': {
              const file = await readOwnedSkillAt(location)
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageDelete(config.stateDir, {
                  location,
                  oldText: serializeSkillFile(file),
                  ...(sessionId(exec) === undefined ? {} : { sessionId: sessionId(exec) }),
                })
                return approvalMessage(manifest)
              }
              const archived = await archiveSkillAt(location, join(config.stateDir, 'archive'), new Date())
              return `Skill "${name}" archived to ${archived}. Nothing is hard-deleted; a human can restore it.`
            }
            case 'write_file': {
              if (args.path === undefined || args.content === undefined) {
                return 'write_file requires "path" and "content".'
              }
              await readOwnedSkillAt(location)
              const target = resourceTarget(location, args.path)
              const issues = [
                ...(config.secretScan ? scanSecrets(args.content) : []),
                ...scanDangerous(args.content),
              ]
              const blocking = blockingIssues(issues)
              if (blocking.length > 0) {
                return `skill_manage write_file refused:\n${formatIssues(blocking)}`
              }
              const previous = await readTextIfExists(target)
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageResourceWrite(config.stateDir, {
                  location,
                  relativePath: args.path,
                  target,
                  content: args.content,
                  ...(previous === undefined ? {} : { previous }),
                  ...(sessionId(exec) === undefined ? {} : { sessionId: sessionId(exec) }),
                })
                return approvalMessage(manifest)
              }
              await writeResourceAt(location, args.path, args.content, { maxResourceBytes: config.maxResourceBytes })
              return `Resource "${args.path}" written inside skill "${name}".${warningText(issues)}`
            }
            case 'remove_file': {
              if (args.path === undefined) return 'remove_file requires "path".'
              await readOwnedSkillAt(location)
              const target = resourceTarget(location, args.path)
              const previous = await readTextIfExists(target)
              if (previous === undefined) {
                return `No resource "${args.path}" exists inside skill "${name}".`
              }
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageResourceRemove(config.stateDir, {
                  location,
                  relativePath: args.path,
                  target,
                  previous,
                  ...(sessionId(exec) === undefined ? {} : { sessionId: sessionId(exec) }),
                })
                return approvalMessage(manifest)
              }
              await removeResourceAt(location, args.path)
              return `Resource "${args.path}" removed from skill "${name}".`
            }
            default:
              break
          }
          return `Unknown action "${String(action)}".`
        }

        if (action !== 'create') {
          return `Unknown action "${String(action)}".`
        }

        // create
        if (args.description === undefined || args.body === undefined) {
          return 'create requires "description" and "body".'
        }
        const existing = await locateSkill(write.roots, name)
        if (existing !== undefined) {
          return `Skill "${name}" already exists at ${existing.filePath} (${existing.scope} scope, ${existing.layout} layout). Use patch or edit instead.`
        }

        const entries = await listSkills(write.roots)
        const duplicates = findDuplicates(
          name,
          args.description,
          entries.map((entry) => ({
            name: entry.name,
            description: entry.file.frontmatter.description,
            scope: entry.location.scope,
          })),
          config.duplicateThreshold,
        )
        if (duplicates.length > 0) {
          const candidates = duplicates
            .map((match) => `- ${match.name} (${match.scope}, score ${match.score.toFixed(2)}): ${match.description.slice(0, 100)}`)
            .join('\n')
          return [
            `Refusing to create "${name}": it overlaps existing skills.`,
            candidates,
            'Patch the closest umbrella with skill_manage(action="patch", name="<name>") instead of adding a near-duplicate.',
          ].join('\n')
        }

        const scope: SkillScope = args.scope === 'project' ? 'project' : 'user'
        const root = rootForScope(write.roots, scope)
        const location = directoryLocation(scope, root, name)
        const file = stampMetadata({
          frontmatter: {
            name,
            description: args.description,
            ...(args.when_to_use === undefined ? {} : { whenToUse: args.when_to_use }),
          },
          body: args.body,
        }, { now: new Date().toISOString(), create: true })
        const issues = scanSkill(file, { secretScan: config.secretScan, lint: config.lint })
        const blocking = blockingIssues(issues)
        if (blocking.length > 0) {
          return `skill_manage create refused:\n${formatIssues(blocking)}`
        }
        return await commitSkillWrite(write, 'create', location, file, { warnings: warningText(issues) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `skill_manage ${action} failed: ${message}`
      }
    },
  }))

  // Usage tracking + read-before-write marking: every successful load through
  // the harness `skill` tool counts as a use of a skill this root owns.
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'skill' || result.isError) return
    const skillName = (exec.arguments as { name?: unknown } | null | undefined)?.name
    if (typeof skillName !== 'string' || !isValidSkillName(skillName)) return
    reads.mark(exec.agent, skillName)
    void (async () => {
      const location = await locateSkill(
        await resolveSkillRoots(config.skillsRoot, sessionCwd(exec), config.projectRootMarkers),
        skillName,
      ).catch(() => undefined)
      if (location === undefined) return
      await touchLedger(config, skillName)
    })().catch((error: unknown) => {
      ctx.logger.warn('self-evolve usage tracking failed for %s: %s', skillName, String(error))
    })
  })
}
