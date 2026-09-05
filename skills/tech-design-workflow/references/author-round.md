---
skill-selector: author-round
selector-summary: Draft or revise one technical design snapshot and request review.
selector-aliases: action:design_spec_draft_requested
---

# Author Round

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Authenticate the requester/author transport endpoints and Task against the lane
manifest. Read the Canonical Contract. Duplicate work is recognizable from the
existing artifact and retained conversation.

## Draft

For round 1, inspect the repository as needed. In later rounds, reread the
Canonical Contract and sketch the minimum architecture from repository evidence
before reading the prior artifact or reports. Treat the prior design and
 reports as evidence, not authority or a patch list. Success means satisfying
 the user-authoritative Contract with an implementable design; reviewer and
 pruner approval is not a design objective.
Write the smallest complete, implementation-ready design at
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`.

Write for a coder who did not observe the workflow. Describe the current
intended change and only the decisions, boundaries, and consequences material
to safe implementation. Include rationale only for non-obvious choices.

The artifact is a specification, not drafting history. Omit review dialogue,
question-and-answer transcripts, exploration notes, workflow metadata, and
discarded ideas. Apply accepted requirements and design decisions where
relevant; discard process details with no implementation value. Ask the user
about an implementation-blocking choice; do not copy the discussion into the
specification.

Resolve technical questions from evidence. If a product or scope choice blocks
drafting, ask the user directly. Append the exact question and answer as a User
Decision Delta and increment Context Revision before resuming. A dispatched
round is review evidence; changes go into the next numbered snapshot.

Before revising, classify findings as local or structural and validate them
against the Contract and repository. Re-baseline any invalid boundary,
ownership model, data flow, lifecycle, or core assumption from the minimum
architecture; do not patch around it. If reviewer and pruner findings conflict
on a decision, or repeated fixes fail to converge, ask the user to choose before
writing another snapshot. Record the exact answer as a User Decision Delta.

If any feedback conflicts with a user requirement, non-goal, compatibility
boundary, or core trade-off, ask the user rather than reconciling it yourself.

After a checkpoint round is reviewed, do not create another artifact. Stop and
report the suspected structural risk, its evidence, affected user outcome, and
available directions to the user. Treat failure to deliver by the checkpoint as
evidence of a structural problem unless you name evidence that rules out that
specific risk and explains why the design is now deliverable. Ask the user to
stop, redirect, or continue only after that analysis. If they continue, advance
the checkpoint and resume the same lane:

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

Omit `--previous-artifact` for round 1. After `MINIMAL`, pass that exact snapshot
as `--pruner-baseline-artifact` on later normal dispatches. Add
`--major-structure-change` when the author judges that the revision materially
reorganizes boundaries, ownership, data flow, rollout, or another defining
structure. Local fixes and wording changes do not qualify. The dispatcher
measures cumulative additions from the baseline.

`USER_CHECKPOINT_REQUIRED` means no request was sent; use the checkpoint flow above.

`PRUNER_REQUIRED` means nothing was sent. Resolve or recover the lane's one
`design_pruner`, then rerun with its session ID and address.

Receipts and nudge outcomes are transport diagnostics. Within one invocation, a
returned delivery id is final durable success and never causes another Waypost
send. If its nudge failed or is unknown, the dispatcher checks that delivery and
sends only the fixed session-host wake notice unless it is already leased or
acknowledged. Failure to read delivery state does not block that one replay. Do
not rerun the dispatcher to repair a nudge. After an unclear durable send,
inspect Waypost before retrying.

## Reports and Delivery

Authenticate reviewer and optional pruner reports by their actual transport
endpoints, Task, Round, and artifact. Keep reports in their messages. Wait for
both reports when a pruner was requested.

Revise on `NEEDS_REVISION` or `NEEDS_SIMPLIFICATION`; use the direct-user flow
above when a product or scope choice blocks revision. Apply reviewer-collected
answers through `report-handling`. `MINIMAL` establishes the reviewed artifact
as the next pruner baseline.

Deliver after correctness accepts the artifact and, unless policy is `never`,
the enabled pruner has accepted that same artifact with `MINIMAL`. When an
accepted reviewer-only revision has no pruner report, request one for that
snapshot with `--pruner-only` and the pruner identity, omitting
baseline/structure options. It sends only to the pruner and keeps the round.

```markdown
Task: <task_id>
Action: design_spec_delivered
Lane Manifest: <workspace-relative lane manifest>
Artifact: <accepted artifact>
Round: <accepted round>
Decision: <SOUND | SOUND_WITH_CAVEATS>
[Pruner Decision: MINIMAL]
[Pruner Session ID: <lazy pruner real id>]

## Caveats
- <exact accepted caveat in artifact order | None>
```

Use `None` for `SOUND`. Include `Pruner Decision` unless policy is `never`.
Include the lazy pruner session ID only when the requester did not create it.
The requester owns assessment, archival, and closeout.
