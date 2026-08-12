# Requester Handling

## Context Recovery and Rejection

On `design_spec_review_context_recovery_requested`, recover the canonical initial contract and every requester Decision Delta effective through the pending round. Replay exact canonical payloads directly to the named reviewer in order; add `Recovery Complete: yes` only to the last envelope. If requester authority cannot be recovered, ask the user. Do not source it from the author.

On `design_spec_review_context_rejected`, correct the named context and send it to the reviewer again. After reviewer delivery succeeds, send every corrected shared lane field to the author: use `design_spec_context_corrected` for metadata-only corrections, or `design_spec_draft_requested` for authority/design changes. Do not rerun initial dispatch or edit a reviewed artifact.

## Decision Request

The author requests one precise user-owned decision:

```markdown
Task: <task_id>
Action: design_spec_decision_requested
From: architect_author <author_session_id>
To: <requester_role> <requester_session_id>
Round: <round>
Max Review Rounds: <max_review_rounds>

## Decision Needed
[One decision]

## Options
- [option]: [material consequence]

## Recommendation
[author recommendation and reviewer position]

## Current Artifact
- <exact round path>
```

After the user answers, write one canonical Requester Decision Delta under `.agent-artifacts/message/`, preserving the answer verbatim and only resulting constraint changes. Send it unchanged to reviewer first as `design_spec_review_context` with `Context: decision`, effective round, identities, host, and maximum. Only after a delivery ID is returned, send the same delta unchanged to author as `design_spec_draft_requested` with the next artifact and unchanged archive branch/maximum. Record both delivery IDs. Surface partial or unknown delivery and do not retry automatically.

## Delivered Artifact

On `design_spec_delivered`:

1. Verify the artifact exists and the report accepted that exact path.
2. Reuse an existing committed formal doc when it already represents the accepted design.
3. Otherwise require the delivered archive branch as current, a clean index, and no merge/rebase/conflict state.
4. Choose a tracked docs path and stop if it has unrelated changes.
5. Return substantive changes to the author for another reviewed round; make only trivial non-substantive archival edits locally.
6. Copy and commit only the accepted design document.
7. Read `closeout.md`, archive and remove task sessions, then report the tracked doc and commit.

Treat the tracked committed document as authoritative for implementation.
