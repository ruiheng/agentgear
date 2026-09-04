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
  "review_checkpoint": 5,
  "review_checkpoint_interval": 2
}
```

When `always` is selected, also record the initial `pruner_session_id` and
`pruner_to_address`. `auto` and `never` omit them. Additional creation
timestamps are diagnostics only.

Use it for participant routes, the Canonical Contract, review checkpoint, and
session closeout. Round progress and reports remain in messages and artifacts.

Only `review_checkpoint` changes. After the user chooses to continue, the author
advances it by `review_checkpoint_interval`. This does not change the contract
or send a message.

## Dynamic Work

Agents derive current work from retained context, authenticated messages, and
dispatched artifacts.

Write complete rounds as
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. Because a dispatched
round is review evidence, a revision creates the next numbered snapshot.

The dispatcher does not write workflow state. `auto` first prunes at
`max_lines` or `max_chars`; `always` ignores that initial threshold. After
`MINIMAL`, pass that snapshot as `--pruner-baseline-artifact`. Recheck only for
`--major-structure-change` or cumulative growth reaching `recheck_added_lines`
or `recheck_added_chars`. Final mode sends only to the pruner when the
delivered artifact has not yet received pruning acceptance. `never` uses none.
