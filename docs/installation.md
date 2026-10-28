# Installation

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (tested target).
- Node.js `>= 22.19`.
- The profile must compose the tools service (every shipped `web`/`base`
  profile does) and, only for the reviewer, the subagent service.
- Optional: `TYPESAFE_API_KEY` in the harness process environment, only for the
  Jev gate.

The package ships a prebuilt `dist/` in the repository so a GitHub install does
not need a build toolchain. A local checkout can rebuild it.

## Option A — from GitHub

Once the repository is published:

```bash
dsh plugin --profile web add github:Kosello/dsh-self-evolve
```

`dsh plugin` forwards to the profile's package manager, which installs the
package and its runtime dependencies (`yaml`, `@deepseek-ai/schemastery`); the
harness provides the peer dependencies. The command also adds the package to
`dsh.profile.bundles`, which is what activates the bundle's `cordis.patch.yml`
row.

Restart the profile afterwards:

```bash
systemctl --user restart deepseek-harness.service   # if it runs as a user unit
```

## Option B — from a local checkout

```bash
git clone https://github.com/Kosello/dsh-self-evolve.git
cd dsh-self-evolve
npm ci
npm run build          # dist/index.js + declarations
dsh plugin --profile web add "$PWD"
```

For development against a live profile, a `link:` dependency is faster than
reinstalling on every change — see the manual wiring below.

## Option C — manual wiring

Use this when `dsh plugin add` is unavailable or you want the profile to point
at a working tree.

1. Back up the profile state:

   ```bash
   cp ~/.dsh/profiles/web/package.json ~/.dsh/profiles/web/package.json.bak
   cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak
   ```

2. Link the package into the profile's `node_modules`:

   ```bash
   ln -sfn /absolute/path/to/dsh-self-evolve \
     ~/.dsh/profiles/web/node_modules/dsh-self-evolve
   ```

3. Add it to `dependencies` and `dsh.profile.bundles` in
   `~/.dsh/profiles/web/package.json`:

   ```json
   {
     "dependencies": {
       "dsh-self-evolve": "link:/absolute/path/to/dsh-self-evolve"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-self-evolve"]
       }
     }
   }
   ```

4. Configure the row by id in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: self-evolve
     config:
       review:
         enabled: true
         gate: jev
   ```

5. Restart the profile.

The bundle entry loads the package's own `cordis.patch.yml` (which inserts
`id: self-evolve`); the symlink is what makes the import resolve. Missing either
half produces a silent "entry did not activate" at boot.

## Environment key for the Jev gate

Keep secrets out of the profile YAML and the unit file. Use a dedicated file
with mode `600`:

```bash
install -m 600 /dev/null ~/.dsh/typesafe.env
printf 'TYPESAFE_API_KEY=%s\n' "$YOUR_KEY" >> ~/.dsh/typesafe.env
```

and a systemd drop-in for the harness unit:

```bash
mkdir -p ~/.config/systemd/user/deepseek-harness.service.d
printf '[Service]\nEnvironmentFile=%%h/.dsh/typesafe.env\n' \
  > ~/.config/systemd/user/deepseek-harness.service.d/typesafe.conf
systemctl --user daemon-reload
```

The plugin reads `process.env` once at activation, so the key only takes effect
after a service restart. Restarting the service ends any in-flight turn; do it
from outside the harness or with a delayed transient timer.

## Verification

1. Compose the profile without booting it and confirm the row and config:

   ```bash
   dsh --profile web --dump-config | grep -A6 'id: self-evolve'
   ```

2. After the restart, confirm the new process and the plugin's startup line:

   ```bash
   systemctl --user show deepseek-harness.service -p MainPID -p ActiveEnterTimestamp
   grep 'self-evolve' ~/.local/opt/deepseek-harness/server.log | tail -2
   ```

   With `review.enabled` and `gate: jev`, the line reads:

   ```
   [self-evolve] review ready: provider=fork gate=jev turns=10 tools=15 cooldown=20m max=8
   ```

   The line is printed only when `DSH_SELF_EVOLVE_DEBUG=1` is set in the service
   environment.

3. In a session, `/skills review` should report the configured gate and
   budgets; `skill_manage(action="list")` should work.

## Updating

- GitHub install: `dsh plugin --profile web add github:Kosello/dsh-self-evolve`
  again, then restart.
- Local checkout: `git pull && npm ci && npm run build`, then restart.
- Manual wiring: update the linked checkout; restart.

## Uninstall

```bash
dsh plugin --profile web remove dsh-self-evolve
```

Remove the `- id: self-evolve` entry from `cordis.patch.yml` if you added one,
and delete `~/.dsh/self-evolve` (ledger, archive, staged writes) and
`~/.dsh/skills` if you no longer want the generated skills. Restart afterwards.
