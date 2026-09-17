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
manifest. Read the Canonical Contract. A draft request can also open
implementation phase mid-lane (`Phase: implementation`, `Round: 1`,
`Structure: <accepted sNNN>`): record that structure with
`record-design-structure.mjs --structure-doc` before drafting `r001`.

## Draft

In an unattended lane, continue from drafting through report handling,
revision, acceptance, and delivery in one workflow; a draft is not a
progress-report point. Pause only for a Contract-required user decision, a
non-converging checkpoint, or a blocker on the next authorized action.

For round 1, inspect the repository. In later rounds, reread the
Canonical Contract and sketch the minimum architecture from repository evidence
before reading the prior artifact or reports. Keep verified repository facts in
your task evidence ledger per `multi-agent-protocol/evidence-ledger`. Treat the
prior design and reports as evidence, not authority or a patch list. Success
means satisfying the user-authoritative Contract with an implementable design;
reviewer and pruner approval is not a design objective.

On a two-phase lane the request's `Phase` selects the series:

- `structure` — `sNNN.md`: the minimum complete structural specification —
  boundaries, ownership, data flow, lifecycle/rollback boundaries, and the
  interfaces this lane consumes or exposes. Consume other lanes through
  interfaces only; keep coder-level detail out.
- `implementation` — `rNNN.md` against the manifest's recorded `structure_doc`:
  elaborate that frozen structure into a coder-implementable specification.
  Detail within it; never silently redefine what it fixes. Evidence that the
  structure itself is wrong follows `tech-design-workflow/structure-amendment`.

A single-phase lane uses `rNNN.md` covering both structure and detail.

Write the smallest complete artifact at
`.agent-artifacts/design-spec/<author_session_id>/sNNN.md` or `rNNN.md`.

**IMMUTABILITY INVARIANT:** Once an `sNNN.md` or `rNNN.md` snapshot is
dispatched, committed, or included in a review request, it is immutable: never
edit, overwrite, or reformat it. Any revision, including a wording fix,
goes to the next numbered snapshot in the same series as a separate artifact.
The same holds for a dispatched `sNNN.notes.md` or `rNNN.notes.md`.

Write for a coder who did not observe the workflow: the current intended change
and the decisions, boundaries, and consequences material to safe
implementation; rationale only for non-obvious choices. The artifact is a
specification, not drafting history — omit review dialogue, Q&A transcripts,
exploration notes, workflow metadata, and discarded ideas.

Resolve technical questions from evidence. If a product or scope choice blocks
drafting, ask the user directly.

Before dispatching a revision, write `sNNN.notes.md` or `rNNN.notes.md` next to
the snapshot — one disposition per finding in the reports and requester
rejection findings, `None` when there were none:

- `accept`: valid under the Contract and repository evidence; apply it. A
  structural finding re-baselines from the minimum architecture; never patch
  around it.
- `rebut`: invalid or outweighed; state the evidence. Rebutted findings do not
  drive the design; the notes ride the dispatch and the role concedes or
  re-raises naming what the rebuttal did not answer.
- `escalate`: only under a stop condition below; name it.

Stop conditions, in order — ask the user only after evidence fails:

1. A product, scope, or authority decision the Contract and repository cannot
   answer — including one conflicting with a user requirement, non-goal,
   compatibility boundary, or trade-off.
2. Reviewer and pruner demand contradictory resolutions of one decision with
   no Contract-faithful intersection; report the intersection tried or why
   none exists, both positions, and the evidence.
3. Measurable non-convergence: unresolved findings did not shrink across two
   consecutive reviewed rounds, or a finding family recurred after an accepted
   fix.

Record every exact user answer as a User Decision Delta and increment
Context Revision before resuming.

If the just-reviewed round reached its phase checkpoint (`structure_checkpoint`
for `sNNN`, `review_checkpoint` for `rNNN`), first retrieve
`agentgear skill get tech-design-workflow/author-convergence`; its convergence
assessment goes into the next round's notes before dispatch.

## Review Dispatch

After the artifact is complete, run from the author workspace:

```bash
agentgear run tech-design-workflow dispatch-design-review.mjs \
  --lane-manifest ".agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json" \
  --phase "<structure|implementation>" \
  --artifact ".agent-artifacts/design-spec/<author_session_id>/<sNNN|rNNN>.md" \
  --previous-artifact ".agent-artifacts/design-spec/<author_session_id>/<sMMM|rMMM>.md" \
  --rationale-file ".agent-artifacts/design-spec/<author_session_id>/<sNNN|rNNN>.notes.md" \
  --round "<round>" \
  --context-revision "<current contract revision>" \
  --json
```

`--phase` is required on a two-phase lane and selects the series and
checkpoint; a single-phase lane omits it. An implementation dispatch also
requires `--structure-doc <recorded sNNN path>` equal to the manifest. Omit
`--previous-artifact` for round 1 of a series; later it is the immediately
preceding snapshot.

From round 2 the dispatch requires `--rationale-file`, this round's own notes
file carrying your dispositions to each role. After `MINIMAL`, pass that
exact snapshot as `--pruner-baseline-artifact` on later same-phase dispatches.
Add `--major-structure-change` when the revision materially reorganizes
boundaries, ownership, data flow, rollout, or another defining structure;
local fixes and wording changes do not qualify. The dispatcher
measures cumulative additions from the baseline. Baseline and
structural-change options are structure-phase only: an `rNNN` dispatch goes
to the reviewer alone, and the pruner enters through `author-delivery`'s
post-acceptance gate. A structural concern rides `structure-amendment`.

`USER_CHECKPOINT_REQUIRED` means no request was sent; use `author-convergence`.

`PRUNER_REQUIRED` means nothing was sent. Resolve or recover the lane's one
`design_pruner`, then rerun with its session ID and address. `TARGET_SESSION_*`
means nothing was sent; re-resolve that role's session and rerun.

Receipts and nudge outcomes are transport diagnostics. Sends are sequential and
each notify step is slow, so a run can take about a minute; it reports `sending
<stage>...` and `delivery_id=` on stderr as each send becomes durable. If the
call returns while still running, keep polling that session until it exits —
never start a second invocation; re-running always sends again. A returned
delivery id is final durable success; a failed or unknown nudge replays only
the fixed session-host wake notice unless the delivery is already leased or
acknowledged. Do not rerun the dispatcher to repair a nudge; after an unclear
durable send, inspect Waypost before retrying.

## Reports and Delivery

On `design_spec_review_report`, `design_prune_report`, or
`design_spec_delivery_rejected`, retrieve
`agentgear skill get tech-design-workflow/report-handling`. Wait for both
reports when a pruner was requested. Handle `NEEDS_REVISION`/
`NEEDS_SIMPLIFICATION` through the dispositions above; an implementation-phase
`structural` finding cannot be fixed inside the recorded structure — retrieve
`tech-design-workflow/structure-amendment` instead of revising `rNNN` around
it.

When the artifact is accepted, retrieve
`agentgear skill get tech-design-workflow/author-delivery` and deliver it.
