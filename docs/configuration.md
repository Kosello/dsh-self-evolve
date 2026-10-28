# Configuration reference

All keys are optional. Override them on the `self-evolve` row in your profile's
`cordis.patch.yml`:

```yaml
- id: self-evolve
  config:
    writeApproval: true
    review:
      enabled: true
      gate: jev
```

## Skill store and curator

| Key | Default | Meaning |
|---|---|---|
| `skillsRoot` | `<dsh home>/skills` | user-scope root the agent writes to; must be a root the harness scans |
| `stateDir` | `<dsh home>/self-evolve` | ledger, archive, staged writes, gate log |
| `staleDays` | `30` | days without use before the curator marks a skill stale |
| `archiveDays` | `90` | days without use before the curator archives it |
| `curatorIntervalHours` | `24` | minimum hours between curator passes; `0` disables the curator |
| `maxSkillBytes` | `15360` | cap on a serialized `SKILL.md` |
| `maxResourceBytes` | `65536` | cap on one supporting file |
| `pendingTtlDays` | `14` | staged writes expire after this many days |

The curator only ever touches user-scope skills stamped
`metadata.authoredBy: dsh-self-evolve`. Bundled, hand-written and project skills
are left alone. Deletion is always an archive move into `<stateDir>/archive`.

## Write guards

| Key | Default | Meaning |
|---|---|---|
| `readBeforeWrite` | `true` | require a successful `skill` load before mutating an existing skill |
| `writeApproval` | `false` | stage every mutating write until a human approves it |
| `duplicateThreshold` | `0.55` | similarity at which `create` refuses a near-duplicate; `0` disables |
| `secretScan` | `true` | block writes whose text contains credential-shaped strings |
| `lint` | `true` | emit advisory warnings (oversized body, incident-log shape, references sprawl, destructive idioms) |
| `projectRootMarkers` | `[".git"]` | markers used to find a project root above the session cwd |

`writeApproval` can also be toggled at runtime with `/skills approval on|off`;
the runtime value is stored in `<stateDir>/approval.json` and wins over the
static config.

## Prompt guidance

| Key | Default | Meaning |
|---|---|---|
| `guidance` | `true` | inject the static self-improvement section into the system prompt |

The section is static text (cache-stable); it tells the model when to save or
patch a skill and to read before writing.

## Post-turn reviewer

| Key | Default | Meaning |
|---|---|---|
| `review.enabled` | `false` | run the reviewer at all; it spends tokens |
| `review.turnInterval` | `10` | review after this many completed turns |
| `review.toolCallThreshold` | `15` | or after this many tool results since the last review |
| `review.cooldownMinutes` | `20` | minimum minutes between reviews of one session |
| `review.maxPerSession` | `8` | hard cap per session |
| `review.provider` | `fork` | subagent provider used for the review child |
| `review.timeoutMinutes` | `5` | abort a review child that runs longer than this |

Reviews run only for top-level sessions and only after a `completed` turn.
Subagent sessions never review. `/skills review on|off` overrides
`review.enabled` at runtime (`<stateDir>/review.json`), and
`/skills review now` forces one review for the current session.

## Review gate

The gate decides whether a review that counters already consider due is worth
paying for. `counters` keeps the pre-gate behaviour; `jev` adds one TypeSafe
System One call.

| Key | Default | Meaning |
|---|---|---|
| `review.gate` | `counters` | `counters` or `jev` |
| `review.jev.model` | `jev-latest` | Jev model id or alias |
| `review.jev.baseURL` | `https://api.typesafe.ai` | TypeSafe API root |
| `review.jev.apiKeyEnv` | `TYPESAFE_API_KEY` | environment variable holding the key |
| `review.jev.timeoutMs` | `2000` | per-attempt timeout |
| `review.jev.confidentNo` | `0.75` | skip only when Jev answers "no" with at least this confidence |
| `review.jev.cooldownMinutes` | `5` | minimum minutes between gate calls per session |

The gate can only cancel a review. A missing key, a malformed answer, a
timeout, an HTTP error or an open circuit all fall back to running the review.
See [review-loop.md](review-loop.md) for the decision mapping and the log.

## Runtime files

| Path | Contents |
|---|---|
| `<stateDir>/usage.json` | per-skill last use/count and the last curator run |
| `<stateDir>/gates.jsonl` | one JSON line per gate decision, including the threshold in force |
| `<stateDir>/pending/` | staged writes awaiting `/skills approve` |
| `<stateDir>/archive/` | archived skills, recoverable |
| `<stateDir>/approval.json` | runtime override for the approval gate |
| `<stateDir>/review.json` | runtime override for the reviewer toggle |

## Environment variables

| Variable | Used by |
|---|---|
| `TYPESAFE_API_KEY` (name configurable) | Jev gate |
| `DSH_SELF_EVOLVE_DEBUG=1` | prints the reviewer policy at plugin activation |

Secrets belong in a mode-`600` env file referenced by the service's
`EnvironmentFile`, not in the profile YAML. See
[installation.md](installation.md#environment-key-for-the-jev-gate).
