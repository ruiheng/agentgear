# Agentgear Stable Runtime Ownership and Recovery

Status: proposed design, round 6

## Outcome

Keep one stable shared runtime at `$XDG_DATA_HOME/agentgear/current`. Every
install or developer refresh stages an immutable snapshot under `releases/`;
`current` changes only after validation and all selected destination writes
succeed. Developer skill links target `current`, never a checkout.

Replace the current ownership heuristics with one rule: an external skill,
launcher, helper, or wrapper is installer-owned only when its exact state
record and its on-disk artifact agree. Realpath resemblance to a checkout,
physical release, `current`, or another XDG alias is never ownership evidence.

This is a contraction of the current worktree design. It keeps the stable
runtime and normal rollback behavior while deleting legacy-checkout migration,
cross-alias inference, release scanning for command ownership, and per-target
mixed developer fallback. One state channel prevents public release and
developer commands from silently republishing each other's `current`. A
schema-v2 release inventory makes immutable-release deletion state-exact:
marker-shaped directories that are not recorded are never purge targets.

## Goals

- Preserve the stable shared `current` path selected by the user.
- Keep the public `agentgear` CLI separate from checkout-only
  `agentgear-link`.
- Require a clean purge/reinstall before one XDG data root changes between
  release and development channels.
- Make ownership and dangling-command recovery exact and auditable.
- Make immutable-release retention and purge ownership exact and auditable.
- Support Windows without link privilege through a bounded copy/wrapper mode.
- Preserve rollback for selected target replacements and `current`
  publication failures.
- Keep the implementation and test surface small.

## Explicit Non-goals

- Migrating direct-checkout links or earlier unpublished state shapes.
- Transitioning an existing shared installation to copy fallback in place.
- Hosting release and development channels together in one XDG data root.
- Adopting paths after state loss, even when they look like Agentgear paths.
- Inferring that two XDG paths are aliases of the same physical directory.
- Recovering automatically after the whole managed XDG data subtree is gone.
- A process-crash journal, global installer lock, schema migration, UUID
  installation hierarchy, manifest expansion, or generation reconciler.
- Discovering arbitrary unrecorded consumers of `current`.

Concurrent installer processes and cleanup after a process is killed midway
remain unsupported. The next run must reject ambiguous artifacts rather than
guess how to repair them.

## Runtime and Command Boundaries

For one invocation, compute these paths once and use their normalized absolute
spelling throughout:

- data root: `$XDG_DATA_HOME/agentgear` (or the existing default)
- releases: `<data-root>/releases/<release-id>`
- stable runtime: `<data-root>/current`
- state: `$XDG_STATE_HOME/agentgear/installs.json`
- commands: the existing fixed launcher and workflow-helper destinations

Path normalization is lexical only: resolve `.`/`..`, normalize separators,
and strip the Windows link namespace returned by Node. Do not call `realpath`
to decide ownership and do not equate different parent aliases.

Each staged release remains a flat direct child of `releases/`. Its marker is
reduced to the fields needed to verify that directory:

```json
{"schemaVersion":1,"releaseId":"<directory-basename>"}
```

The marker schema is independent of the installation-state schema and remains
version 1. A valid marker is a regular file whose parsed plain object has
exactly those two fields and whose `releaseId` equals the direct-child
directory basename. `sourceRoot` and timestamps are not ownership evidence
and are not written to the marker. The implementation may retain the current
unique release-id generator; this proposal adds no hierarchy or lifecycle
database.

`current` may be published when it is absent, but only after valid state and
coherence checks confirm that every inventoried release exists with its exact
marker. An existing `current` may be replaced when it is a symlink/junction
whose lexical target is a direct child of this invocation's exact `releases`
directory and the target ID is either in valid state's `releases` inventory
or is the current transaction's pending staged release. If the target exists,
its marker must match its directory basename. If `current` is dangling because
an inventoried target release is absent, `install`, `update`, and
`agentgear-link` fail without staging or publication; only full purge may
remove that exact dangling link while treating the recorded absent release as
already gone. Anything else is ambiguous and fails. `--force` never overrides
ownership of the internal `current` path.

## Compact State Contract

Because the npm package has not been published, new state uses
`schemaVersion: 2` and no migration machinery is added. Every present
schema-v1 state is an incompatible legacy shape and is rejected before any
other interpretation or mutation. A present state file is valid only when all
of these rules hold:

- The top-level value is a plain object with exactly `schemaVersion`,
  `channel`, `releases`, `targets`, and `commands`; `schemaVersion` is the
  integer `2`, `channel` is `null`, `"release"`, or `"development"`,
  `releases` is an array, and the final two values are plain objects.
- `releases` contains every successfully retained immutable release owned by
  this state and contains only release IDs. Each ID is a non-empty string that
  round-trips as one lexical direct-child basename below the exact `releases`
  root: it contains no `/`, `\\`, or NUL and is neither `.` nor `..`. IDs are
  unique and sorted by bytewise comparison of their UTF-8 bytes.
- `channel=null` is valid only for an empty release array, empty target and
  command maps, and no managed runtime present. A non-null channel requires at
  least one release ID. The first successful install records its invoking
  channel and first release in the same state write. The value persists even
  when `current` is temporarily missing.
- Every target key is an absolute path already equal to its lexical normalized
  form. Its value has exactly one field, `skills`, which is a plain object.
- A skill key matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`, so joining it to the
  target root always produces one direct child.
- A linked-skill record has exactly `{mode, source}` with `mode="link"` and a
  normalized absolute source whose suffix is
  `agentgear/current/skills/<same-skill>`. The coherence gate later requires
  its full root to equal this invocation's exact `current`.
- A copied-skill record has exactly `{mode, fingerprint}` with `mode="copy"`
  and a canonical fingerprint described below.
- Command keys are limited to the one computed launcher destination and the
  computed workflow-helper destination. Each destination's `kind` is
  fixed as `launcher` or `workflow-helper`; unknown command keys or mismatched
  kinds are invalid.
- A linked-command record has exactly `{kind, mode, target}`, uses
  `mode="link"`, and names that command's exact normalized target below a
  lexical `agentgear/current` root. This mode is valid only on POSIX; a state
  file containing a linked-command record is invalid on Windows.
- A wrapper-command record has exactly `{kind, mode, target, fingerprint}`,
  uses `mode="wrapper"`, and names either that same `current` target or the
  corresponding module in one direct marked release below `releases/` whose
  ID occurs in the release inventory. Windows commands always use this mode.
- Unknown fields, missing required fields, forbidden extra fields, arrays
  other than the exact `releases` array, null records, non-normalized paths,
  escaping names, duplicate or unsorted release IDs, and malformed
  fingerprints invalidate the entire file.

The written shape is therefore:

```json
{
  "schemaVersion": 2,
  "channel": "development",
  "releases": [
    "1.2.3-1786150000000-123e4567-e89b-12d3-a456-426614174000"
  ],
  "targets": {
    "/absolute/target/skills": {
      "skills": {
        "handoff": {
          "mode": "link",
          "source": "/absolute/data/agentgear/current/skills/handoff"
        },
        "review-code": {
          "mode": "copy",
          "fingerprint": "sha256-v1:<64-lowercase-hex>"
        }
      }
    }
  },
  "commands": {
    "/absolute/bin/agentgear": {
      "kind": "launcher",
      "mode": "wrapper",
      "target": "/absolute/data/agentgear/current/bin/agentgear.mjs",
      "fingerprint": "sha256-v1:<64-lowercase-hex>"
    }
  }
}
```

`installedAt`, checkout roots, copied-skill source/runtime identifiers, and
command-source aliases are removed because no ownership or rollback decision
needs them. `channel` remains because it directly enforces the no-silent-switch
user invariant; `releases` remains because it is the sole authority for
immutable-release retention and deletion.

Validation has strict precedence. If a present state file is malformed,
schema-v1, or another legacy unpublished shape, every mutating command
(`install`, `update`, `agentgear-link`, `uninstall`, and purge) stops before
filesystem mutation. `--force` is intentionally powerless at this gate.
Read-only status reports the invalid state path and reason.

The documented clean-reset path is manual and explicit: move the invalid state
file aside for inspection, remove the exact managed data root after verifying
it, then remove or use `--force` to replace only the external destinations the
user deliberately selects. The installer never converts the invalid file into
partial valid state and never touches unselected paths.

After grammar validation, the separate coherence gate rejects valid shared
records rooted at a different lexical `current`, a physical-release command
target whose release ID is not inventoried, state loss beside an existing
managed `current` or marker-shaped release, and non-empty
runtime-referencing state beside an entirely missing data root. For install,
update, and `agentgear-link`, every inventoried release must be an exact
direct-child directory with its matching marker; a missing or mismatched
member is ambiguous and fails. A marker-shaped direct child not named by the
inventory also fails those operations as possible interrupted transaction
data. Marker scanning is only an ambiguity detector and never grants
ownership or supplies purge targets.
The gate also rejects `channel=null` beside managed runtime data or non-empty
install records.

## Same-XDG Channel Policy

The public `install`/`update` path requests channel `release`; checkout-only
`agentgear-link` requests channel `development`. Before staging, compare that
requested channel with valid state:

- `channel=null` or absent fresh state may adopt the requested channel after a
  successful transaction.
- The same channel may refresh its own runtime.
- A different non-null channel fails before mutation, even with `--force`,
  `--no-launcher`, no currently visible consumers, or a missing `current`.
- `uninstall` and purge remain available independent of channel. A full purge
  removes the exact state-owned runtime inventory and then state; the next
  install may then choose the other channel. Invalid legacy state uses the
  documented manual clean reset.

No command repoints the other channel's shared consumers and no second
`current`, channel-specific runtime tree, or reconciliation path is added.

## Release Inventory and Retention

The state `releases` array is the sole deletion authority for immutable
releases. A scan of `releases/` may detect unrecorded ambiguity whether state
is absent or present, but it never adds an ID to state, adopts a directory, or
selects a purge target.

A staged release is pending transaction data after its temporary directory is
renamed to the final direct-child path. Before the atomic state write, add its
ID to the in-memory sorted inventory without dropping any prior ID. The state
commit makes that new release retained and state-owned. If any step through
state commit fails, attempt to restore the selected destinations and prior
`current` while leaving prior persisted state and inventory unchanged. Delete
the pending release only after both target rollback and `current` publication
rollback succeed. If either rollback fails, retain the pending marked release
as unrecorded ambiguous evidence, report manual recovery, and never adopt or
delete it automatically. In every failed pre-commit transaction, its ID is
never added to persisted state. A killed process can leave the same kind of
unrecorded marker-shaped directory; later commands preserve it and require
manual cleanup rather than adopting or purging it.

Every successful refresh retains the new ID and all earlier inventoried IDs.
This is required because unselected fallback wrappers may still target an
older physical release. Ordinary `uninstall` updates or removes only the
selected exact external artifacts and their records. It does not collect
release directories, remove `current`, reset `channel`, or discard the release
inventory or state, even when the external target and command maps become
empty. Full purge is the only managed runtime teardown and channel reset.

Full purge follows this release contract:

1. Require valid schema-v2 state; schema-v1 and malformed state use the manual
   clean-reset path and provide no deletion authority.
2. Derive candidate IDs only from the state inventory. Do not enumerate
   marker-shaped directories to discover more candidates.
3. Before deleting any release, preflight every recorded ID. Compute its path
   by joining the exact `releases` root with that ID and recheck that it is one
   lexical direct child. An absent path is already gone. A present path must be
   a real directory, not a link or junction, and its regular marker file must
   have exactly marker schema version 1 and the same `releaseId`. Any present
   mismatch is preserved, aborts release deletion, and keeps state.
4. Treat `current` as purge-owned only when it is absent or its exact lexical
   link target names an inventoried direct child; if that child exists, its
   marker must also pass the preceding check. Otherwise preserve `current`,
   report the ambiguity, and keep state.
5. After preflight and the existing exact external-artifact checks, remove
   `current` and each present verified inventory member. Remove state only
   after `current` is gone and every recorded release is absent or was removed.
   Remove parent directories only when empty. Unrecorded look-alike releases
   remain untouched and may keep the parent directories present.

`--force` does not broaden any release or `current` ownership rule.

## Canonical Fingerprints

Every fingerprint is `sha256-v1:` followed by 64 lowercase hexadecimal
characters. This fingerprint `v1` is part of the schema-v2 state contract but
is independent of the state's version number:

1. Begin with the UTF-8 bytes `agentgear-fingerprint-v1\0`.
2. Represent relative paths with `/`, and sort entries by bytewise comparison
   of their UTF-8 path bytes.
3. For each entry, hash its type (`directory`, `file`, or `link`), NUL, its
   relative path, and NUL.
4. For a file, hash the lowercase octal value of `stat.mode & 0o777`, NUL, the
   raw file bytes, and NUL. For a link, hash its normalized lexical link-target
   text and NUL. A directory has no additional payload.

A copied skill fingerprints its complete tree without following links. A
wrapper command fingerprints a virtual tree containing the primary command
file and, on Windows, its `.cmd` companion, including their bytes and modes.
The wrapper verifier compares the artifact with the stored fingerprint; it
does not regenerate the current wrapper template. A later template change can
therefore still update or purge an older valid wrapper.

Changing this serialization is an explicit incompatible-state boundary and
cannot silently reinterpret schema-v2 records. It requires a future explicit
state-version decision; no migration mechanism is added now.

## Exact Ownership Evidence

Both columns below are required. Neither state nor artifact resemblance is
sufficient alone.

| Artifact | Required state evidence | Required artifact evidence |
| --- | --- | --- |
| linked skill | exact target-root and skill record; `mode=link`; exact `source` | destination is a link/junction and its lexical link target equals `source` |
| copied skill | exact target-root and skill record; `mode=copy`; canonical fingerprint | destination is a directory and its canonical fingerprint equals the record |
| linked command (POSIX only) | exact destination record; expected `kind`; `mode=link`; exact expected `target` | destination is a link and its lexical target equals `target` |
| wrapper command | exact destination record; expected `kind`; `mode=wrapper`; exact expected `target`; canonical fingerprint | primary wrapper and Windows companion, when applicable, have the stored canonical fingerprint |

Stored wrapper fingerprints replace marker-only recognition, regex target
extraction, and comparison with the latest generator. This makes a wrapper
verifiable when its target is missing or the later release uses a new template.
On Windows the primary file and `<destination>.cmd` are one indivisible
artifact set; neither path is independently owned.

`--force` may replace an explicitly selected external destination, but it does
not turn a look-alike path into an owned path and does not broaden purge
ownership. It is considered only after state grammar and coherence succeed.
New state is recorded only after the replacement succeeds.

## Installation and Refresh Flow

1. Resolve the selection, exact XDG paths, fixed command destinations, and raw
   state without mutation.
2. Validate the complete schema-v2 state grammar. Any schema-v1, invalid, or
   other legacy state stops all mutating commands regardless of `--force`.
3. Apply the state/data coherence gate:
   - state missing plus an existing managed `current` or marked release: fail;
   - any linked-skill or command record plus an entirely missing data root:
     fail;
   - any physical-release command target outside the release inventory: fail;
   - any inventoried release that is absent or is not its exact direct-child
     directory with matching marker: fail;
   - any unrecorded direct child with a valid-looking release marker: fail
     without adopting or deleting it;
   - any shared record rooted at a different lexical `current`: fail and ask
     the user to restore the original XDG spelling or cleanly reinstall.
4. Apply the channel gate. A non-null channel different from the invoking
   command's channel fails before staging and cannot be forced.
5. Build the catalog-declared retired-skill plan, then validate collisions for
   selected skills and commands using exact ownership. Retired records are
   excluded from staged-runtime consumer validation; matching artifacts are
   removed in the destination transaction, while locally changed artifacts are
   preserved and released from installer state. Unowned existing selected
   paths fail unless that selected path has `--force`. On
   Windows, test the primary command and its `.cmd` companion as one collision
   group: both absent is free, while any other combination requires one exact
   wrapper record and matching composite fingerprint or explicit force.
6. Stage the complete checkout/package snapshot in a temporary release path,
   write its marker, and rename it to its final immutable release path. Treat
   that final path as pending transaction data, not yet persisted ownership.
7. Choose the invocation's deployment mode before replacing any destination.
8. Run the bounded shared-runtime completeness check below against the staged
   snapshot. Any missing document, command entrypoint, or local static module
   dependency fails before `current` can publish.
9. Replace selected skills and commands under the existing in-memory
   backup/rollback transaction and update state in memory. Add the pending
   release ID to the sorted inventory without dropping prior IDs. A Windows
   command replacement moves, writes, restores, and commits the primary and
   `.cmd` paths as one transaction group.
10. In shared mode, publish `current` with the existing temporary-link rename
   and retain the prior target for rollback. In fallback mode, do not publish
   `current`.
11. Set `channel` in memory for a fresh state, atomically write the complete
    schema-v2 state including the new release ID, then discard transaction
    backups. The successful state commit makes the pending release retained.

If any step after staging fails, restore selected destinations, restore the
previous `current` when it was switched, leave the prior state file unchanged,
and keep the pending release ID out of persisted inventory. Delete the pending
marked release only if both destination rollback and `current` publication
rollback succeed. If either rollback fails, retain that marked directory,
report partial rollback and required manual recovery, and do not later adopt or
delete it automatically. This is ordinary operation rollback only; no
persistent transaction protocol is added.

## Shared-Runtime Completeness Check

Build `sharedSkills` from exact active linked-skill records plus the selected
skills that this `agentgear-link` invocation will install in shared mode.
Release-copy selections and developer copy fallback are not planned shared
skills, but any pre-existing active shared skills are always included before a
same-channel `current` refresh.

For every skill in `sharedSkills`:

1. Require `skills/<skill>/SKILL.md` in the staged snapshot.
2. Starting at that file, recursively follow only relative
   `references/...md` or `./references/...md` paths found in the current
   document. Resolve them relative to that document, require them to remain
   inside the same skill directory, require each referenced file to exist, and
   deduplicate cycles.
3. In every visited document, collect literal
   `agentgear run <skill> <script>` commands. Accept only simple skill tokens
   and relative `.mjs`, `.cjs`, or `.js` script paths with no `..`; map each to
   `skills/<skill>/scripts/<script>` in the staged snapshot.
4. Require each documented entrypoint to be a regular file, then recursively
   validate its local static ESM closure: follow relative specifiers in static
   `import` and `export ... from` declarations, reject paths outside the
   snapshot, require every resolved module to be a regular file, and
   deduplicate cycles.

Use the same local static ESM closure validator for active or planned fixed
launcher/helper entrypoints. Bare package imports, dynamic imports, CommonJS
`require`, and arbitrary prose are intentionally outside this install-time
check. This is the existing bounded protection needed to reject a staged
snapshot missing a command such as
`skills/multi-agent-protocol/scripts/resolve-tool-command.js`; `npm run check`
remains an additional quality gate, not a substitute.

## Shared Mode and Windows Fallback

For `agentgear-link`, shared mode is all-or-nothing for the selected skills.
Before installation, probe creation of the `current` directory link and a
temporary directory link in every selected destination parent.

- If all directory-link probes succeed, every selected developer skill points
  to its exact path below `current`.
- POSIX command paths may use file links and fall back to canonical wrappers
  targeting `current` when file links are unavailable. Windows command paths
  always use the canonical primary-wrapper plus `.cmd` pair targeting
  `current`; Windows never writes the link-plus-companion hybrid.
- If any required directory-link probe reports a supported "links unavailable"
  error, choose copy fallback for the entire invocation: copy every selected
  skill and install command wrappers targeting the physical staged release.
- Shared-to-fallback transition is unsupported, even when the invocation
  appears to select every consumer. Before the transaction, inspect the valid
  state without subtracting planned replacements. If it contains any linked
  skill or any command targeting `current`, fail and require purge/reinstall.
  A missing artifact does not waive this gate; purge can remove its stale
  record safely. `--force`, `--no-launcher`, and an all-skills selection do not
  bypass it.
- Copy fallback is therefore supported only for a fresh installation or a
  fallback-to-fallback refresh whose valid state contains no shared record.

Public `install`/`update` continues to copy selected skills. It publishes
`current` for the launcher/helpers when directory links are supported, and
uses physical-release wrappers when they are not. It is never exposed as a
developer link command. On Windows its commands are wrappers in both cases:
they target `current` in shared mode and the physical release in fallback.

## Windows Command Lifecycle

Windows has one command artifact form: a generated Node wrapper at
`<destination>` plus its generated `<destination>.cmd` launcher. The state has
one `mode="wrapper"` record and one composite fingerprint covering both files.

- Replacement accepts the pair as owned only when the exact record and
  composite fingerprint match. A modified companion, a missing companion, a
  lone companion, or any unrelated pre-existing companion makes the whole
  command group unmanaged. Without `--force`, preserve both paths and fail.
- With `--force` on that selected command, transactionally replace both paths;
  do not preserve or adopt one half of the old pair.
- Rollback restores both prior paths or removes both newly created paths.
- Purge removes both paths only when the exact record and composite
  fingerprint match. If either half is missing or changed, preserve every
  remaining path and report the command as unverifiable. `--force` does not
  broaden purge ownership.

This deletes the current Windows link-plus-`.cmd` lifecycle instead of adding
another state field or verifier for it.

## Recovery Policy

- Deleted command artifact: recreate it; no ownership claim is needed when the
  destination is absent (both command paths are absent on Windows). A lone
  Windows companion is a collision, not a deleted command.
- Dangling command because `current` was removed: recover only when its exact
  command record and link target or stored wrapper fingerprint match. Recreate
  `current` after the staged install succeeds; the command then becomes live
  again. On Windows the fingerprint must still cover both command files.
- Missing `current` with valid state and every inventoried release present with
  its exact marker: supported by publication after staging succeeds.
- A dangling `current` whose inventoried target release is absent is not
  recoverable by `install`, `update`, or `agentgear-link`; those operations
  fail conservatively. Full purge may remove the exact recorded dangling link
  and treats the absent inventory member as already gone.
- A missing or mismatched inventoried release blocks install, update, and
  `agentgear-link`; full purge applies its stricter preflight and retention
  rules instead of scanning for substitutes.
- State loss, schema-v1 or malformed state, or deletion of the entire managed
  data root: unsupported; fail without adopting artifacts.
- Different XDG alias or spelling: unsupported even when `realpath` would
  match. Restore the original environment or perform a clean reinstall.
- A valid state owned by the other channel: reject before staging. Full purge,
  then reinstall through the desired channel; never repoint it in place.
- Direct-checkout links, schema-v1, and other earlier unpublished state
  invalidate the whole state file. `--force` cannot bypass that result. After
  the documented manual clean reset, a new invocation may explicitly replace
  selected leftover external paths with `--force`; this is replacement, not
  migration.
- Any state/artifact disagreement: reject the ambiguous path. Purge preserves
  an unverifiable command and reports it rather than deleting it.

## Public/Developer CLI Separation

- `agentgear` keeps only public release operations; no `link`, `sync`, or
  `--link` path returns.
- `bin/agentgear-link.mjs` remains a checkout entry guarded by
  `.agentgear-dev-checkout`.
- Remove the developer entry and `cli/link.mjs` from the npm `files` payload;
  remove the checkout convenience `scripts.link` entry as well. The package
  exposes only the `agentgear` executable. Add a pack-content test so this
  boundary cannot regress.

## Implementation Surface

- `cli/lib/runtime.mjs`
  - keep staging, markers, fingerprints, wrapper generation, current
    publication/rollback, and the small path-backup transaction;
  - split the state schema-version and release-marker version constants and
    validators; state is version 2 while markers remain version 1;
  - add the strict schema-v2 state grammar, canonical release inventory,
    canonical fingerprint implementation, and exact artifact and release
    verifiers;
  - retain the bounded same-skill Markdown reference scanner, literal
    `agentgear run` collector, and relative static ESM closure validator;
  - delete checkout/source-root ownership, realpath alias equivalence, broad
    target matching, legacy-root migration, command ownership by release scan,
    wrapper marker parsing, and the Windows link-plus-companion path.
- `cli/lib/installer.mjs`
  - remove legacy-root handling;
  - enforce the channel gate, perform coherence/collision checks, choose one
    developer deployment mode, and use stage -> mode -> completeness ->
    replace -> publish -> inventory/state ordering;
  - discard a pending release only after target and `current` rollback both
    succeed; otherwise retain it unrecorded and report manual recovery.
- `cli/agentgear.mjs`
  - keep ordinary uninstall from collecting retained releases;
  - derive full-purge release candidates only from valid state inventory and
    apply the exact direct-child marker verifier before deletion;
  - purge other commands and runtime artifacts only through the exact
    verifiers and remove legacy migration inputs.
- `package.json`
  - exclude the checkout-only command from published files and scripts.
- `README.md`, `docs/ARCHITECTURE.md`, and `tests/cli.test.mjs`
  - document and verify the conservative recovery boundary.

No catalog, provider, skill payload, marker-version bump, state-migration
machinery, new manifest, or new runtime file is required.

## Focused Test Matrix

1. Developer links use exact `current` paths; release installs copy skills;
   the public package exposes no link command.
2. State grammar writes only schemaVersion 2 and rejects every schema-v1 or
   other legacy state, path-escaping skills, unsafe/duplicate/unsorted release
   IDs, unknown commands, invalid channels, extra fields, and malformed
   fingerprints.
3. Exact recorded commands dangling only because `current` is absent recover
   when every inventoried release remains intact. A `current` link dangling
   because its inventoried release is absent blocks `install`, `update`, and
   `agentgear-link`, while exact full purge removes the link and treats the
   absent member as gone.
4. Stored fingerprints verify an older wrapper template; Windows uses wrapper
   mode only and treats modified, missing, or unmanaged `.cmd` companions as
   whole-command replacement and purge failures.
5. XDG alias changes, state loss beside runtime data, and whole-data-root loss
   fail without adoption; restoring the supported context works.
6. Fresh no-link installation uses copy/wrapper fallback, while any existing
   shared record blocks shared-to-fallback even with all selections or
   `--no-launcher`; purge then fresh fallback succeeds.
7. Same-channel refreshes succeed. Release-to-development and
   development-to-release both fail before staging with `--force`,
   `--no-launcher`, or missing `current`; full purge permits the new channel.
8. Active and first-publication planned shared skills reject a missing
   documented command or relative static ESM dependency without changing
   `current` or state.
9. A command found only through recursively referenced same-skill Markdown is
   enforced; deleting `resolve-tool-command.js` rejects `agentgear-link`.
10. Fault-injected target, Windows command-group, state-write, and `current`
    publication failures keep prior state and inventory unchanged. When target
    and `current` rollback both succeed, the pending release is deleted; when
    either rollback fails, it remains marked but unrecorded and the command
    reports partial rollback plus required manual recovery.
11. A successful refresh adds its new ID without dropping older IDs, and
    ordinary uninstall retains the inventory, runtime, channel, and state even
    when all external records are removed.
12. Full purge derives candidates only from recorded IDs, removes only exact
    direct-child directories with matching markers, ignores unrecorded
    marker-shaped look-alikes, retains state on a recorded mismatch, removes
    an exact `current` dangling to an absent recorded member, and removes state
    only after all inventory members and `current` are gone.

## Tradeoffs and Residual Risk

Users who change XDG aliases, lose state, or delete the entire managed subtree
must restore the old environment or clean up explicitly. That is deliberate:
the alternative requires precisely the unsafe alias and look-alike inference
this design removes.

A process killed after release rename but before state commit, or a failed
target/`current` rollback, can leave an unrecorded marked directory. Because
there is no journal or lock, automatic recovery remains unsupported; later
install, update, and `agentgear-link` paths reject it, while purge preserves
it for explicit operator cleanup instead of deriving ownership from its
marker.

Successful refreshes retain all earlier inventoried releases, and ordinary
uninstall does not collect them, so disk use can grow until full purge. That
bounded operational cost avoids reference inference, a garbage collector, or
a generation database.

The completeness scanner intentionally recognizes only same-skill
`references/...md` links, literal `agentgear run` commands, and relative static
ESM imports/exports. It does not interpret arbitrary Markdown, dynamic imports,
bare packages, or CommonJS `require`. `npm run check` remains an additional
quality gate; it does not replace this publication check.

Canonical fingerprints deliberately create a compatibility boundary. The
stored wrapper digest avoids coupling ownership to the current wrapper
template, but changing the fingerprint serialization itself requires a future
explicit state-version decision rather than an implicit reinterpretation.
