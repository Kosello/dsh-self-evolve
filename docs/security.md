# Security

## What a skill is

A skill is Markdown loaded into the model's context on demand. It is not
executed by the harness, but it can instruct the model to run commands — so a
skill is **trusted content**, roughly the same trust level as a repository
`AGENTS.md`. Treat skills from other people accordingly.

## Repository hygiene

- **No credentials in this repository.** API keys are read from the process
  environment (`TYPESAFE_API_KEY` by default); the profile YAML stores the
  variable *name*, never the value. The repository contains no `.env` files.
- Runtime dependencies are `yaml` and `@deepseek-ai/schemastery`; there are no
  install scripts. `dist/` is committed so a git install does not execute a
  build pipeline.
- The test suite includes a smoke test that exercises the built tool against the
  real skill provider; it needs no network.

## Protection of the skill library

| Control | Effect |
|---|---|
| Ownership stamp | only skills with `metadata.authoredBy: dsh-self-evolve` can be mutated; bundled, hub-installed and human-authored skills are read-only |
| Read before write | patching/editing/deleting/pinning requires a successful `skill` load in the same session |
| Duplicate refusal | `create` rejects near-duplicates instead of growing a fragmented library |
| Credential scan | private-key blocks and provider-token shapes block the write |
| Lint | advisory warnings for oversized bodies, incident logs, references sprawl, destructive shell idioms |
| Path confinement | resource writes must stay inside the skill directory; symlinks are refused; `SKILL.md` cannot be written through `write_file` |
| Atomic writes | temp file + rename, so watchers never see a half-written skill |
| Delete means archive | a deleted skill moves into `<stateDir>/archive`, never unlinked |
| Staged approval | optional; every write can require a human `/skills approve` |

## The reviewer

The review child is a **fork of the agent**, so it inherits the parent's toolset.
DSH currently offers no per-activation tool filter. The plugin:

- narrows the child scope to `skill` and `skill_manage` immediately after
  activation (`ctx.tools.restrict`), which affects subsequent steps;
- instructs the child in the prompt to use only those tools;
- routes every write through `skill_manage`, so **all write guards still apply**;
- runs it with `delivery: 'caller'`, so nothing it says enters the user's
  conversation.

This is defence in depth, not a sandbox. A prompt-injected conversation could
still try to make the child call another tool before the restriction lands. If
you enable the reviewer on sessions that ingest untrusted content, also enable:

```yaml
writeApproval: true
```

so nothing reaches the library without human review.

## Outbound data (Jev gate)

The gate is the only component that sends data off the machine. It sends:

- the last direct-human user message (truncated to 3,000 chars);
- the last assistant message (truncated);
- the number of tool results since the last review;
- the names of skills loaded during the turn;
- the turn index.

It never sends tool output, file contents, credentials from the environment, or
the system prompt. The gate is **off by default**; enabling it is an explicit
privacy decision. If the API key is missing or the request fails, the plugin
falls back to the deterministic counters and still logs the fallback.

## Gate cannot authorize anything

The gate is advisory by construction: its only possible output is "cancel this
review". It cannot approve a write, grant permissions, skip the approval gate,
or change the tool sandbox. Permissions and write guards stay deterministic.

## Sandbox and host permissions

The plugin runs inside the harness process and therefore inherits its
permissions. It relies on the harness's filesystem sandbox for containment; it
does not add its own sandbox. Keep the harness's workspace/permission policy at
least as strict as you want the plugin to be.

## Reporting a vulnerability

Open a private security advisory on the repository once it is published, rather
than a public issue, and include the version and a minimal reproduction.
