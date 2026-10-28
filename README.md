# dsh-self-evolve

**Agent-authored procedural memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
The agent saves a proven procedure as a `SKILL.md` in a root the harness already
scans, and future sessions follow it instead of rediscovering it — with the
guards, budgets and approvals an unattended self-improvement loop needs.

This is a fork of [`jianghuife/dsh-self-evolve`](https://github.com/jianghuife/dsh-self-evolve)
(MIT), ported to DSH `0.2.1-rc.2` and extended. The upstream proof of concept was
a single 0.1.0 release; this fork keeps its small core and adds the missing
safety rails plus the automatic half of the loop.

> Status: `0.4.0`, 106 tests, typechecked against DSH `0.2.1-rc.2`. Not published
> to npm; install from GitHub or a local checkout.

## What it does

| Capability | Details |
|---|---|
| **`skill_manage` tool** | `list`, `create`, `patch`, `edit`, `delete` (archives), `write_file`, `remove_file`, `pin`, `unpin` |
| **User + project scope** | `~/.dsh/skills` and `<project>/.dsh/skills`, plus flat `<name>.md` skills |
| **Read before write** | a skill must be loaded with the `skill` tool before it can be patched, edited, deleted or pinned |
| **Duplicate refusal** | `create` rejects near-duplicates and names the skill to patch instead |
| **Credential + lint scan** | blocks credential-shaped text; warns on oversized bodies, incident-log shape, references sprawl, destructive shell idioms |
| **Staged approvals** | optional `writeApproval`; review diffs with `/skills pending`, settle with `approve`/`reject` |
| **Post-turn reviewer** | opt-in fork of the finished turn that patches or creates skills, isolated from the main transcript |
| **Jev gate** | optional [TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one) call that can *cancel* a pointless review, with deterministic fallback |
| **Curator** | mechanical aging: stale after 30 days, archived after 90, pinned skills exempt, only agent-authored skills, never hard-deleted |
| **Usage ledger** | records loads and review-gate decisions for tuning |

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (the tested target; other 0.2.x may work).
- Node.js **22.19** or newer.
- Optional: a TypeSafe API key (`TYPESAFE_API_KEY`) only if you enable the Jev gate.

## Install

From GitHub (once the repository is published):

```bash
dsh plugin --profile web add github:OWNER/dsh-self-evolve
```

From a local checkout:

```bash
git clone https://github.com/OWNER/dsh-self-evolve.git
cd dsh-self-evolve
npm ci
npm run build          # produces dist/ (also committed for GitHub installs)
dsh plugin --profile web add "$PWD"
```

Then restart the profile. The plugin activates as the `self-evolve` row and adds
`skill_manage` together with the `/skills` command. See
[docs/installation.md](docs/installation.md) for manual wiring, environment
files, verification and uninstall.

## Configure

Everything is optional; defaults keep the plugin useful and quiet. Put overrides
on the row in your profile's `cordis.patch.yml`:

```yaml
- id: self-evolve
  config:
    readBeforeWrite: true        # default
    writeApproval: false         # set true to review every write
    review:
      enabled: true              # the reviewer spends tokens; opt in
      turnInterval: 10
      toolCallThreshold: 15
      gate: jev                 # counters (default) or jev
      jev:
        model: jev-latest
        apiKeyEnv: TYPESAFE_API_KEY
        confidentNo: 0.75
```

The full key reference, including the reviewer and gate budgets, is in
[docs/configuration.md](docs/configuration.md).

### Enabling the Jev gate

The gate is off unless you ask for it, and it degrades to counters when it
cannot run. Give the harness the key through a dedicated env file rather than
the profile YAML:

```bash
install -m 600 /dev/null ~/.dsh/typesafe.env
printf 'TYPESAFE_API_KEY=%s\n' "$YOUR_KEY" >> ~/.dsh/typesafe.env
mkdir -p ~/.config/systemd/user/deepseek-harness.service.d
printf '[Service]\nEnvironmentFile=%%h/.dsh/typesafe.env\n' \
  > ~/.config/systemd/user/deepseek-harness.service.d/typesafe.conf
systemctl --user daemon-reload
systemctl --user restart deepseek-harness.service
```

## Use

The model gets one new tool:

| Action | Purpose |
|---|---|
| `list` | skills across both scopes, with uses and layout |
| `create` | new skill; `scope: "user" \| "project"` |
| `patch` | exact-text replace inside `SKILL.md` (preferred update) |
| `edit` | replace body/description wholesale |
| `delete` | archive (never hard-delete) |
| `write_file` / `remove_file` | supporting files under the skill directory |
| `pin` / `unpin` | exempt a skill from curator aging |

Humans get the `/skills` command:

```
/skills pending | diff <id> | approve <id|all> | reject <id|all>
/skills approval on|off
/skills review on|off|now
```

Worked examples are in [docs/usage.md](docs/usage.md).

## How the loop fits together

```
turn ends ──▶ counters due? ──▶ (optional) Jev gate ──▶ fork reviewer
                                                        │
                                          skill_manage ─┴─▶ ~/.dsh/skills/<name>/SKILL.md
                                                        │
                                          next session ─┴─▶ skill catalog (progressive disclosure)
```

The reviewer and gate are described in [docs/review-loop.md](docs/review-loop.md);
the module map is in [docs/architecture.md](docs/architecture.md).

## Safety model

- **No secrets in the repository.** API keys are read from the process
  environment; the profile YAML holds names, never values.
- **The gate is advisory.** It can only cancel a review it is confident is
  pointless; permissions, approvals and write guards stay deterministic.
- **The reviewer writes through `skill_manage`**, so read-before-write,
  duplicate refusal, credential scanning and staged approval all still apply.
- **The review child inherits the parent toolset**, but its scope is narrowed to
  `skill` + `skill_manage` right after activation; DSH has no per-activation
  tool filter, so this is defence in depth, not a sandbox. Run with
  `writeApproval: true` when reviewing untrusted conversations.
- **Outbound data:** only the Jev gate sends anything off-machine — a bounded
  digest (user message, assistant message, tool count, loaded skill names, turn
  index), never tool output.

Details and threat model: [docs/security.md](docs/security.md).

## Development

```bash
npm ci
npm run check       # tsc against DSH 0.2.1-rc.2
npm test            # 106 unit/integration tests
npm run build       # dist/index.js
npm run smoke       # built tool → real dsh-skill + dsh-skill-filesystem catalog
npm run gate-stats  # summarize ~/.dsh/self-evolve/gates.jsonl
npm run verify      # check + test + build + smoke
```

CI runs the same checks on every push (`.github/workflows/ci.yml`).

## Compatibility and known limits

- Built and tested against DSH `0.2.1-rc.2`; the plugin API is young and may move.
- The reviewer needs the `subagent` service and a provider (`fork` by default).
- Tool narrowing for the review child is post-hoc; see the security doc.
- Review children run on the parent's model, so the reviewer is the expensive
  part of the loop. Counters, cooldown and per-session caps bound it.
- No memory store: durable facts belong to whatever memory layer your profile
  composes (for example an MCP memory server), not to this plugin.

## License and attribution

MIT. The upstream copyright notice is retained in [LICENSE](LICENSE); this
fork's changes are offered under the same terms. Upstream:
[`jianghuife/dsh-self-evolve`](https://github.com/jianghuife/dsh-self-evolve).
