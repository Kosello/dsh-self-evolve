# dsh-self-evolve (fork)

Agent-authored procedural memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
the agent saves a proven procedure as a `SKILL.md` in a scanned skills root,
and `dsh-skill-filesystem` surfaces it to later sessions with progressive
disclosure for free.

This is a fork of [`jianghuife/dsh-self-evolve`](https://github.com/jianghuife/dsh-self-evolve)
(MIT), ported to DSH `0.2.1-rc.2`, hardened, and extended with the automatic
half of the loop: a post-turn reviewer that forks the conversation and decides
whether a skill should be created or patched. The upstream proof-of-concept was
0.1.0, one commit; this fork keeps its small, clean core and adds the safety
rails an unattended self-improvement loop needs.

## What the fork adds

| Concern | Upstream | This fork |
|---|---|---|
| DSH compatibility | peers pinned to `0.1.x` | `0.2.1-rc.2`, typechecked against it |
| Read before write | — | a skill must be loaded with the `skill` tool before it can be patched/edited/deleted/pinned |
| Staged approvals | — | `writeApproval` + `/skills pending / diff / approve / reject` |
| Scope | user root only | `user` (`~/.dsh/skills`) and `project` (`<project>/.dsh/skills`) |
| Layouts | `<root>/<name>/SKILL.md` | also flat `<root>/<name>.md` (read/patch/archive) |
| Duplicates | — | `create` refuses near-duplicates and points at the skill to patch |
| Credentials | — | blocking scan for keys/tokens/private-key blocks |
| Lint | — | advisory: oversized body, incident-log shape, references sprawl, destructive shell idioms |
| Discovery | — | `skill_manage(action="list")` |
| Automatic review | — | forks the completed turn and reviews it for skill updates (opt-in, budgeted) |

## Install

The plugin is a local package while it is a fork. Install it into a DSH
profile by path:

```bash
dsh plugin --profile web add /home/kosello/Documents/deepseek-harness/default-workspace/dsh-self-evolve
```

`dsh plugin add` appends the package to the profile's `dsh.profile.bundles`
and installs its dependencies. From a checkout, build first:

```bash
npm install
npm run build
dsh plugin --profile web add "$PWD"
```

Restart the profile. The row activates as `self-evolve`; log line
`self-evolve ready (...)` confirms it.

Manual alternative: add the package to the profile's `package.json`
dependencies and to `dsh.profile.bundles`, then `pnpm install`.

## Configuration

All keys are optional. Set them on the row in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: self-evolve
      name: dsh-self-evolve
      config:
        writeApproval: true      # stage every write until approved
        duplicateThreshold: 0.55 # 0 disables duplicate refusal
        review:
          enabled: true          # the reviewer spends tokens; opt in
          turnInterval: 10
          toolCallThreshold: 15
```

| Key | Default | Meaning |
|---|---|---|
| `skillsRoot` | `<dsh home>/skills` | user-scope root (must be a scanned root) |
| `stateDir` | `<dsh home>/self-evolve` | ledger, archive, staged writes |
| `staleDays` / `archiveDays` | `30` / `90` | curator thresholds |
| `curatorIntervalHours` | `24` | minimum hours between passes; `0` disables |
| `maxSkillBytes` / `maxResourceBytes` | `15360` / `65536` | per-file caps |
| `readBeforeWrite` | `true` | require a `skill` load before mutating a skill |
| `writeApproval` | `false` | stage mutating writes for human approval |
| `duplicateThreshold` | `0.55` | similarity at which `create` refuses |
| `secretScan` | `true` | block credential-shaped content |
| `lint` | `true` | advisory lint warnings |
| `projectRootMarkers` | `[".git"]` | how a project root is found above the session cwd |
| `pendingTtlDays` | `14` | staged writes expire after this |
| `guidance` | `true` | inject the static self-improvement prompt section |
| `review.enabled` | `false` | run the post-turn reviewer |
| `review.turnInterval` | `10` | review after this many completed turns |
| `review.toolCallThreshold` | `15` | or after this many tool calls since the last review |
| `review.cooldownMinutes` | `20` | minimum minutes between reviews of one session |
| `review.maxPerSession` | `8` | hard cap per session |
| `review.provider` | `fork` | subagent provider for the review child |
| `review.timeoutMinutes` | `5` | abort a review child that runs too long |

## Using it

The model gets one tool:

| Action | Purpose |
|---|---|
| `list` | show skills across both scopes, with uses and layout |
| `create` | new skill; `scope: "user" \| "project"` |
| `patch` | exact-text replace inside `SKILL.md` (preferred update) |
| `edit` | replace body/description wholesale |
| `delete` | archive (never hard-delete) |
| `write_file` / `remove_file` | supporting files inside the skill directory |
| `pin` / `unpin` | exempt a skill from curator aging |

**Read before write.** Patching from a one-line description is how a model
destroys a procedure it has not read. Any mutation of an existing skill
requires a successful `skill(name)` load in the same session; creation does
not. Disable with `readBeforeWrite: false`.

**Staged approvals.** With `writeApproval` on (statically or via
`/skills approval on`), every mutation is written to
`<stateDir>/pending/<id>/` with a diff and a content hash of the base. Nothing
reaches the skills root until a human runs:

```
/skills pending
/skills diff <id>
/skills approve <id|all>
/skills reject <id|all>
```

Approval refuses if the target changed since staging. Staged writes expire
after `pendingTtlDays`.

**Ownership.** Only skills stamped `metadata.authoredBy: dsh-self-evolve` are
mutable. Bundled, hub-installed and hand-written skills are read-only; the
curator never touches them, and project skills are never curated.

**Automatic review.** With `review.enabled` on (or `/skills review on`), a
completed turn triggers a **forked child session** once the counters say it is
due: 10 completed turns or 15 tool calls since the last review, at most one
review per 20 minutes, at most 8 per session. The child sees the finished
conversation, gets one instruction — review it for durable skill updates — and
writes through the same `skill_manage` tool, so read-before-write, duplicate
refusal, credential scan and staged approval all still apply. Its completion
never reaches the parent conversation (`delivery: "caller"`), and subagent
sessions are never reviewed.

The review child is narrowed to `skill` and `skill_manage` when the host's
tool runtime can restrict its scope; DSH has no per-activation tool filter, so
the prompt also forbids every other tool. Treat that as defence in depth, not a
sandbox, and run with `writeApproval: true` if you enable reviews on sessions
that touch untrusted content.

Cost: each review replays the conversation on your main model, so it is the
expensive part of the loop. The counters, cooldown and per-session cap exist
to bound it; `/skills review off` stops it immediately.

**Curator.** A mechanical pass marks agent-authored skills stale after
`staleDays` and archives them after `archiveDays`, restoring the file's mtime
so bookkeeping never counts as activity. Pinned skills are exempt. Nothing is
ever hard-deleted.

## Verify

```bash
npm run check   # tsc against DSH 0.2.1-rc.2
npm test        # 86 unit/integration tests
npm run build   # dist/index.js
npm run smoke   # built tool -> real dsh-skill + dsh-skill-filesystem catalog
```

The smoke test writes a skill through the built `skill_manage` tool and
asserts the real filesystem provider discovers it. Set
`DSH_SELF_EVOLVE_DEBUG=1` to print the reviewer policy when the plugin
activates (useful when checking that a composition mounts the subagent
service).

## Not included (next)

- **LLM curation.** The curator is mechanical: age, stale, archive. It does not
  vote keep/patch/consolidate on overlapping skills.
- **Memory writes.** The reviewer is skills-only by design; durable facts
  belong in whatever memory layer the profile composes (e.g. Hindsight over
  MCP), not in this plugin.
- **Per-activation tool sandbox.** Tool narrowing is post-hoc and best effort;
  see the caveat above.

## License

MIT. Upstream copyright retained in [`LICENSE`](./LICENSE); this fork's changes
are offered under the same terms.
