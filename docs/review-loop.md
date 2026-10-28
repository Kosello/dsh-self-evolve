# The review loop

Two decisions are deliberately separated:

- **Counters** decide *when the loop is allowed to review* — cheap,
  deterministic, offline.
- **The gate** (optional) decides *whether a due review is worth paying for* —
  one classifier call, with a deterministic fallback.

The reviewer itself is the only part that writes skills.

## When a review runs

Reviews are considered only for a **top-level agent** (`origin !== 'subagent'`,
delegation depth 0) and only after a `completed` turn. A review runs when all
hold:

1. `review.enabled` is true (or `/skills review on` was used).
2. Counters are due: `turns ≥ turnInterval` (default 10) **or**
   `tools ≥ toolCallThreshold` (default 15).
3. The review cooldown elapsed: `cooldownMinutes` (default 20) since the last
   review.
4. The session has not spent its budget: `maxPerSession` (default 8).
5. No review is already in flight.

A skipped or successful review resets the turn/tool counters. Non-completed
turns, aborted turns and subagent sessions do not count.

`/skills review now` bypasses 1–4 for one review; the budget and the single
in-flight rule still apply.

## The review child

The reviewer is a **forked subagent**, not an injected message:

- It is started on `session/event` → `turn/end`, after a zero-delay tick so the
  finished turn is part of the fork seed.
- `delivery: 'caller'` means its final output returns to the caller and never
  enters the parent conversation or inbox.
- The child sees the completed conversation; the in-flight turn is never in the
  seed.
- It runs the review prompt: decide whether the turn holds a durable lesson,
  then patch a loaded skill first, patch an existing umbrella second, create a
  new class-level skill third, or answer `no skill update`.
- It is narrowed to `skill` + `skill_manage` right after activation. DSH has no
  per-activation tool filter, so this is best effort; the prompt also forbids
  every other tool.
- It is aborted after `timeoutMinutes` (default 5).

All writes go through `skill_manage`, so read-before-write, duplicate refusal,
credential scanning, lint and staged approval apply exactly as they do for the
main agent.

## The gate

`review.gate` selects the implementation:

| Gate | Behaviour |
|---|---|
| `counters` | no-op; the counters already decided |
| `jev` | one TypeSafe System One call over a bounded digest; may cancel |

The digest contains the last **direct-human** user message, the last assistant
message, the number of tool results since the last review, the names of skills
loaded during the turn, and the turn index. Both texts are truncated to 3,000
characters. **Tool output is never sent**, which is where secrets and bulk data
live.

The request asks one three-way `choice` question:

> Does this turn contain a durable, reusable lesson — a correction or standing
> preference, a non-trivial procedure that succeeded after trial and error, or a
> loaded skill that proved wrong? (`yes` / `no` / `unclear`)

Decision mapping (`decisionFromAnswer`):

| Answer | Result |
|---|---|
| `no` with `confidence ≥ confidentNo` (default 0.75) | **skip** the review |
| `no` with lower confidence | review |
| `yes` | review |
| `unclear` | review |
| missing/malformed answer | fall back to review |

The asymmetry is intentional: the gate can only cancel a review it is confident
is pointless, so a wrong answer costs at most the pre-gate behaviour.

Operational guards:

- One gate call per session per `jev.cooldownMinutes` (default 5).
- Gate requests time out after `jev.timeoutMs` (default 2 s per attempt).
- 429/5xx are retried once; other HTTP statuses and network failures fall back.
- Three consecutive failures open a circuit breaker for the process.
- A missing key (or an empty `apiKeyEnv`) keeps the gate on `counters` after one
  startup warning.

## Observability

Every gate decision appends one line to `<stateDir>/gates.jsonl`:

```json
{"at":"2026-10-28T15:48:45.785Z","session":"…","turn":4,"decision":"review",
 "source":"jev","reason":"yes (confidence 0.92)","choice":"yes",
 "confidence":0.92,"probability":0.95,"toolCalls":25,"latencyMs":239,
 "threshold":0.75}
```

`source: "counters"` with a `reason` starting `fallback:` means the gate did not
run and the review proceeded. The `threshold` records the `confidentNo` in
force, which makes the log replayable under different settings.

Summarize and compare thresholds:

```bash
npm run gate-stats
# or
node scripts/gate-stats.mjs /path/to/gates.jsonl
```

It prints the decision split, `no`-confidence percentiles, fallback reasons,
latency, and how many decisions each candidate threshold would have skipped.
The log cannot tell you whether a skipped turn actually deserved a skill, so
the threshold choice stays human:

- **Raise** `confidentNo` when a skipped turn later turned out to carry a lesson.
- **Lower** it when reviews keep running and finding nothing.
- Set it to `1` to keep the gate observing (and logging) without ever cancelling.

## Cost

- The gate is cheap: a digest of a few hundred to a few thousand tokens; at the
  time of writing TypeSafe charges per input token, output is free.
- The reviewer is the expensive part: it replays the conversation on the parent
  model. The counters, cooldown and per-session cap exist to bound this.
- `/skills review off` stops automatic reviews immediately; the tool and
  command surface stay available.

## Recommended rollout

1. Install with `review.enabled: false`, use the tool manually for a week.
2. Turn the reviewer on with `writeApproval: true` and `gate: counters`.
3. Read `/skills pending` and the resulting skills; tighten the guidance or the
   duplicate threshold if the library drifts.
4. Enable `gate: jev`, let it log for a week, then tune `confidentNo` from
   `gates.jsonl`.
