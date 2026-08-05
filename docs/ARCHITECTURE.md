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

Release installation copies a package snapshot to the user's XDG data directory
and deploys copies from that snapshot. It is stable even if a checkout changes
or disappears.

Developer installation uses `agentgear link`. It links the harness directly to
the current checkout and points the launcher there too. Existing source edits
therefore apply immediately; rerun `link` or `sync` only when the installed
set changes. If a future provider adapter needs generated output, its developer
path must be produced by `sync`, not hand-edited in `dist/`.

`agentgear uninstall --purge` explicitly cleans up installer-owned artifacts.
It removes only state-recorded skills and installer-recognized launchers,
helpers, and runtime snapshots. It preserves unmanaged target content,
unrelated files in the XDG data directory, and separately opted-in host
permission rules; locally modified copied skills require `--force` before they
can be purged.
