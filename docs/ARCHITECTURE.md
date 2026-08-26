# Architecture

This repository has three boundaries:

1. `skills/` is the only hand-authored, agent-facing source of truth.
2. `providers/` contains narrow host-specific adapters when they are needed.
3. `dist/` is generated installation material and is never edited by hand.

`catalog/skills.json` owns pack membership, external command requirements,
upstream dependencies, and the finite list of skill names retired during
pre-release migrations. It is intentionally separate from `SKILL.md` metadata:
frontmatter decides when an agent loads a skill; the catalog decides how a human
installs and operates a collection.

`config/tool-profiles.toml` maps workflow roles to ordered launch candidates.
Each candidate has a full command line and may carry a user-maintained
Thurbox agent key. User overrides are layered from the XDG `agentgear` config
directory and the project-local `tool-profiles.local.toml`. The resolver
returns those opaque values to a workflow action; Waypost selects the host and
consumes only its applicable value. Waypost never owns this mapping or reads
Thurbox configuration. The resolver's explicit `--check-config` maintenance
command may inspect the user's Thurbox `agents.toml` to warn about missing or
unknown keys; normal workflow resolution does not perform that inspection.

The workflow pack depends on Waypost plus one declared session host. When the
Agent Deck executable is available, Agentgear stages its official skill from a
catalog-pinned upstream revision into the installation snapshot. The catalog's
platform-neutral content digest is verified after a filtered, shallow fetch
and sparse materialization of only the declared skill path, and before any
reuse.
Later runs reuse a recorded copy only when repository, ref, commit, skill path,
and content digest all match; Agentgear does not fork or vendor that payload.
Doctor treats a missing but declared Agent Deck skill as install-time
provisionable, while the executable remains an external prerequisite. Thurbox
uses its `thurbox-cli` headless interface
and currently publishes no corresponding general-purpose host skill.
`catalog/skills.json` is a closed list of supported hosts for installation
checks, not a runtime plugin registry; Waypost owns live host selection and
dispatch.

Runtime scripts belong to their owning skill and use Node.js, rather than a
shell-specific runtime. Build, installer, and test scripts belong at the
repository root so an installed skill remains self-contained.

## Installation channels

Every installation stages an immutable package snapshot in the user's XDG data
directory. Release installation copies selected skills from that snapshot, so
it remains stable even if a checkout changes or disappears.

There are exactly two channels, and they never silently switch. The public
`agentgear install` and `update` commands request the release channel;
checkout-only `node ./bin/agentgear-source-install.mjs` requests the source
channel.
The first successful install records its channel in schema-v2 installation
state. A different channel fails before any staging or mutation, even with
`--force`; only a full purge resets the channel for a fresh install through the
other one. The npm package ships no source-install command: the source entry
point lives only in the source checkout, is excluded from published files and
scripts, and rejects execution from a staged runtime.

When directory links or Windows junctions are available, source-installed
skills point to the stable `current` runtime path rather than the checkout.
Rerunning `agentgear-source-install` from the checkout stages its latest
contents and publishes that path only after target validation and installation
succeed, so all shared links switch together. Source changes therefore require
another `agentgear-source-install` invocation to take effect.

Ownership is exact: a skill, launcher, helper, or wrapper is installer-owned
only when its state record and its on-disk artifact agree. Linked records
require the artifact link's lexical target to equal the recorded source;
copied skills and generated command wrappers require a stored canonical
`sha256-v1:` fingerprint over the artifact bytes. Path resemblance to a
checkout, a release, `current`, or another XDG alias is never ownership
evidence, and `--force` never broadens that rule.

Recovery is conservative. A `current` link removed while its release is intact
is republished after the next staged install, which also recreates recorded
dangling command links. A `current` link dangling because its inventoried
release was deleted is not recoverable by install, update, or
`agentgear-source-install`; only full purge removes that exact dangling link.
State loss, schema-v1 or
malformed state, XDG alias changes, or deletion of the whole managed data
subtree fail without adopting artifacts; the documented clean reset is manual
and explicit.

On filesystems that cannot create directory links, a fresh installation falls
back to copied skills and small Node command wrappers targeting the physical
staged release; rerunning it explicitly refreshes those copies. Copy fallback
is refused while any shared record remains in valid state: leaving existing
consumers on `current` while moving new artifacts to a copied snapshot would be
incoherent. A full purge is required before switching between shared and copy
modes. If a future provider adapter needs generated output, its source-install
path must be produced by `agentgear-source-install`, not hand-edited in
`dist/`.

`agentgear uninstall --purge` explicitly cleans up installer-owned artifacts.
Release-deletion candidates come only from the state inventory: each recorded
release must be an exact direct child of `releases/` with a matching marker
before it is removed, and unrecorded look-alike directories are never purge
targets. A full purge preflights every recorded release and `current` before
removing any external artifact; a mismatch or ambiguity aborts with an
incomplete result and preserves everything, so a partial teardown can never
delete external artifacts while keeping a broken runtime. Ordinary uninstall
removes only the selected exact external artifacts and their records; it never
collects releases, removes `current`, resets the channel, or discards the
inventory. Purge preserves unmanaged target content, unrelated files in the
XDG data directory, unverifiable commands, locally changed recorded skills,
and separately opted-in host permission rules; `--force` never broadens purge
ownership.
