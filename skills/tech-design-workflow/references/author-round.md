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
artifact remains valid, then prepare the required review work in the same state
write as the authority change.

## Replacement Snapshot

Use a replacement after a complete report set requires document changes, or a
corrected initial contract changes an already-dispatched design. At the maximum,
first ask the user whether to stop or approve a higher exact value.

Create the next complete `rNNN.md` from the immutable current artifact. Only
after it is ready, atomically advance Round, move the old current path to
`previous_artifact`, point to the new path, apply any new context/decision/
maximum authority, prepare new review epochs for reviewer and enabled pruner,
clear their reports, and clear acceptance. State must never point to an
incomplete snapshot.

## Review Dispatch

Before a new review request, atomically increment `review_epoch`, assign it to
each affected role's expected epoch, clear that role's stale report, and clear
acceptance. Do not allocate another epoch when the preceding authority or
replacement write already prepared it.

Send from `author_to_address` to the role recorded in lane state. Review messages
carry only the current Task, lane path, Round, and Review Epoch:

```markdown
Task: <task_id>
Action: design_spec_review_requested
Lane State: <workspace-relative lane state file>
Review Epoch: <positive epoch>
Round: <round>
```

For an enabled pruner:

```markdown
Task: <task_id>
Action: design_prune_requested
Lane State: <workspace-relative lane state file>
Review Epoch: <positive epoch>
Round: <round>
```

Receipts and send status are transport diagnostics, not lane state. If a send
result is unclear, stop and report it. An explicit retry may repeat the same
message: receivers recognize a completed or stale epoch and do not redo work.

When authority changes without changing the artifact, request normal full
review of the same snapshot under a new epoch. When reports disagree, resolve
the conflict from evidence or ask the relevant role to review the same snapshot
again with a short factual rationale. This remains an ordinary review request.

## Final Notification

When lane state satisfies its acceptance predicate, record the accepted Round
and artifact, then notify the requester:

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane State: <workspace-relative lane state file>
Round: <accepted_round>
Decision: <SOUND | SOUND_WITH_CAVEATS>

## Caveats
- <exact accepted caveat in lane order | None>
```

Copy Caveats exactly from `correctness_report`. Use `None` for `SOUND`; require
at least one list item for `SOUND_WITH_CAVEATS`. The requester owns archival and
closeout.
