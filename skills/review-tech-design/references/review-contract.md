---
skill-selector: review-contract
selector-summary: Apply the canonical authority, independence, decision, and round rules for technical-design review.
---

# Technical Design Review Contract

## Authority and Independence

- Treat the Design Task Contract and exact user answers in User Decision Deltas as authority.
- Treat agent summaries, change summaries, and evidence conclusions as non-authoritative.
- Retain user context by task. Missing context is a completeness failure, not permission to infer.
- Remain review-only. Do not edit a review target or reviewer-external state.
- For draft-review, write reviewer state only under `.agent-artifacts/design-review/<reviewer_session_id>/<task_id>/`; the author must not write it.
- Require a readable, self-contained target. A complete current target remains mandatory even when later-round review starts from a diff.
- Reuse a prior conclusion only when the Canonical Contract and retained User Decisions are unchanged. New authority requires a new review frame; unchanged repository facts may still be reused.

## Independent Review Frame

Before opening the target, derive from user-authoritative context:

- intended user outcome;
- required behavior and compatibility constraints;
- explicit non-goals and ownership boundaries.

Do not derive this frame from the author's design. Review material design risks against user-authoritative context and repository evidence. Do not request machinery for hypothetical requirements or run `prune-tech-design`'s general deletion/minimality pass. This is not code review.

## Decision Rules

- `SOUND`: implementation-ready with no unresolved design findings or unapproved scope.
- `SOUND_WITH_CAVEATS`: deliverable with only non-blocking caveats that are
  recorded verbatim as the same ordered list under `## Caveats` in the reviewed
  target and the review report.
- `NEEDS_REVISION`: the design must change and receive another reviewed snapshot.
- `NEEDS_INPUT`: message-review input is incomplete or the target cannot be identified/read.

Do not use `SOUND_WITH_CAVEATS` when a document revision is required. If a
non-blocking caveat is absent from the target, return `NEEDS_REVISION` so the
author can add it before acceptance. Ask the user directly when a product or
strategy decision blocks review, and record the exact answer under User
Decisions. Report persisted-data effects only when relevant.

## Review Limit

Require a positive Max Review Rounds in message review mode and require `Round <= Max Review Rounds`. In committed-docs, compare it with retained authority; any change requires an exact User Decision Delta approving the new value. Return NEEDS_INPUT without inspecting the target when the round exceeds the authorized maximum. A replacement snapshot advances the round; NEEDS_INPUT and same-snapshot review do not.

Send final-round results normally. The session that requested the review owns the stop-or-extend decision before creating another target.
