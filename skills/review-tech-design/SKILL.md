---
name: review-tech-design
description: Retain requester-owned design context and decision updates, then independently review a technical design specification against them. Use for design_spec_review_context intake, design_spec_review_requested messages, or direct technical-design review.
---

# Review Technical Design

Use `multi-agent-protocol` for shared transport. Determine the mode from the input, then read only the reference needed for that mode.

## Route First

- Any Waypost body with `Action: design_spec_review_context`: context intake mode; read `references/context-intake.md`.
- `Action: design_spec_review_requested` with `Mode: draft-round`: message review mode; read `references/draft-round-review.md`, then `references/message-delivery.md` when reporting or recovering context.
- `Action: design_spec_review_requested` with `Mode: committed-docs`: message review mode; read `references/committed-docs-review.md`, then `references/message-delivery.md` when reporting.
- Every other invocation: direct-use mode; review the readable target named by the user and read `references/message-delivery.md` for the report form. Do not send Waypost.

## Authority and Independence

- Treat the requester Design Task Contract and requester-delivered Decision Deltas as authority.
- Treat author-authored task framing, decision restatements, change summaries, and evidence conclusions as non-authoritative.
- Retain requester context by task. Missing requester context is a completeness failure, not permission to infer.
- Remain review-only. Do not edit a review target or reviewer-external state.
- For draft-review, write reviewer state only under `.agent-artifacts/design-review/<reviewer_session_id>/<task_id>/`; the author must not write it.
- Require a readable, self-contained target. A complete current target remains mandatory even when later-round review starts from a diff.

## Independent Review Frame

Before opening the target, derive from requester-owned context:

- intended user outcome;
- required behavior and compatibility constraints;
- explicit non-goals and ownership boundaries;
- the smallest coherent change that could satisfy the request.

Do not derive this frame from the author's design. Apply a deletion test before hardening any component: if removing it still satisfies the explicit goal and required compatibility, require removal or a requester decision.

Review as a skeptical senior engineer. Prioritize problem framing, smallest coherent approach, scope and over-design, ownership and boundaries, relevant state/configuration/compatibility effects, material risks and tradeoffs, failure behavior, and unresolved requester-owned decisions. This is not code review. Focus on the few findings most likely to change implementation confidence.

## Decision Rules

- `SOUND`: implementation-ready with no unresolved design findings or unapproved scope.
- `SOUND_WITH_CAVEATS`: deliverable with only non-blocking caveats already recorded in the target.
- `NEEDS_REVISION`: the design must change and receive another reviewed snapshot.
- `NEEDS_INPUT`: message-review input is incomplete or the target cannot be identified/read.

Do not use `SOUND_WITH_CAVEATS` when a document revision is required. Put requester-owned decisions under Questions To Resolve. Always report Persisted Data Changes.

## Review Limit

Require a positive Max Review Rounds in message review mode and require `Round <= Max Review Rounds`. Return NEEDS_INPUT without inspecting the target when the round exceeds the authorized maximum. A replacement snapshot advances the round; NEEDS_INPUT and same-snapshot reconsideration do not.

At a final-round NEEDS_REVISION, pause before sending the report. Explain why prior rounds did not converge and what another iteration could resolve; ask the user whether to stop or continue. If continued, choose a suitable next stopping point, record the new maximum in the held report, and resume the same lane.
