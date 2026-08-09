# Agentgear

Portable utilities and workflow orchestration for AI-agent harnesses, with a
small installer and explicit runtime dependencies.

## Terminal users: release snapshots

After the first public package release, install the latest stable release:

~~~bash
npx @ruiheng/agentgear install
npx --yes @ruiheng/agentgear@latest update
~~~

With neither `--pack` nor `--skill`, Agentgear installs the `all` pack. Use
`--pack core` or another named pack to narrow that selection; `--skill NAME`
without `--pack` installs only the named skills.

The default targets are `general,claude`. `general` uses the shared Agent Skills locations
`~/.agents/skills` and `.agents/skills`; it is discovered by Codex, Gemini
CLI, OpenCode, and Antigravity. Agentgear installs that shared payload once,
instead of creating duplicate host-specific copies. `claude` adds Claude Code's
separate `.claude/skills` location. Use `--target general` or `--target claude`
to narrow an installation; add `kiro` only when Kiro's separate skill directory
is needed.

`update` resolves the newest published version, stages it under the user's XDG
data directory, then publishes it only after the target checks and installation
steps succeed. A failed update keeps the previously published shared runtime
active. Later edits in any local checkout do not affect that release.

## Developers: shared runtime links

~~~bash
git clone git@github.com:ruiheng/agentgear.git
cd agentgear
node ./bin/agentgear-link.mjs
~~~

`agentgear-link` is a developer-only command: run it from a source checkout,
not from an installed `agentgear` launcher or a staged runtime. It is not
published as a public npm executable. It snapshots the checkout into
Agentgear's shared XDG runtime and prefers to point each installed skill and
the `agentgear` launcher at its stable `current` path. After editing the
checkout, rerun the same command to refresh that runtime:

~~~bash
node ./bin/agentgear-link.mjs
~~~

When directory links or Windows junctions are unavailable, a fresh
installation falls back to copied skills and small Node command wrappers
targeting the physical staged release; rerunning `agentgear-link` refreshes
those copies explicitly. It refuses that fallback while any shared record
remains in valid state, so one installation cannot be split across old and new
runtimes. When links are available, every installed skill link sees the new
snapshot without being repointed individually. The published `agentgear` CLI
deliberately has no `link` subcommand.

Release and development are separate channels that never silently switch:
`agentgear install`/`update` and `agentgear-link` each reject a runtime
recorded by the other channel, even with `--force`. To move from developer
links to independent release copies, purge first and then install:

~~~bash
agentgear uninstall --purge
npx --yes @ruiheng/agentgear@latest install
~~~

Agentgear records ownership of its launcher and workflow helpers. If the stable
`current` link is removed accidentally, rerun `agentgear-link` from the
checkout to restore it and the recorded command links. It still refuses an
unrecorded command link, even when that link happens to target the same path,
and it cannot recover a `current` link dangling because its inventoried release
was deleted (full purge can remove that link).

## External dependency: Waypost

The workflow-orchestration features depend on
[Waypost](https://github.com/ruiheng/waypost). Install Waypost separately and
ensure its `waypost` command is available on `PATH` before using the workflow
pack. `agentgear doctor --pack workflow` checks the declared executable and
session-host prerequisites.

## Workflow pack

~~~bash
node ./bin/agentgear.mjs doctor --pack workflow
node ./bin/agentgear.mjs install --pack workflow --scope project
~~~

Use `agentgear-link` from a development checkout, and rerun it after local
edits. The target normally links to Agentgear's shared runtime, with automatic
copy fallback on filesystems that reject links; the normal `agentgear install`
and `update` commands always copy skills to the target directory and record
only installer-managed destinations. The two channels are exclusive: switching
from one to the other requires `agentgear uninstall --purge` first.

The workflow pack needs one supported persistent-session host:

- [Agent Deck](https://github.com/asheshgoplani/agent-deck): install its
  executable. When it is on `PATH`, Agentgear fetches its official
  `agent-deck` skill from the catalog-pinned upstream revision and installs it
  into each selected target as part of the workflow transaction.
- [Thurbox](https://thurbox.thurbeen.eu/docs/features.html#headless-cli):
  install `thurbox-cli`. Thurbox currently publishes no general-purpose host
  skill, so Agentgear does not invent or install a substitute.

`agentgear doctor --pack workflow` succeeds when Waypost, Git, Node.js, and at
least one of those session hosts are ready. The Agent Deck executable and
Thurbox executable remain external dependencies; only Agent Deck's declared
skill payload is fetched during installation.

### Resolve session launch values

Workflow roles such as `planner`, `coder`, and `reviewer` are resolved by
`config/tool-profiles.toml`, with user and project overrides in
`tool-profiles.local.toml`. A candidate's `command` is the full command line
for Agent Deck-like hosts. Thurbox users add a matching
`thurbox_agent_key` beside that command in their own override; it must match
their Thurbox configuration. Waypost receives those opaque values only when a
new session is created and does not own a second mapping file.

Initialize the user-local override from the bundled example, without replacing
an existing file:

~~~bash
agentgear resolve-tool-command --init-local-config
~~~

Check the merged resolver configuration explicitly. The command validates the
resolver structure and, when `thurbox-cli` is available, checks configured
`thurbox_agent_key` values against Thurbox's `agents.toml` (honoring
`THURBOX_CONFIG_DIR` when set, otherwise the XDG config path). Missing or
unknown keys are warnings; they do not make the check fail. Use `--format text`
for a human-readable summary.

~~~bash
agentgear resolve-tool-command --check-config --format text
~~~

## Uninstall

Remove a selected pack or skill from a target:

~~~bash
agentgear uninstall --pack core --target general
agentgear uninstall --skill handoff --target general
~~~

The installer refuses to remove locally modified copied skills; `--force`
never authorizes deleting an artifact that does not agree with its state
record. Removing a development target removes only the Agentgear-managed link
or copy, never the checkout it came from.

To remove every installer-managed skill, launcher, workflow helper, recorded
release snapshot, and install-state file, run a full purge:

~~~bash
agentgear uninstall --purge
~~~

Without a target selector, `--purge` covers every target in its installation
state. Add `--target`, `--scope`, `--project`, or `--dest` to limit it to one
location. In that case shared runtime files are retained while other managed
skills remain. Release-deletion candidates come only from the state inventory:
every recorded release must be an exact `releases/` child with a matching
marker before it is removed, and unrecorded look-alike directories are never
purge targets. A full purge preflights every recorded release and `current`
before removing anything: a mismatched release or ambiguous runtime path
aborts with an incomplete result and preserves every external artifact.
Locally changed recorded skills and unverifiable commands are preserved and
reported; `--force` never broadens purge ownership. A purge also never deletes
unmanaged skills, unrecognized files in the XDG data directory, or host
permission rules created by the separate, opt-in workflow permission
initializer.

## Commands

| Command | Purpose |
| --- | --- |
| `list` | Show available packs and skills. |
| `build` | Generate portable target layouts under `dist/`. |
| `install` / `update` | Install a frozen release snapshot. |
| `status` | Show whether each managed skill is linked or copied. |
| `uninstall` | Remove selected installer-managed skills; `--purge` also removes installer-owned runtime artifacts. |
| `doctor` | Check declared external commands, upstream requirements, and supported session hosts. |
| `permissions init/check` | Configure or verify workflow permissions for supported agent harnesses. |
| `session delete` | Delete a session through a stable host-neutral interface; Thurbox uses recoverable soft-delete. |
| `run` | Run a script bundled with an installed skill. |

`agentgear session delete` normalizes host-specific deletion and failure
reporting:

```bash
agentgear session delete --host agent-deck --session-id <id> [--profile <name>] --json
agentgear session delete --host thurbox --session-id <uuid> --json
```

Thurbox uses its recoverable soft-delete. Agentgear intentionally does not
expose Thurbox's destructive `--force` cleanup through this interface. Agent
Deck removal is not recoverable, so callers must validate ownership before
passing an exact session id; workflow closeout performs that validation.

Initialize workflow permissions through the single Agentgear entry point. User
scope is the default and applies across projects; project scope writes trusted
project configuration instead:

```bash
agentgear permissions init
agentgear permissions check
agentgear permissions init --scope project --project /path/to/project
agentgear permissions check --scope project --project /path/to/project
```

The initializer grants only the explicit Agentgear, Waypost, and session-host
operations used by the workflow. Agentgear records the Codex MCP sections it
adds and removes them when Waypost is no longer trusted; user-managed sections
are never claimed. Restart existing agent sessions after changing permissions
so they reload their harness configuration.

The development-only command is `node ./bin/agentgear-link.mjs` from a source
checkout. It accepts the same pack, skill, target, scope, destination,
`--force`, and `--no-launcher` selection options as `agentgear install`; it is
intentionally not an `agentgear` subcommand and is not published in the npm
package.

`--no-launcher` still installs the selected skills. It leaves the global
`agentgear` command and workflow helpers unchanged, so use it only when those
commands are already managed separately or are intentionally unwanted.

## Development

~~~bash
npm run check
~~~

This project is licensed under [Apache-2.0](LICENSE) and is configured for a
public npm release as `@ruiheng/agentgear`. Before publishing, verify the
release version and matching Git tag; `npm publish` runs `npm run check` first.

All repository-owned executable scripts use Node.js. `git` and `waypost` are
workflow dependencies; `agent-deck` or `thurbox-cli` provides the persistent
session host. `doctor` checks the declared requirements.

`config/tool-profiles.toml` is the shared role-to-launch-candidate resolver.
Start from `config/tool-profiles.local.example.toml`, then override templates,
roles, or candidates with
`$XDG_CONFIG_HOME/agentgear/tool-profiles.local.toml` (or
`~/.config/agentgear/tool-profiles.local.toml`) and a project-local
`tool-profiles.local.toml`; the project-local layer wins. A candidate may set
`thurbox_agent_key`; it must match that user's Thurbox configuration. The
workflow resolver does not infer keys during normal session creation. Use its
explicit `--check-config` command when you want Agentgear to verify the local
key names.
