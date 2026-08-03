# AI Skills

Portable, maintained AI-agent skills with a small installer and explicit runtime
dependencies.

## Terminal users: release snapshots

After the first public package release, install the latest stable release:

~~~bash
npx @ruiheng/ai-skills install --pack core --target codex
npx --yes @ruiheng/ai-skills@latest update --pack core --target codex
~~~

`update` resolves the newest published version, stages it under the user's XDG
data directory, then atomically switches the launcher and copies selected
skills to the target harness. A failed update leaves the previous installed
skills untouched. Later edits in any local checkout do not affect that release.

## Developers: live source links

~~~bash
git clone <repository-url> ai-skills
cd ai-skills
node ./bin/ai-skills.mjs link --pack all --target codex,claude
~~~

`link` points each installed skill and the `ai-skills` launcher at this checkout.
Edits to an existing `SKILL.md`, script, or reference take effect immediately.
After adding a skill or changing pack membership, rerun the same command, or use
`node ./bin/ai-skills.mjs sync ...`. Switch back to a release snapshot with
`npx --yes @ruiheng/ai-skills@latest update ...`.

## Workflow pack

~~~bash
node ./bin/ai-skills.mjs doctor --pack workflow
node ./bin/ai-skills.mjs install --pack workflow --target codex,claude --scope project
~~~

Use `--link` while developing from a checkout. The normal mode copies skills
to the target directory and records only installer-managed destinations.

The workflow pack deliberately does not copy the upstream `agent-deck` skill.
Install it from [Agent Deck](https://github.com/asheshgoplani/agent-deck) in
each target harness, then use the installed
`agent-deck-workflow-init-permissions` command to opt into its permission
integration.

## Uninstall

Remove a selected pack or skill from a target:

~~~bash
ai-skills uninstall --pack core --target codex
ai-skills uninstall --skill handoff --target codex
~~~

Use `--dry-run` first if desired. The installer refuses to remove locally
modified copied skills unless `--force` is given. Removing a development link
removes the link only, never the checkout it points to.

To remove every installer-managed skill, launcher, workflow helper, recognized
release snapshot, and install-state file, run a full purge:

~~~bash
ai-skills uninstall --purge --dry-run
ai-skills uninstall --purge
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
| `link` / `sync` | Install live symlinks from the current developer checkout. |
| `status` | Show whether each managed skill is linked or copied. |
| `uninstall` | Remove selected installer-managed skills; `--purge` also removes installer-owned runtime artifacts. |
| `doctor` | Check declared external commands and upstream requirements. |
| `run` | Run a script bundled with an installed skill. |

## Development

~~~bash
npm run check
~~~

This project is licensed under [Apache-2.0](LICENSE). The package remains
intentionally private until its release and publishing policy is chosen.

All repository-owned executable scripts use Node.js. External tools such as
`git`, `agent-deck`, and `waypost` remain explicit workflow dependencies and
are checked by `doctor`.

The bundled tool profiles live in `config/tool-profiles.toml`. A user can
override them with `$XDG_CONFIG_HOME/ai-skills/tool-profiles.local.toml` (or
`~/.config/ai-skills/tool-profiles.local.toml`) and a project-local
`tool-profiles.local.toml`.
