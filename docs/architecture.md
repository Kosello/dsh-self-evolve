# Architecture

The plugin is one Cordis bundle (`self-evolve`) with a small set of modules and
three nested plugins that stay pending when their services are absent, so a
minimal tree still loads.

## Module map

| Module | Role |
|---|---|
| `src/index.ts` | plugin entry (`inject: ['tools']`), wiring, curator timer, pending prune |
| `src/config.ts` | schemastery schema and resolved defaults |
| `src/roots.ts` | project-root discovery and the user/project root pair |
| `src/skillfile.ts` | `SKILL.md` frontmatter parse/serialize, authorship stamp, pin and status |
| `src/store.ts` | locations, atomic writes, ownership gate, listing, archiving, resources |
| `src/guards.ts` | `ReadRegistry`: which agent loaded which skill (WeakMap) |
| `src/approval.ts` | staged-write manifests, unified diff, approve/reject, drift check |
| `src/dedupe.ts` | lexical name/description similarity for duplicate refusal |
| `src/lint.ts` | credential scan, destructive-idiom warnings, advisory lint |
| `src/digest.ts` | bounded per-session digest for the review gate |
| `src/gate.ts` | counters/Jev gates, decision mapping, circuit breaker, gate log |
| `src/review.ts` | counters, `turn/end` hook, fork activation, child tool restriction, `/skills review` controller |
| `src/command.ts` | the human `/skills` command (nested plugin, `inject: ['commands']`) |
| `src/guidance.ts` | static system-prompt section (nested plugin, `inject: ['systemPrompt']`) |
| `src/curator.ts` | mechanical stale/archive lifecycle, user scope only |
| `src/ledger.ts` | `usage.json`: per-skill use counts and last curator run |

## On-disk contract

```
~/.dsh/skills/<name>/SKILL.md          user scope, directory package
~/.dsh/skills/<name>.md                user scope, flat file
<project>/.dsh/skills/…                project scope, repo-owned
~/.dsh/self-evolve/usage.json          ledger
~/.dsh/self-evolve/gates.jsonl         gate decisions
~/.dsh/self-evolve/approval.json       runtime approval override
~/.dsh/self-evolve/review.json         runtime reviewer override
~/.dsh/self-evolve/pending/<id>/       staged write + manifest.json
~/.dsh/self-evolve/archive/            archived skills
```

Skills are ordinary Markdown files under roots that `dsh-skill-filesystem`
already scans, so no separate catalog or index exists. The harness's provider
watches the roots and refreshes the catalog; the first-party `write`/`edit`
tools also invalidate it directly.

Every file this plugin writes carries `metadata.authoredBy: dsh-self-evolve`,
plus `createdAt`, `updatedAt` and `version`. That stamp is the ownership gate:
only stamped skills can be mutated, so bundled, hub-installed and hand-written
skills are read-only.

## Entry and activation

`index.ts` resolves config, registers `skill_manage`, and mounts:

- `guidance` — system-prompt text, only where `systemPrompt` exists;
- `review` — needs `agents` and `subagents`; otherwise pending;
- `command` — needs `commands`; otherwise pending.

A curator pass is scheduled with `setTimeout(30s)` inside `ctx.effect`, so
plugin teardown/HMR cancels it. Staged writes older than `pendingTtlDays` are
pruned at startup.

## Tool execution path

1. The model calls `skill_manage`.
2. The tool resolves the session cwd from `exec.agent.session.header.cwd` and
   builds the user/project roots.
3. Mutations locate the winning skill (project before user, directory before
   flat), then enforce ownership and read-before-write.
4. Content is linted and scanned before any write.
5. Depending on `writeApproval`, the new bytes are either staged under
   `pending/<id>/` with a diff and base hash, or written atomically
   (temp file + rename).
6. A successful write marks the skill as read and records a use in the ledger.

`tools/result` observers feed two side channels: the read registry (for `skill`
loads) and the digest buffer (last user/assistant message, loaded skill names).

## Reviewer lifecycle

```
session/event  turn/end (completed)
        │
        ├─ root agent only, reviewer enabled, not in flight
        ├─ counters: turns ≥ turnInterval or tools ≥ toolCallThreshold
        ├─ cooldown (review) and budget (maxPerSession)
        ├─ optional gate.decide(digest)        ← Jev or counters
        └─ subagents.startActivation({ provider: 'fork', delivery: 'caller' })
                │
                └─ child runs the review prompt with skill/skill_manage
```

The child is forked after `turn/end` (plus a zero-delay tick so the seed
includes the closed turn), so it sees the finished conversation but never the
in-flight one. `delivery: 'caller'` keeps its completion notice out of the
parent inbox. `agent.session.header.origin === 'subagent'` excludes children
from ever being reviewed again.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Jev missing key / HTTP / timeout / malformed | fall back to running the review, log `fallback:` |
| Three consecutive gate failures | circuit opens for the process |
| Subagent provider refuses | logged, counters restored, no review |
| Review child overruns `timeoutMinutes` | aborted |
| Approval target drifted | approve refuses, staged write stays for inspection |
| Write through a symlink | refused |
| Curator error | logged; next pass retries |

## Tests

`tests/` covers the store and layout rules, ownership, resources, curator
transitions, read registry, duplicate scoring, lint/secret rules, staging and
approval drift, digest construction, the gate's decision mapping and failure
paths, the reviewer trigger/wiring, the `/skills` command, and a smoke test that
writes through the built tool and reads the skill back through the real
`dsh-skill` + `dsh-skill-filesystem` providers.
