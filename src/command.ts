/**
 * The `/skills` human command: review and settle staged skill writes.
 *
 * Staging without a human surface is a dead end, so the approval gate ships
 * with the only surface that a UI-less model cannot drive itself. The command
 * runs against the receiving agent and never becomes a model message.
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import {
  approvalEnabled, approvePending, listPending, readPending, rejectPending, setApprovalEnabled,
} from './approval.js'
import type { ResolvedConfig } from './config.js'

export const name = 'self-evolve-command'
export const inject = ['commands']

const USAGE = [
  'Usage: /skills [pending | diff <id> | approve <id|all> | reject <id|all> | approval on|off]',
  '',
  'pending        list staged skill_manage writes waiting for approval',
  'diff <id>      show the staged diff',
  'approve <id>   apply one staged write (or "all")',
  'reject <id>    discard one staged write (or "all")',
  'approval on    stage every skill_manage write until turned off',
].join('\n')

interface CommandInvocation {
  rawInput: string
}

type CommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

interface CommandSurface {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function failure(text: string): CommandResult {
  return { kind: 'error', text }
}

export function apply(ctx: Context, config: ResolvedConfig): void {
  const commands = (ctx as Context & { commands?: CommandSurface }).commands
  if (commands === undefined) return
  commands.register({
    name: 'skills',
    description: 'Review staged skill writes (approval gate for skill_manage)',
    input: { hint: 'pending | diff <id> | approve <id|all> | reject <id|all> | approval on|off' },
    async handler({ rawInput }: CommandInvocation) {
      const tokens = rawInput.trim().split(/\s+/).filter((token: string) => token.length > 0)
      const sub = tokens[0] ?? 'pending'
      try {
        switch (sub) {
          case 'pending': {
            const pending = await listPending(config.stateDir)
            if (pending.length === 0) return success('No staged skill writes.')
            const lines = pending.map((manifest) => {
              const when = manifest.createdAt.replace('T', ' ').slice(0, 19)
              return `${manifest.id}  ${when}  ${manifest.summary}  +${manifest.additions}/-${manifest.deletions}`
            })
            return success(`Staged skill writes (${pending.length}):\n${lines.join('\n')}\n\nApply with /skills approve <id>, discard with /skills reject <id>.`)
          }
          case 'diff': {
            const id = tokens[1]
            if (id === undefined) return failure('Usage: /skills diff <id>')
            const manifest = await readPending(config.stateDir, id)
            if (manifest === undefined) return failure(`No staged write "${id}".`)
            const diff = manifest.diff.length > 12_000
              ? `${manifest.diff.slice(0, 12_000)}\n… (truncated; open the pending manifest for the full diff)`
              : manifest.diff
            return success(`${manifest.summary}\n\n${diff === '' ? '(no textual diff)' : diff}`)
          }
          case 'approve': {
            const target = tokens[1]
            if (target === undefined) return failure('Usage: /skills approve <id|all>')
            if (target === 'all') {
              const pending = await listPending(config.stateDir)
              if (pending.length === 0) return success('No staged skill writes.')
              const outcomes: string[] = []
              for (const manifest of pending) {
                outcomes.push(await approvePending(config.stateDir, manifest.id, { archiveDir: join(config.stateDir, 'archive') }))
              }
              return success(outcomes.join('\n'))
            }
            return success(await approvePending(config.stateDir, target, { archiveDir: join(config.stateDir, 'archive') }))
          }
          case 'reject': {
            const target = tokens[1]
            if (target === undefined) return failure('Usage: /skills reject <id|all>')
            if (target === 'all') {
              const pending = await listPending(config.stateDir)
              if (pending.length === 0) return success('No staged skill writes.')
              const outcomes: string[] = []
              for (const manifest of pending) outcomes.push(await rejectPending(config.stateDir, manifest.id))
              return success(outcomes.join('\n'))
            }
            return success(await rejectPending(config.stateDir, target))
          }
          case 'approval': {
            const value = tokens[1]
            if (value !== 'on' && value !== 'off') {
              const current = await approvalEnabled(config.stateDir, config.writeApproval)
              return success(`Approval gate is ${current ? 'on' : 'off'}. Use /skills approval on|off.`)
            }
            await setApprovalEnabled(config.stateDir, value === 'on')
            return success(value === 'on'
              ? 'Approval gate on: every skill_manage write is staged until approved with /skills approve.'
              : 'Approval gate off: skill_manage writes commit immediately.')
          }
          default:
            return failure(USAGE)
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
