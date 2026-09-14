---
skill-selector: author-round
selector-summary: Draft or revise one technical design snapshot and request review.
selector-aliases: action:design_spec_draft_requested
---

# Author Round

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol tech-design-workflow/lane-manifest`.

Retrieve `agentgear skill get search-files` before locating files or code
across the workspace, and apply its ready-tool guidance.

Authenticate the requester/author transport endpoints and Task against the lane
manifest. Read the Canonical Contract. Duplicate work is recognizable from the
existing artifact and retained conversation.

## Draft

In an unattended lane, continue from drafting through report handling,
revision, acceptance, and delivery in one workflow; a draft is an
intermediate artifact, not a progress-report point. Pause only when the
Contract requires a user decision, a checkpoint finds non-convergence, or a
blocker prevents the next authorized action.

For round 1, inspect the repository. In later rounds, reread the
Canonical Contract and sketch the minimum architecture from repository evidence
before reading the prior artifact or reports. Keep verified repository facts in
your task evidence ledger and reuse them per
`multi-agent-protocol/evidence-ledger`. Treat the prior design and
reports as evidence, not authority or a patch list. Success means satisfying
the user-authoritative Contract with an implementable design; reviewer and
pruner approval is not a design objective.

Write the smallest complete, implementation-ready design at
`.agent-artifacts/design-spec/<author_session_id>/rNNN.md`.

**IMMUTABILITY INVARIANT:** Once an `rNNN.md` snapshot is dispatched,
committed, or included in a review request, it is immutable. Never edit,
overwrite, append to, or reformat that path. Any revision, including a wording
fix, must be written to the next numbered snapshot (`rNNN+1.md`) and the new
snapshot must be dispatched as a separate artifact. Reports and closeout refer
to the exact reviewed snapshot; the same holds for a dispatched
`rNNN.notes.md`.

Write for a coder who did not observe the workflow. Describe the current
intended change and only the decisions, boundaries, and consequences material
to safe implementation. Include rationale only for non-obvious choices.

The artifact is a specification, not drafting history. Omit review dialogue,
question-and-answer transcripts, exploration notes, workflow metadata, and
discarded ideas. Apply accepted requirements and design decisions where
relevant; discard process details with no implementation value.

Resolve technical questions from evidence. If a product or scope choice blocks
drafting, ask the user directly.

Before dispatching a revision, write `rNNN.notes.md` next to the snapshot —
one disposition per finding in the reports, `None` when there were none:

- `accept`: valid under the Contract and repository evidence; apply it.
  A structural finding re-baselines the invalid boundary, ownership model,
  data flow, lifecycle, or core assumption from the minimum architecture;
  never patch around it.
- `rebut`: invalid or outweighed; state the evidence. Rebutted findings do not
  drive the design; the dispatch carries the notes and the role concedes or
  re-raises naming what the rebuttal did not answer.
- `escalate`: only under a stop condition below; name it.

Stop conditions, in order — ask the user only after evidence fails:

1. A product, scope, or authority decision the Contract and repository cannot
   answer — including one conflicting with a user requirement, non-goal,
   compatibility boundary, or core trade-off.
2. Reviewer and pruner demand contradictory resolutions of one decision with
   no Contract-faithful intersection; report the intersection you tried or why
   none exists, both positions, and the evidence.
3. Measurable non-convergence: unresolved findings did not shrink across two
   consecutive reviewed rounds, or a finding family recurred after an accepted
   fix.

Record every exact user answer as a User Decision Delta and increment Context
Revision before resuming.

If the just-reviewed round reached `review_checkpoint`, first retrieve
`agentgear skill get tech-design-workflow/author-convergence`; its convergence
assessment goes into the next round's notes file before dispatch.

## Review Dispatch

After the artifact is complete, run from the author workspace:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --artifact ".agent-artifacts/design-spec/<author_session_id>/rNNN.md" \
  --previous-artifact ".agent-artifacts/design-spec/<author_session_id>/rMMM.md" \
  --rationale-file ".agent-artifacts/design-spec/<author_session_id>/rNNN.notes.md" \
  --round "<round>" \
  --context-revision "<current contract revision>" \
  --json
```

Omit `--previous-artifact` for round 1. From round 2 the dispatch requires
`--rationale-file` — this round's own notes file — carrying your dispositions
to each role. After `MINIMAL`, pass that exact snapshot
as `--pruner-baseline-artifact` on later normal dispatches. Add
`--major-structure-change` when the revision materially reorganizes
boundaries, ownership, data flow, rollout, or another defining structure;
local fixes and wording changes do not qualify. The dispatcher
measures cumulative additions from the baseline.

`USER_CHECKPOINT_REQUIRED` means no request was sent; use `author-convergence`.

`PRUNER_REQUIRED` means nothing was sent. Resolve or recover the lane's one
`design_pruner`, then rerun with its session ID and address.

Receipts and nudge outcomes are transport diagnostics. The dispatcher sends each
request in order and each notify step is slow, so a run can take about a minute;
it reports `sending <stage>...` and `delivery_id=` on stderr as each send
becomes durable. If the call returns while it is still running, keep polling
that same session until it exits — never start a second invocation; re-running
always sends again. Within one invocation, a returned delivery id is final
durable success and never causes another Waypost send. If its nudge failed or is
unknown, the dispatcher checks that delivery and sends only the fixed
session-host wake notice unless it is already leased or acknowledged. Failure to
read delivery state does not block that one replay. Do not rerun the dispatcher
to repair a nudge. After an unclear durable send, inspect Waypost before
retrying.

## Reports and Delivery

Authenticate reviewer and optional pruner reports by their actual transport
endpoints, Task, Round, and artifact. Keep reports in their messages. Wait for
both reports when a pruner was requested.

Handle `NEEDS_REVISION`/`NEEDS_SIMPLIFICATION` through the dispositions above.
`NEEDS_REVISION` must name a blocking finding; one naming none is contestable
through the notes, not a defect to patch.
Apply reviewer-collected answers through `report-handling`. `MINIMAL`
establishes the reviewed artifact as the next pruner baseline.

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
