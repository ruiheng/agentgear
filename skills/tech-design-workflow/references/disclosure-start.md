---
skill-selector: start
selector-summary: Complete tech-design-workflow instructions, part 1.
---

# Technical Design Workflow

Use `agentgear skill get multi-agent-protocol multi-agent-protocol/shared-protocol` for the shared transport and session protocol. Read only the reference required by the current action; load another reference only when the action explicitly crosses into it.

## Route First

- New draft-review lane: retrieve `agentgear skill get tech-design-workflow/draft-review`.
- New review-existing lane: retrieve `agentgear skill get tech-design-workflow/review-existing`.
- `design_spec_draft_requested`: retrieve `agentgear skill get tech-design-workflow/author-round`.
- `design_task_context_revision`: retrieve `agentgear skill get tech-design-workflow/task-context-revision`.
- `design_spec_review_report` or `design_prune_report`: retrieve `agentgear skill get tech-design-workflow/report-handling`.
- `design_spec_review_context_rejected`: retrieve `agentgear skill get tech-design-workflow/context-correction`.
- `design_spec_delivered`: retrieve `agentgear skill get tech-design-workflow/requester-delivery`.
- After the accepted design is authoritative: retrieve `agentgear skill get tech-design-workflow/closeout`.

For a new request, choose draft-review when no defensible committed specification exists or material technical choices remain unresolved. Choose review-existing for committed specifications with a known branch, base, and complete user context.

## Core Contract

- The user owns task authority. Resolve technical questions from evidence. The blocked role asks the user directly. In draft-review, the author records exact answers; in review-existing, the requester records them.
- The requester starts the lane and delivers the result. The author drafts and revises; the reviewer independently assesses each dispatched snapshot.
- Draft-review may add one `design_pruner` that only removes unnecessary design. `always` starts it immediately and ignores the initial size threshold; `auto` starts it at that threshold; `never` uses none.
- The pruner is contract-first and adversarial: derive the minimum required structure independently before evaluating the artifact; author decomposition and rationale are proposals, not authority.
- On every author revision, re-derive the minimum architecture before applying feedback. Conflicting findings or non-converging revisions require a user decision before another snapshot.
- Reviewer and pruner acceptance are review signals, not task goals; the author optimizes for the user-authoritative Contract.
- With `auto` or `always`, recheck after `MINIMAL` only for author-declared major structural change or substantial cumulative growth. Delivery requires correctness and pruning acceptance for the artifact being delivered; minor fixes go only to the reviewer until one becomes the delivered artifact.
- In draft-review, author, reviewer, and an enabled pruner are distinct sibling sessions. Lazy activation creates the pruner as another sibling before review dispatch.
- The lane manifest holds compact lane metadata and the current review checkpoint. Participant routes stay stable.
- The requester creates the Canonical Contract. After draft dispatch, the author maintains it. Reviewer and pruner remain read-only.
- Preserve the original request or authoritative handoff verbatim in the Canonical Design Task Contract. Keep requester normalization separate.
- Store that contract once under `.agent-artifacts/message/` and reference it from `.agent-artifacts/design-spec-dispatch/<task_id>.lock/lane.json`. Keep the manifest and contract through closeout.
- Store complete draft rounds under `.agent-artifacts/design-spec/<author_session_id>/rNNN.md`. A dispatched round is review evidence, so revisions use the next numbered snapshot.
- Keep drafting read-only with respect to Git state and workspace ownership.
- Review checkpoints are risk signals. If the design is not deliverable at round 5 or a later checkpoint, assume a structural problem unless contrary evidence is recorded; the author must analyze and report the risk and affected outcome to the user before continuing. NEEDS_INPUT and same-snapshot review do not increment the round.
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

In draft-review, the author appends exact product or scope answers as User
Decision Deltas and increments Context Revision. In review-existing, the
requester does so. Treat the contract and exact answers as authority; the design
remains a proposal. Checkpoint continuation does not revise the contract.

## Shared Invariants

- Use the shared Session Host Contract for session creation and recovery; retrieve `tech-design-workflow/draft-review` before creating draft-lane sessions.
- Keep transport metadata, launch commands, and provider-specific values out of task contracts and design artifacts.
- Ask the user when scope or strategy needs their authority.
- Keep findings and revisions proportional to the stated goal.
