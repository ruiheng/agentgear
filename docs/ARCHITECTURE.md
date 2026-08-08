# Architecture

This repository has three boundaries:

1. `skills/` is the only hand-authored, agent-facing source of truth.
2. `providers/` contains narrow host-specific adapters when they are needed.
3. `dist/` is generated installation material and is never edited by hand.

`catalog/skills.json` owns pack membership, external command requirements, and
upstream dependencies. It is intentionally separate from `SKILL.md` metadata:
frontmatter decides when an agent loads a skill; the catalog decides how a human
installs and operates a collection.

`config/tool-profiles.toml` is packaged runtime configuration. User overrides
are layered from the XDG `agentgear` config directory and the project-local
`tool-profiles.local.toml`; neither depends on the maintainer's old dotfiles.

The workflow pack depends on the upstream Agent Deck skill and executable. The
upstream source remains external instead of being silently forked here.

Runtime scripts belong to their owning skill and use Node.js, rather than a
shell-specific runtime. Build, installer, and test scripts belong at the
repository root so an installed skill remains self-contained.

## Installation channels

Every installation stages an immutable package snapshot in the user's XDG data
directory. Release installation copies selected skills from that snapshot, so
it remains stable even if a checkout changes or disappears.

Developer installation uses the checkout-only
`node ./bin/agentgear-link.mjs` command (also available as
`npm run link -- ...`). When directory links or Windows junctions are
available, target skills and the launcher point to the stable `current` runtime
path rather than the checkout. Rerunning `agentgear-link` from the checkout
stages its latest contents and publishes that path only after target validation
and installation succeed, so all shared links switch together. Local checkout
edits therefore require another `agentgear-link` invocation to take effect.
The published `agentgear` CLI has no `link` subcommand; the developer entry
point is kept in the source checkout and rejects execution from a staged
runtime.

The install state records ownership of the launcher and workflow helpers. That
allows a normal `agentgear-link` invocation to recover when `current` itself
was removed and those command links are dangling, without treating an
unrecorded look-alike link as installer-owned.

On filesystems that cannot create directory links, `agentgear-link` falls back
to copied skills and small Node wrappers; rerunning it explicitly refreshes
those copies. It refuses to fall back while a shared-runtime skill, launcher,
or helper remains active: leaving those consumers on the old `current` runtime
while moving commands to a new copied snapshot would be incoherent. If a future
provider adapter needs generated output, its developer path must be produced by
`agentgear-link`, not hand-edited in `dist/`.

`agentgear uninstall --purge` explicitly cleans up installer-owned artifacts.
It removes only state-recorded skills and installer-recognized launchers,
helpers, and runtime snapshots. It preserves unmanaged target content,
unrelated files in the XDG data directory, and separately opted-in host
permission rules; locally modified copied skills require `--force` before they
can be purged.
