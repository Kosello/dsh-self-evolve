/**
 * Bounded per-session digest for the review gate.
 *
 * Jev evaluates a natural-language state, so the gate needs a compact view of
 * the finished turn. We keep only what the decision depends on — the last
 * direct-human message, the last assistant message, which skills were loaded,
 * and the turn index — and never the tool output, which is where secrets and
 * bulk data live.
 */

export interface TurnDigest {
  sessionId: string
  turn: number
  userMessage: string
  assistantMessage: string
  toolCalls: number
  skillsLoaded: readonly string[]
}

export interface SessionDigest {
  user: string
  assistant: string
  turn: number
  skills: Set<string>
}

const MAX_TEXT_CHARS = 3_000
const MAX_SESSIONS = 200
const MAX_SKILLS = 12

/** Extract plain text from a message content array. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

export function truncate(text: string, max = MAX_TEXT_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Rolling digest state, keyed by session id. */
export class DigestBuffer {
  private readonly sessions = new Map<string, SessionDigest>()

  private stateFor(sessionId: string): SessionDigest {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    const created: SessionDigest = { user: '', assistant: '', turn: 0, skills: new Set() }
    this.sessions.set(sessionId, created)
    return created
  }

  /** Record a direct-human user message; synthetic injections are ignored. */
  noteUser(sessionId: string, content: unknown, sourceKind: string | undefined): void {
    if (sourceKind !== 'user') return
    this.stateFor(sessionId).user = truncate(textOf(content))
  }

  noteAssistant(sessionId: string, content: unknown): void {
    this.stateFor(sessionId).assistant = truncate(textOf(content))
  }

  noteTurn(sessionId: string, turn: number): void {
    const state = this.stateFor(sessionId)
    state.turn = turn
    state.skills.clear()
  }

  noteSkill(sessionId: string, name: string): void {
    const state = this.stateFor(sessionId)
    if (state.skills.size >= MAX_SKILLS) return
    state.skills.add(name)
  }

  /** Build the gate input; undefined when the session produced nothing reviewable. */
  build(sessionId: string, toolCalls: number): TurnDigest | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return undefined
    if (state.user === '' && state.assistant === '') return undefined
    return {
      sessionId,
      turn: state.turn,
      userMessage: state.user,
      assistantMessage: state.assistant,
      toolCalls,
      skillsLoaded: [...state.skills],
    }
  }

  /** Clear the per-turn skill set after a gate decision. */
  clearSkills(sessionId: string): void {
    this.sessions.get(sessionId)?.skills.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}
