# Agentgear

Portable utilities and workflow orchestration for AI-agent harnesses, with a
small installer and explicit runtime dependencies.

## Terminal users: release snapshots

After the first public package release, install the latest stable release:

~~~bash
npx @ruiheng/agentgear install --pack core --target codex
npx --yes @ruiheng/agentgear@latest update --pack core --target codex
~~~

`update` resolves the newest published version, stages it under the user's XDG
data directory, then publishes it only after the target checks and installation
steps succeed. A failed update keeps the previously published shared runtime
active. Later edits in any local checkout do not affect that release.

## Developers: shared runtime links

~~~bash
git clone git@github.com:ruiheng/agentgear.git
cd agentgear
node ./bin/agentgear-link.mjs --pack all --target codex,claude
~~~

`agentgear-link` is a developer-only command: run it from a source checkout,
not from an installed `agentgear` launcher or a staged runtime. It is not
published as a public npm executable. It snapshots the checkout into
Agentgear's shared XDG runtime and prefers to point each installed skill and
the `agentgear` launcher at its stable `current` path. After editing the
checkout, rerun the same command to refresh that runtime:

~~~bash
node ./bin/agentgear-link.mjs --pack all --target codex,claude
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
npx --yes @ruiheng/agentgear@latest install --pack all --target codex,claude
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
pack. `agentgear doctor --pack workflow` reports a missing or incompatible
Waypost installation.

## Workflow pack

~~~bash
node ./bin/agentgear.mjs doctor --pack workflow
node ./bin/agentgear.mjs install --pack workflow --target codex,claude --scope project
~~~

Use `agentgear-link` from a development checkout, and rerun it after local
edits. The target normally links to Agentgear's shared runtime, with automatic
copy fallback on filesystems that reject links; the normal `agentgear install`
and `update` commands always copy skills to the target directory and record
only installer-managed destinations. The two channels are exclusive: switching
from one to the other requires `agentgear uninstall --purge` first.

The workflow pack installs `multi-agent-protocol` but deliberately does not
copy the upstream `agent-deck` skill. Install it from
[Agent Deck](https://github.com/asheshgoplani/agent-deck) in each target
harness, then use the installed `agent-deck-workflow-init-permissions` command
to opt into its permission integration.

## Uninstall

Remove a selected pack or skill from a target:

~~~bash
agentgear uninstall --pack core --target codex
agentgear uninstall --skill handoff --target codex
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
| `doctor` | Check declared external commands and upstream requirements. |
| `run` | Run a script bundled with an installed skill. |

The development-only command is `node ./bin/agentgear-link.mjs` from a source
checkout. It accepts the same pack, skill, target, scope, destination,
`--force`, and `--no-launcher` selection options as `agentgear install`; it is
intentionally not an `agentgear` subcommand and is not published in the npm
package.

## Development

~~~bash
npm run check
~~~

This project is licensed under [Apache-2.0](LICENSE) and is configured for a
public npm release as `@ruiheng/agentgear`. Before publishing, verify the
release version and matching Git tag; `npm publish` runs `npm run check` first.

All repository-owned executable scripts use Node.js. External tools such as
`git`, `agent-deck`, and `waypost` remain explicit workflow dependencies and
are checked by `doctor`.

The bundled tool profiles live in `config/tool-profiles.toml`. Start from
`config/tool-profiles.local.example.toml`, then override templates, roles, or
candidates with `$XDG_CONFIG_HOME/agentgear/tool-profiles.local.toml` (or
`~/.config/agentgear/tool-profiles.local.toml`) and a project-local
`tool-profiles.local.toml`; the project-local layer wins.

`[templates]` defines reusable command fragments. `${templates.name}` in a
candidate `command` expands the named value, while other `${...}` text is
preserved. Within each configuration layer, an `architect` override also
applies to `architect_author` and `architect_reviewer` unless that layer sets a
child role explicitly.
