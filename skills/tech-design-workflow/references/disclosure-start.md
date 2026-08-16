---
skill-selector: start
selector-summary: Complete tech-design-workflow instructions, part 1.
---

# Technical Design Workflow

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for the shared transport and session protocol. Read only the reference required by the current action; load another reference only when the action explicitly crosses into it.

## Route First

- New draft-review lane: retrieve `agentgear skill get tech-design-workflow/draft-review`.
- New review-existing lane: retrieve `agentgear skill get tech-design-workflow/review-existing`.
- `design_spec_draft_requested` or `design_spec_context_corrected`: retrieve `agentgear skill get tech-design-workflow/author-round`.
- `design_spec_review_report` or `design_prune_report`: retrieve `agentgear skill get tech-design-workflow/report-handling`.
- `design_spec_review_context_rejected`: retrieve `agentgear skill get tech-design-workflow/context-correction`.
- `design_spec_delivered`: retrieve `agentgear skill get tech-design-workflow/requester-delivery`.
- After the accepted design is authoritative: retrieve `agentgear skill get tech-design-workflow/closeout`.

For a new request, choose draft-review when no defensible committed specification exists or material technical choices remain unresolved. Choose review-existing only for committed specifications with a known branch, base, and complete user context. Do not make the requester invent a specification merely to obtain review.

## Core Contract

- The user owns task authority. Any lane agent asks the user directly when a decision blocks its work and records the exact answer in a User Decision Delta; never route the question through another agent.
- The requester starts the lane and delivers the accepted result.
- The architect-author writes complete draft snapshots and handles reviewer dialogue.
- The architect-reviewer independently reviews without editing the target.
- Draft-review may add one `design_pruner` that only removes unnecessary design. Resolve this once at lane start; an explicit user choice wins.
- In draft-review, author, reviewer, and an enabled pruner are distinct sibling sessions. They read one shared lane state; messages only identify the task and review generation to process.
- The requester is the only Canonical Contract writer. The dispatcher initializes lane state and marks context dispatch ready; afterward the author is its only writer. Reviewer and pruner remain read-only.
- Preserve the original request or authoritative handoff verbatim in the Canonical Design Task Contract. Keep requester normalization separate.
- Store that contract once under `.agent-artifacts/message/` and reference it from `.agent-artifacts/design-spec-dispatch/<task_id>.lock/state.json`. Keep the lane state and contract through closeout.
- Write draft rounds only under `.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. Only the author edits that directory.
- Keep every delivered round complete and self-contained. For a replacement snapshot, copy the current immutable snapshot to the next numbered path before revision and never edit a dispatched round.
- Keep drafting read-only with respect to Git state and workspace ownership.
- Store a positive Max Review Rounds in lane state; default to 5 only for a new lane. NEEDS_INPUT and same-snapshot review do not increment it.
- On round 2 and later, require the immediately preceding immutable snapshot. The reviewer reuses diff-first evidence only when that snapshot has completed review; otherwise it reviews the current artifact in full and uses the diff only for navigation.
- Never use an author-written change summary as review evidence.
- Treat every Waypost send as fire-and-forget. Never auto-resend outside explicit troubleshooting.

## Canonical Design Task Contract

Use this form and omit empty optional sections:

```markdown
Context Revision: 1

## Original Request
[Verbatim original wording, or authoritative handoff text and its source.]

## Requester Context
- Desired outcome: [normalized outcome]
- Must preserve: [required behavior or boundary]
- Established facts: [facts both architects may rely on]
- Read first: [required repository paths]

## Constraints
- [hard constraint]

## Open Questions
- [architect-owned technical question]

## Optional Review Focus
[Requester emphasis; never an exhaustive review boundary.]
```

The requester increments Context Revision for an authenticated complete correction; no other role edits this file. Treat this contract and exact user answers recorded in User Decision Deltas as authority. Agent summaries are not authority; the design artifact is a proposal against the user context.

## Shared Invariants

- Use `session_require` and `session_create` only through `agentgear skill get multi-agent-protocol/session-host`; retrieve `agentgear skill get tech-design-workflow/draft-review` before creating sessions.
- Keep transport metadata, launch commands, and provider-specific values out of task contracts and design artifacts.
- Ask the user directly when product scope blocks the current role; otherwise exclude optional capability.
- Keep findings and revisions proportional to the stated goal. Do not add a section or mechanism merely to satisfy a checklist.
