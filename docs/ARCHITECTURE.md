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
Its `[templates]` section supplies reusable command fragments, expanded only
for `${templates.name}` references in candidate commands.

The workflow pack depends on the upstream Agent Deck skill and executable. The
upstream source remains external instead of being silently forked here.

Runtime scripts belong to their owning skill and use Node.js, rather than a
shell-specific runtime. Build, installer, and test scripts belong at the
repository root so an installed skill remains self-contained.

## Installation channels

Every installation stages an immutable package snapshot in the user's XDG data
directory. Release installation copies selected skills from that snapshot, so
it remains stable even if a checkout changes or disappears.

There are exactly two channels, and they never silently switch. The public
`agentgear install` and `update` commands request the release channel;
checkout-only `node ./bin/agentgear-link.mjs` requests the development channel.
The first successful install records its channel in schema-v2 installation
state. A different channel fails before any staging or mutation, even with
`--force`; only a full purge resets the channel for a fresh install through the
other one. The npm package ships no link command: the developer entry point
lives only in the source checkout, is excluded from published files and
scripts, and rejects execution from a staged runtime.

When directory links or Windows junctions are available, developer target
skills point to the stable `current` runtime path rather than the checkout.
Rerunning `agentgear-link` from the checkout stages its latest contents and
publishes that path only after target validation and installation succeed, so
all shared links switch together. Local checkout edits therefore require
another `agentgear-link` invocation to take effect.

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
release was deleted is not recoverable by install, update, or `agentgear-link`;
only full purge removes that exact dangling link. State loss, schema-v1 or
malformed state, XDG alias changes, or deletion of the whole managed data
subtree fail without adopting artifacts; the documented clean reset is manual
and explicit.

On filesystems that cannot create directory links, a fresh installation falls
back to copied skills and small Node command wrappers targeting the physical
staged release; rerunning it explicitly refreshes those copies. Copy fallback
is refused while any shared record remains in valid state: leaving existing
consumers on `current` while moving new artifacts to a copied snapshot would be
incoherent. A full purge is required before switching between shared and copy
modes. If a future provider adapter needs generated output, its developer path
must be produced by `agentgear-link`, not hand-edited in `dist/`.

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
