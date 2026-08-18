---
skill-selector: author-round
selector-summary: Draft or revise one immutable technical design round and request review.
selector-aliases: action:design_spec_draft_requested, action:design_spec_context_corrected
---

# Author Round

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-state`.

## Inbound Gate

Authenticate Task and both transport endpoints against lane state before acting.
`design_spec_draft_requested` comes from the requester, is addressed to the
author, has the current Round, and requires `dispatch_ready`. A
`design_spec_context_corrected` notice comes from the requester with
`Context: initial`, a positive Context Revision, and no Round.

An authenticated older Round or revision is a stale wake: settle it without
redoing completed work. Defer missing authority; reject a different task or
endpoint. Never overwrite an existing artifact. On a duplicate current request,
resume only work that is visibly incomplete.

## Context and Design

Read lane state and the requester-owned Canonical Contract. On a corrected
contract, compare its latest revision with lane state. If the current artifact
still satisfies it, keep the snapshot and refresh affected reviews. If the
design must change, create a Replacement Snapshot. Never edit the contract.

For round 1, inspect the repository as needed. Later rounds start from the
previous artifact, findings, and diff, while rechecking evidence affected by the
change. Write the smallest self-contained implementation-ready design at
`current_artifact`. Include only mechanisms required by the goal, repository, or
hard constraints.

Ask the user directly for a blocking product decision and append the exact
answer once. Multiple answers may share a round. Decide whether the current
artifact remains valid, then use the review-dispatch program; do not prepare
epochs or send review messages manually.

## Replacement Snapshot

Use a replacement after a complete report set requires document changes, or a
corrected initial contract changes an already-dispatched design. At the maximum,
first ask the user whether to stop or approve a higher exact value.

Create the next complete `rNNN.md` from the immutable current artifact. Only
after it is ready, atomically advance Round, move the old current path to
`previous_artifact`, point to the new path, and apply any new context, decision,
or maximum authority. Clear acceptance, but leave epoch preparation and stale
report clearing to the review-dispatch program. State must never point to an
incomplete snapshot.

## Review Dispatch

After the complete immutable artifact and any authority update are ready, run:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --workdir "<current workspace>" \
  --lane-state ".agent-artifacts/design-spec-dispatch/<task_id>.lock/state.json" \
  --json
```

This is the only valid draft review-dispatch path. It loads the layered TOML
workflow policy, measures the artifact, writes `review_gate`, prepares one epoch,
and sends reviewer and enabled-pruner requests. Never construct those requests,
write their epochs, or clear reports manually.

`PRUNER_REQUIRED` means no epoch or message was created. Resolve `design_pruner`
through the Tool Resolution Contract, require or create the deterministic sibling
session through the Session Host Contract using the recorded requester parent and
host, then rerun the same command with `--pruner-session-id` and
`--pruner-to-address`. Once enabled, the pruner remains enabled.

Receipts and send status are transport diagnostics, not lane state. Rerun the
same command after an unclear result; it reuses the prepared epoch. Use
`--new-epoch` only for an intentional same-artifact review under unchanged
authority.

When authority changes without changing the artifact, run normal dispatch; the
changed authority produces a new epoch. When reports disagree, resolve
the conflict from evidence or ask the relevant role to review the same snapshot
again with a short factual rationale. This remains an ordinary review request.

## Final Notification

When lane state satisfies its acceptance predicate, run the Gate Verification
defined by `lane-state`, record the accepted Round, artifact, and verified
SHA-256, then notify the requester:

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane State: <workspace-relative lane state file>
Round: <accepted_round>
Artifact SHA-256: <accepted artifact digest>
Decision: <SOUND | SOUND_WITH_CAVEATS>

## Caveats
- <exact accepted caveat in lane order | None>
```

Copy Caveats exactly from `correctness_report`. Use `None` for `SOUND`; require
at least one list item for `SOUND_WITH_CAVEATS`. The requester owns archival and
closeout.
