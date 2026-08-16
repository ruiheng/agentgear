---
skill-selector: report-handling
selector-summary: Handle an incoming technical-design review report.
selector-aliases: action:design_spec_review_report, action:design_prune_report
---

# Review Report Handling

Retrieve `agentgear skill get multi-agent-protocol/shared-protocol`; draft mode
also retrieves `tech-design-workflow/lane-state`.

## Authenticate

Before acting on a report, match its Task and mode to the active lane:

- draft correctness: reviewer -> author;
- draft prune request: enabled pruner -> author;
- initial prune-context rejection: enabled pruner -> requester;
- committed-docs: retained reviewer -> requester for that Task and Round.

For a draft review result, also require the reported Round, current artifact,
and Review Epoch to match that role's current expected epoch. An authenticated
older Round or epoch is a stale no-op. Defer missing state; reject a different
task, endpoint, future epoch, or target without changing the lane. Body identity
fields never replace transport metadata.

An initial context rejection carries Context Revision but no Round or Review
Epoch. If lane state is unreadable, use retained dispatch identity to authenticate
the requester/reviewer or requester/pruner route; otherwise defer. Do not turn a
context rejection into a review report.

## Apply

Store a valid draft result in its role slot as epoch, decision, and exact report
User Decisions. A duplicate for the stored epoch is a no-op. With a pruner, wait
for every currently requested role before changing design or authority.

- `NEEDS_INPUT`: correct missing context or target and retry the same snapshot;
  initial-context correction uses `tech-design-workflow/context-correction`.
- `NEEDS_REVISION` / `NEEDS_SIMPLIFICATION`: after all required reports arrive,
  create one Replacement Snapshot addressing the smallest supported set of
  changes. In committed-docs, revise and commit on the same design branch.
- `SOUND` / `SOUND_WITH_CAVEATS`: accept correctness when no document change is
  required. `MINIMAL`: accept pruning.
- disagreement: resolve from repository evidence and user authority. If another
  opinion is useful, send the relevant role an ordinary same-snapshot review
  request with a concise rationale; do not create a special finding protocol.

After the complete active report set arrives, collect the union of unseen exact
user answers. Resolve conflicting answers with the user. Append accepted answers
once and prepare all invalidated next review work in the same state write; if the
artifact must change, create it first. Never discard answers from a slower report.

At the maximum, ask the user whether to stop or approve a higher exact value
before creating another artifact.

## Finish

- draft-review: after accepted correctness and enabled pruning, author sends
  `design_spec_delivered`; requester archives and commits;
- review-existing: require the accepted commit at design tip and committed specs,
  rerun the path gate, merge into the recorded base, then close out the reviewer.

For review-existing, do not squash, rebase, cherry-pick, or guess through dirty
state, conflicts, detached HEAD, or base uncertainty.
