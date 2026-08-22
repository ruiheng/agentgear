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

For a new request, choose draft-review when no defensible committed specification exists or material technical choices remain unresolved. Choose review-existing for committed specifications with a known branch, base, and complete user context.

## Core Contract

- The user owns task authority. Resolve technical questions from evidence. When user input is required, the blocked role asks the user directly; the requester only records the answer in a User Decision Delta.
- The requester starts the lane and delivers the result. The author drafts and revises; the reviewer independently assesses each dispatched snapshot.
- Draft-review may add one `design_pruner` that only removes unnecessary design. Start it at lane creation only when the user explicitly requires it. Otherwise the deterministic review dispatcher activates it when the current artifact reaches the configured size threshold; an explicit user prohibition wins.
- In draft-review, author, reviewer, and an enabled pruner are distinct sibling sessions. Lazy activation creates the pruner as another sibling before review dispatch.
- The lane manifest holds compact lane metadata and the current review checkpoint. Participant routes stay stable.
- The requester maintains the Canonical Contract. Reviewer and pruner report findings; the author owns draft artifacts.
- Preserve the original request or authoritative handoff verbatim in the Canonical Design Task Contract. Keep requester normalization separate.
- Store that contract once under `.agent-artifacts/message/` and reference it from `.agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json`. Keep the manifest and contract through closeout.
- Store complete draft rounds under `.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. A dispatched round is review evidence, so revisions use the next numbered snapshot.
- Keep drafting read-only with respect to Git state and workspace ownership.
- Review checkpoints trigger user direction checks, not hard limits. The author asks after round 5, then every 2 rounds (7, 9, 11, ...). Continue in the same lane with its sessions and history. NEEDS_INPUT and same-snapshot review do not increment the round.
- On round 2 and later, include the immediately preceding dispatched snapshot. Use diff-first evidence after that snapshot completed review; otherwise review the current artifact in full and use the diff for navigation.
- Review from repository evidence and exact artifacts; use author summaries only for navigation.
- Treat Waypost sends as fire-and-forget. Retry only while troubleshooting an unclear delivery.

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
[Requester emphasis; reviewers still assess the full goal.]
```

The requester maintains the contract and increments Context Revision for a complete product or scope correction. Treat the contract and exact user answers as authority; the design artifact remains a proposal against that context. Continuing at a review checkpoint changes workflow state only, so it does not revise this contract.

## Shared Invariants

- Use the shared Session Host Contract for session creation and recovery; retrieve `tech-design-workflow/draft-review` before creating draft-lane sessions.
- Keep transport metadata, launch commands, and provider-specific values out of task contracts and design artifacts.
- Ask the user when scope or strategy needs their authority.
- Keep findings and revisions proportional to the stated goal.
