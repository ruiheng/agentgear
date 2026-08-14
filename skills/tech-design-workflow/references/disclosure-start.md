---
skill-selector: start
selector-summary: Complete tech-design-workflow instructions, part 1.
---

# Technical Design Workflow

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for the shared transport and session protocol. Read only the reference required by the current action; load another reference only when the action explicitly crosses into it.

## Route First

- New draft-review lane: retrieve `agentgear skill get tech-design-workflow/draft-review`.
- New review-existing lane: retrieve `agentgear skill get tech-design-workflow/review-existing`.
- `design_spec_draft_requested`, `design_spec_context_corrected`, or author-addressed `design_spec_review_context_recovery_requested`: retrieve `agentgear skill get tech-design-workflow/author-round`.
- `design_spec_review_report`: retrieve `agentgear skill get tech-design-workflow/report-handling`.
- `design_spec_review_context_rejected`, `design_spec_decision_requested`, or requester-addressed `design_spec_review_context_recovery_requested`: retrieve `agentgear skill get tech-design-workflow/requester-handling`.
- `design_spec_delivered`: retrieve `agentgear skill get tech-design-workflow/requester-delivery`.
- After the accepted design is authoritative: retrieve `agentgear skill get tech-design-workflow/closeout`.

For a new request, choose draft-review when no defensible committed specification exists or material technical choices remain unresolved. Choose review-existing only for committed specifications with a known branch, base, and complete requester context. Do not make the requester invent a specification merely to obtain review.

## Core Contract

- The requester owns task authority and user-facing handoff.
- The architect-author writes complete draft snapshots and handles reviewer dialogue.
- The architect-reviewer independently reviews without editing the target.
- In draft-review, author and reviewer are distinct sibling sessions and receive the same canonical requester contract; later requester decisions go to reviewer first, then author.
- Preserve the original request or authoritative handoff verbatim in the Canonical Design Task Contract. Keep requester normalization separate.
- Write draft rounds only under `.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. Only the author edits that directory.
- Keep every delivered round complete and self-contained. For a replacement snapshot, copy the reviewed round to the next numbered path before revision and never edit a dispatched round.
- Keep drafting read-only with respect to Git state and workspace ownership.
- Store and carry a positive Max Review Rounds; default to 5 only for a new lane. NEEDS_INPUT and same-snapshot reconsideration do not increment it.
- On round 2 and later, require an exact prior reviewed target and diff-first review. The complete current artifact remains authoritative; an ordinary diff is navigation evidence.
- Never use an author-written change summary as review evidence.
- Treat every Waypost send as fire-and-forget. Never auto-resend outside explicit troubleshooting.

## Canonical Design Task Contract

Use this form and omit empty optional sections:

```markdown
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

Treat this contract and requester-delivered Decision Deltas as authority. Treat the design artifact as a proposal against that authority.

## Shared Invariants

- Use `session_resolve`, `session_require`, and `session_create` only through `agentgear skill get multi-agent-protocol/session-host`; retrieve `agentgear skill get tech-design-workflow/draft-review` before creating sessions.
- Keep transport metadata, launch commands, and provider-specific values out of task contracts and design artifacts.
- Do not resolve user-owned product scope through engineering judgment. Exclude optional capability or use a Decision Request.
- Keep findings and revisions proportional to the stated goal. Do not add machinery merely to satisfy a template.
