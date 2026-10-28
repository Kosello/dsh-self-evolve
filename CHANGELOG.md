# Changelog

## 0.4.0 — 2026-10-28

- **Jev gate (M3a).** Optional `review.gate: "jev"`: one TypeSafe System One
  call over a bounded digest can cancel a review it is confidently sure is
  pointless. Confident `no` skips; everything else reviews. Per-session gate
  cooldown, 2 s timeout, one retry on 429/5xx, three-failure circuit breaker.
- Gate decisions are appended to `gates.jsonl` with the active `confidentNo`.
- `scripts/gate-stats.mjs` (`npm run gate-stats`) summarizes decisions and
  compares thresholds.
- Missing `TYPESAFE_API_KEY` degrades to counters with one warning.

## 0.3.0 — 2026-10-28

- **Post-turn reviewer (M2).** Forks a completed turn into a subagent seeded
  with the conversation and asks it to patch or create skills. Top-level
  sessions only, completed turns only, one review at a time.
- Per-session counters (turns/tool calls), review cooldown, per-session budget
  and a hard timeout.
- Best-effort narrowing of the review child to `skill` + `skill_manage`.
- `/skills review on|off|now` runtime controls.

## 0.2.0 — 2026-10-28

- Fork of upstream `dsh-self-evolve` 0.1.0, ported to DSH `0.2.1-rc.2`
  (typechecked, 24 upstream tests kept passing).
- Read-before-write enforcement keyed by the live agent.
- Staged write approval with unified diffs, base-content hashes and a `/skills`
  command surface.
- Project scope (`<project>/.dsh/skills`) and flat `<name>.md` skills.
- Duplicate detection on `create`.
- Blocking credential scan and advisory linter.
- Curator restricted to user-scope agent-authored skills.
- Provider pickup smoke test.

## 0.1.0 — upstream

- `skill_manage` tool for agent-authored skills.
- Static prompt guidance.
- Mechanical curator with stale/archive transitions.
- Usage ledger.
