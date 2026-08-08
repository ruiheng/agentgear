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
# equivalent: npm run link -- --pack all --target codex,claude
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

When directory links or Windows junctions are unavailable, Agentgear falls back
to copied skills and small Node command wrappers; rerunning `agentgear-link`
refreshes those copies explicitly. It refuses that fallback while an existing
shared-runtime skill, launcher, or helper is still active, so one installation
cannot be split across old and new runtimes. When links are available, every
installed skill link sees the new snapshot without being repointed individually.
The published `agentgear` CLI deliberately has no `link` subcommand. Switch
back to independent release copies with
`npx --yes @ruiheng/agentgear@latest update ...`.

Agentgear records ownership of its launcher and workflow helpers. If the stable
`current` link is removed accidentally, rerun `agentgear-link` from the
checkout to restore it and the recorded command links. It still refuses an
unrecorded command link, even when that link happens to target the same path.

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
only installer-managed destinations.

The workflow pack deliberately does not copy the upstream `agent-deck` skill.
Install it from [Agent Deck](https://github.com/asheshgoplani/agent-deck) in
each target harness, then use the installed
`agent-deck-workflow-init-permissions` command to opt into its permission
integration.

## Uninstall

Remove a selected pack or skill from a target:

~~~bash
agentgear uninstall --pack core --target codex
agentgear uninstall --skill handoff --target codex
~~~

The installer refuses to remove locally modified copied skills unless `--force`
is given. Removing a development target removes only the Agentgear-managed link
or copy, never the checkout it came from.

To remove every installer-managed skill, launcher, workflow helper, recognized
release snapshot, and install-state file, run a full purge:

~~~bash
agentgear uninstall --purge
~~~

Without a target selector, `--purge` covers every target in its installation
state. Add `--target`, `--scope`, `--project`, or `--dest` to limit it to one
location. In that case shared runtime files are retained while other managed
skills remain. A purge never deletes unmanaged skills or unrecognized files in
the XDG data directory. It also leaves host permission rules created by the
separate, opt-in workflow permission initializer untouched.

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

The development-only command is `node ./bin/agentgear-link.mjs` (or
`npm run link -- ...`) from a source checkout. It accepts the same pack, skill,
target, scope, destination, `--force`, and `--no-launcher` selection options as
`agentgear install`; it is intentionally not an `agentgear` subcommand.

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

The bundled tool profiles live in `config/tool-profiles.toml`. A user can
override them with `$XDG_CONFIG_HOME/agentgear/tool-profiles.local.toml` (or
`~/.config/agentgear/tool-profiles.local.toml`) and a project-local
`tool-profiles.local.toml`.
