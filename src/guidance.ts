/**
 * Self-improvement prompt guidance.
 *
 * A nested plugin that stays pending when no `systemPrompt` service is
 * composed, so the main plugin still loads in minimal trees. The text is
 * static — cache-stable by construction. Skill catalog changes reach the model
 * through the harness's own user-role reminder, never through this section.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'self-evolve-guidance'
export const inject = ['systemPrompt']

// Tool guidance order range is 100–199 in the harness convention.
const GUIDANCE_ORDER = 160

const TEXT = [
  'Self-improvement: you can save learned procedures as skills with the skill_manage tool.',
  'After you solve a non-trivial problem — a fix found through several attempts, an error whose root cause was hard to locate, a workflow the user corrected you on — save the proven procedure with skill_manage(create): numbered steps, known pitfalls, and how to verify success.',
  'Before saving, run skill_manage(action="list") and check the catalog: if a matching skill exists, improve it with skill_manage(patch) instead of creating a duplicate. Near-duplicates are refused.',
  'Read before write: load an existing skill with the skill tool in this session before patching, editing, deleting or pinning it.',
  'When a loaded skill turns out wrong or incomplete during use, patch it in the same session while the correction is fresh.',
  'Use scope "project" for procedures specific to this repository; the default user scope is for procedures that apply everywhere.',
  'Skills store procedures. Durable facts, preferences and one-off context belong in memory or project notes, not in skills.',
  'Save selectively: a skill must be reusable and verified to have worked. Never put credentials or secrets in a skill; writes are scanned.',
].join(' ')

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'self-evolve:guidance',
    order: GUIDANCE_ORDER,
    text: TEXT,
  })
}
