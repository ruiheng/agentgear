---
skill-selector: lane-manifest
selector-summary: Use the stable participant and contract manifest for a draft technical-design lane.
---

# Draft Lane Manifest

The requester creates this compact lane manifest:

```json
{
  "schema_version": 2,
  "task_id": "<task_id>",
  "requester_session_id": "<real id>",
  "requester_address": "<Waypost address>",
  "author_session_id": "<real id>",
  "author_to_address": "<Waypost address>",
  "reviewer_session_id": "<real id>",
  "reviewer_to_address": "<Waypost address>",
  "pruner_policy": "<auto|always|never>",
  "session_host": "<host>",
  "context_file": ".agent-artifacts/message/<contract>.md",
  "archive_branch": "<branch>",
  "design_phases": "<two|single>",
  "initial_review_checkpoint": 5,
  "structure_checkpoint": 5,
  "review_checkpoint": 5,
  "review_checkpoint_interval": 2
}
```

When `always` is selected, also record the initial `pruner_session_id` and
`pruner_to_address`. `auto` and `never` omit them. Additional creation
timestamps are diagnostics only.

A `two`-phase lane records `structure_checkpoint`, `initial_review_checkpoint`,
and later `structure_doc`; a `single`-phase lane omits them and reviews one
`rNNN.md` series under `review_checkpoint`. A manifest without `design_phases`
is a single-phase lane.

Use it for participant routes, the Canonical Contract, phase state, and session
closeout. Round progress and reports remain in messages and artifacts.

## Phase State

On a two-phase lane the manifest is the phase boundary:

- `structure_doc`: the accepted `sNNN.md` structure document, recorded by
  `record-design-structure.mjs` after the requester accepts a structure
  delivery. Implementation dispatch requires it and names it via
  `--structure-doc`.
- `structure_amendment_pending`: set by `record-design-structure.mjs
  --open-amendment` when implementation-phase evidence requires a structure
  revision. While present, implementation dispatch is blocked; recording the
  next accepted `sNNN` clears it. Re-recording the same `structure_doc` closes
  an amendment that resolved without a structural change.

Only these phase fields and the two checkpoints change; nothing else in the
manifest tracks workflow progress.

## Checkpoints

`structure_checkpoint` gates `sNNN` rounds and `review_checkpoint` gates `rNNN`
rounds; each advances by `review_checkpoint_interval` through
`advance-design-review-checkpoint.mjs --phase` after the author records
convergence evidence in the round notes, or after the user chooses to continue
a reported risk. `initial_review_checkpoint` preserves the lane-creation value
for the later implementation phase. This does not change the contract or send a
message.

## Dynamic Work

Agents derive current work from retained context, authenticated messages, and
dispatched artifacts.

Write complete rounds as
`.agent-artifacts/design-spec/<author_session_id>/sNNN.md` (structure) or
`rNNN.md` (implementation, and single-phase lanes). Because a dispatched round
is review evidence, a revision creates the next numbered snapshot in the same
series. Dispatched snapshots are immutable: never modify or overwrite them;
every revision uses the next number and a new review dispatch.

The dispatcher does not write workflow state. `auto` first prunes at
`max_lines` or `max_chars`; `always` ignores that initial threshold. After
`MINIMAL`, pass that same-phase snapshot as `--pruner-baseline-artifact`.
Recheck only for `--major-structure-change` or cumulative growth reaching
`recheck_added_lines` or `recheck_added_chars`. Final mode sends only to the
pruner when a delivered structure artifact has not yet received pruning
acceptance. `never` uses none. The pruner never sees implementation-phase
`rNNN` rounds on a two-phase lane.
