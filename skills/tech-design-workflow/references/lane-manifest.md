---
skill-selector: lane-manifest
selector-summary: Use the stable participant and contract manifest for a draft technical-design lane.
---

# Draft Lane Manifest

The requester creates this manifest once. Treat it as immutable task metadata,
not workflow progress or a state machine:

```json
{
  "schema_version": 1,
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
  "max_review_rounds": 5
}
```

When `always` is selected, also record the initial `pruner_session_id` and
`pruner_to_address`. `auto` and `never` omit them. Additional creation
timestamps are diagnostics only.

Use the manifest to authenticate stable participant routes, find the Canonical
Contract, enforce the fixed maximum, and close out known sessions. Never add or
update round, artifact, epoch, report, digest, acceptance, decision, or delivery
status in this file.

## Dynamic Work

Agents determine current work from their retained context, authenticated
Waypost messages, and immutable artifacts. Messages name the exact Round,
artifact, previous artifact when applicable, and current Context Revision.
Completed reports remain Waypost messages; do not copy them into the manifest.

Write complete rounds only as
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. Never edit a round
after dispatch. A revision creates the next numbered complete snapshot.

The deterministic review dispatcher reads the manifest and artifact, measures
the artifact using the layered TOML policy, and sends review requests. It does
not write workflow state. For `auto`, reaching either threshold requires the
author to supply a lazy pruner for that dispatch. `always` uses the initial
pruner; `never` sends no prune request.
