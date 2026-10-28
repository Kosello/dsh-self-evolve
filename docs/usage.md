# Using the plugin

## The `skill_manage` tool

The model calls one tool. `name` is kebab-case (lowercase letters, digits,
hyphens, max 64 chars); `list` is the only action that does not need it.

| Action | Required parameters | Notes |
|---|---|---|
| `list` | — | shows both scopes, layout, use count, and whether staged writes exist |
| `create` | `description`, `body` | `scope` selects `user` (default) or `project` |
| `patch` | `name`, `find`, `replace` | exact-text replace; the preferred update |
| `edit` | `name` plus one of `description`, `when_to_use`, `body` | replaces the provided parts, keeps the rest |
| `delete` | `name` | archives into `<stateDir>/archive`, never deletes |
| `write_file` | `name`, `path`, `content` | supporting file under the skill directory |
| `remove_file` | `name`, `path` | removes one supporting file |
| `pin` / `unpin` | `name` | exempts the skill from curator aging |

`description` is the only text future sessions see in the catalog, so it must
say both what the skill does and when to use it. `when_to_use` adds extra
trigger guidance.

### Create

```json
{
  "action": "create",
  "name": "debug-oomkilled-pods",
  "scope": "project",
  "description": "Diagnose Kubernetes pods killed by the OOM killer and choose a memory limit that holds.",
  "body": "1. Read the pod's last state and the kernel OOM line.\n2. Compare `resources.limits.memory` with the working set at kill time.\n3. Raise the limit to 1.5x the observed peak, not to the request.\n4. Re-run and confirm no new OOMKilled restarts for 10 minutes.\n\nPitfalls: a `requests` increase alone does not change the OOM score; the limit does."
}
```

`create` refuses when the name already exists or when the description overlaps
an existing skill (`duplicateThreshold`). The refusal names the skill to patch
instead of letting the library fill with near-duplicates.

### Patch

`patch` is an exact-text replace inside the serialized `SKILL.md`:

```json
{
  "action": "patch",
  "name": "debug-oomkilled-pods",
  "find": "3. Raise the limit to 1.5x the observed peak, not to the request.",
  "replace": "3. Raise the limit to 1.5x the observed peak, never below the request."
}
```

The `find` text must match exactly once. Before patching, the skill must have
been loaded with the `skill` tool in the same session (`readBeforeWrite`),
because patching from the catalog description alone is how a procedure gets
silently destroyed.

### Supporting files

```json
{
  "action": "write_file",
  "name": "debug-oomkilled-pods",
  "path": "scripts/collect.sh",
  "content": "#!/bin/sh\nkubectl get pods -o json | jq '...'\n"
}
```

Resources live only under `references/`, `templates/`, `scripts/` and
`assets/`-style paths inside the skill directory; traversal and `SKILL.md`
itself are refused. Flat single-file skills cannot carry resources.

### Scopes and layouts

| Scope | Root | Use for |
|---|---|---|
| `user` (default) | `~/.dsh/skills` | procedures that apply everywhere |
| `project` | `<project root>/.dsh/skills` | procedures specific to the repository |

The project root is the nearest ancestor of the session cwd carrying a marker
(`.git` by default), falling back to the cwd. Lookup prefers the project root
over the user root and directory packages (`<name>/SKILL.md`) over flat files
(`<name>.md`). The curator never touches project skills.

### What a good skill looks like

- A procedure in order: the commands and tool calls that work.
- Pitfalls attached to the step they affect, with the mechanism (one clause of
  *why*), stated once.
- How to verify success.
- A body under ~12 KB; depth belongs in `references/`.
- Lessons, not logs: no incident narration, PR/issue numbers, dates or quoted
  chat.

The linter warns when a body looks like an incident log, grows past 24k chars,
or a skill accumulates more than 60 resources. A credential-shaped string
(private key block, cloud token, `password = …`) blocks the write.

## The `/skills` command

```
/skills pending              list staged writes with ids and diff stats
/skills diff <id>            show the staged diff
/skills approve <id|all>     apply
/skills reject <id|all>      discard
/skills approval on|off      enable/disable staging at runtime
/skills review               show reviewer state and budgets
/skills review on|off        enable/disable the post-turn reviewer
/skills review now           run one review immediately
```

Approval re-checks the base content hash, so a write staged before someone
edited the skill is refused rather than applied on top of the change.

## Worked example: capture a correction

The user says: "No, we use pnpm here, never npm install." A good turn for the
reviewer, or for the model directly:

1. `skill_manage(action="list")` — is there a repo-workflow skill already?
2. If yes, load it with `skill(name)` and `patch` the package-manager step.
3. If no, `create` a project-scope skill:

```json
{
  "action": "create",
  "scope": "project",
  "name": "repo-package-manager",
  "description": "Use pnpm for every dependency command in this repository; never npm.",
  "body": "1. Use `pnpm install`, `pnpm add`, `pnpm run`.\n2. Do not run `npm install`; it writes a package-lock.json this repo does not use.\n3. Verify with `pnpm install --frozen-lockfile` before committing.\n\nPitfall: some tools call npm internally; run them through `pnpm exec`."
}
```

## Failure messages you may see

| Message | Meaning |
|---|---|
| `skill "x" has not been loaded in this session` | call `skill(name="x")` first, or disable `readBeforeWrite` |
| `create refused: overlaps existing skills` | patch one of the named skills instead |
| `skill_manage create refused: secret:…` | the body contains credential-shaped text; replace with a placeholder |
| `Skill "x" already exists` | use `patch`/`edit`, or choose another name |
| `flat single-file skills cannot carry resource files` | recreate as a directory package to add files |

## Automatic review

With `review.enabled` (or `/skills review on`), a completed turn triggers a
forked review child once the counters say it is due. The child sees the finished
conversation and writes through the same tool, so every guard above applies.
Its completion never reaches the parent conversation.

When `review.gate: jev` is set, a cheap TypeSafe call can cancel a review the
model is confident is pointless; otherwise the review runs. Decisions land in
`<stateDir>/gates.jsonl` and can be summarized with:

```bash
npm run gate-stats
```
