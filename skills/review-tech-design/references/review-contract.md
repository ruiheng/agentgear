---
skill-selector: review-contract
selector-summary: Apply the canonical authority, independence, decision, and round rules for technical-design review.
---

# Technical Design Review Contract

## Authority and Independence

- Treat the Design Task Contract and exact user answers in User Decision Deltas as authority.
- Review whether the design serves that authority; reviewer agreement is not a goal and is never a substitute for user requirements.
- Treat other roles' summaries, change summaries, and evidence conclusions as non-authoritative; your own ledger facts stay verified per `multi-agent-protocol/evidence-ledger`.
- Retain user context by task. Missing context is a completeness failure, not permission to infer.
- Remain review-only. Do not edit a review target or reviewer-external state.
- For draft-review, write reviewer state only under `.agent-artifacts/design-review/<reviewer_session_id>/<task_id>/`; the author must not write it.
- Record verified repository facts in your task evidence ledger per `multi-agent-protocol/evidence-ledger`; facts held only in conversation do not survive context compaction.
- Require a readable, self-contained target. A complete current target remains mandatory even when later-round review starts from a diff.
- Require a coder-facing specification of the current intended change, not a
  record of drafting, review, questions, or exploration. Require accepted
  requirements and design decisions only where relevant to implementation.
- Reuse a prior conclusion only when the Canonical Contract and retained User Decisions are unchanged. New authority requires a new review frame; unchanged repository facts may still be reused.

## Independent Review Frame

Before opening the target, derive from user-authoritative context:

- intended user outcome;
- required behavior and compatibility constraints;
- explicit non-goals and ownership boundaries.

Do not derive this frame from the author's design. Review material design risks against user-authoritative context and repository evidence. Do not request machinery for hypothetical requirements or run `prune-tech-design`'s general deletion/minimality pass. This is not code review.

Flag root-level misalignment between the design and the user's outcome,
non-goals, compatibility boundaries, or core trade-offs even when the proposed
implementation is internally coherent.

## Decision Rules

Tag every finding `(blocking|advisory)`; for round 2 and later also
`(regression|standing)`:

- `blocking`: the design violates the Contract or a user decision, or leaves a
  decision the spec must own — persisted shapes, wire/API contracts, ownership,
  concurrency and rollback boundaries, migrations, acceptance evidence —
  ambiguous enough that a coder could implement it wrong. A caveat the target
  must record is blocking while absent.
- `advisory`: improves the document without changing what a coder builds.
- `regression`: this revision broke something the previous artifact had right.
- `standing`: the gap predates this revision. On content unchanged across two
  or more reviewed rounds, state the new evidence or why earlier review missed
  it; a standing finding without that justification is weak.

Decide:

- `SOUND`: no blocking findings; implementation-ready with no unapproved scope.
  Advisory findings may still be listed.
- `SOUND_WITH_CAVEATS`: deliverable with only non-blocking caveats that are
  recorded verbatim as the same ordered list under `## Caveats` in the reviewed
  target and the review report.
- `NEEDS_REVISION`: at least one blocking finding; the design must change and
  receive another reviewed snapshot.
- `NEEDS_INPUT`: message-review input is incomplete, mismatched, or unreadable.

Do not use `SOUND_WITH_CAVEATS` when a document revision is required. Resolve technical uncertainty from the
repository and contract. When required user input genuinely blocks review, ask
the user directly and wait for the answer before producing the report. Include
the exact question and answer under User Decisions; do not emit a report with an
unanswered user-input question. Report persisted-data effects only when
relevant.

NEEDS_INPUT and same-snapshot review do not advance the round.
