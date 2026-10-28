/**
 * Read-before-write tracking.
 *
 * Patching a skill the agent has not loaded in this session is how a model
 * "fixes" a skill from its one-line description and silently destroys the
 * procedure. The registry records every successful load of the harness `skill`
 * tool, keyed by the live Agent object so subagents and forks each carry their
 * own set. A WeakMap keeps this free of lifetime management.
 */

export class ReadRegistry {
  private readonly perAgent = new WeakMap<object, Set<string>>()
  private readonly anonymous = new Set<string>()

  /** Record that `agent` loaded `name` in full. */
  mark(agent: object | undefined, name: string): void {
    if (agent === undefined) {
      this.anonymous.add(name)
      return
    }
    const existing = this.perAgent.get(agent)
    if (existing === undefined) this.perAgent.set(agent, new Set([name]))
    else existing.add(name)
  }

  /** Whether `agent` loaded `name` in this session. */
  has(agent: object | undefined, name: string): boolean {
    if (agent === undefined) return this.anonymous.has(name)
    return this.perAgent.get(agent)?.has(name) === true
  }

  /** Drop the record for one agent (used by tests and explicit resets). */
  reset(agent: object | undefined): void {
    if (agent === undefined) this.anonymous.clear()
    else this.perAgent.delete(agent)
  }
}
