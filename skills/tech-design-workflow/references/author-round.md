---
skill-selector: author-round
selector-summary: Draft or revise one technical design snapshot and request review.
selector-aliases: action:design_spec_draft_requested, action:design_spec_context_corrected
---

# Author Round

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate the requester/author transport endpoints and Task against the lane
manifest. Read the Canonical Contract. A corrected-context
notice names its new positive Context Revision; an older authenticated notice is
a stale wake. Duplicate work is recognizable from the existing artifact and
retained conversation.

## Draft

For round 1, inspect the repository as needed. Later rounds start from the
immediately preceding dispatched artifact, reviewer/pruner reports, and their
ordinary diff while rechecking affected evidence. Write the smallest complete,
implementation-ready design at
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`.

Resolve technical questions from evidence. If a product or scope choice blocks
drafting, ask the user directly. Append the exact question and answer as a User
Decision Delta and increment Context Revision before resuming. A dispatched
round is review evidence; changes go into the next numbered snapshot.

After a checkpoint round is reviewed, ask the user directly before drafting
again. If they continue, advance the checkpoint and resume the same lane:

```bash
agentgear run tech-design-workflow advance-design-review-checkpoint.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --expected-current-checkpoint "<current checkpoint>" \
  --json
```

Checkpoint continuation does not change the Canonical Contract or Context Revision.

## Review Dispatch

After the artifact is complete, run:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --workdir "<current workspace>" \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --artifact ".agent-artifacts/design-spec/<author_session_id>/rNNN.md" \
  --previous-artifact ".agent-artifacts/design-spec/<author_session_id>/rMMM.md" \
  --round "<round>" \
  --context-revision "<current contract revision>" \
  --json
```

Omit `--previous-artifact` for round 1. The program reads the layered TOML
policy, measures the artifact, and sends the reviewer request without writing
lane or review state.

`USER_CHECKPOINT_REQUIRED` means no request was sent; use the checkpoint flow above.

`PRUNER_REQUIRED` means no request was sent. Resolve and create the deterministic
`design_pruner` sibling through the Tool Resolution and Session Host contracts,
then rerun with `--pruner-session-id` and `--pruner-to-address`. The request gives
the lazy pruner the manifest, contract revision, and exact artifact it needs.

Receipts are transport diagnostics. After an unclear send, inspect the durable
Waypost result before deciding whether to repeat the same request. Reviewers use
the authenticated message, exact artifact path, Round, and retained context to
recognize stale or duplicate work.

## Reports and Delivery

Authenticate reviewer and optional pruner reports by their actual transport
endpoints, Task, Round, and artifact. Keep reports in their messages. Wait for
both reports when a pruner was requested.

Revise on `NEEDS_REVISION` or `NEEDS_SIMPLIFICATION`; use the direct-user flow
above when a product or scope choice blocks revision. Apply reviewer-collected
answers through `report-handling`. Deliver only after correctness is `SOUND` or
`SOUND_WITH_CAVEATS`, and an enabled pruner reports `MINIMAL`.

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane Manifest: <workspace-relative lane manifest>
Artifact: <accepted artifact>
Round: <accepted round>
Decision: <SOUND | SOUND_WITH_CAVEATS>
[Pruner Session ID: <lazy pruner real id>]

## Caveats
- <exact accepted caveat in artifact order | None>
```

Use `None` for `SOUND`. Include the lazy pruner session ID only when the
requester did not create and record that pruner initially. The requester owns
assessment, archival, and closeout.
