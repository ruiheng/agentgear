---
skill-selector: committed-docs-review
selector-summary: Review committed design documents at an exact recorded commit.
---

# Committed-Docs Review

Require base branch, design branch, exact reviewed commit, explicit docs in scope, complete user context, and Max Review Rounds. Inspect the named documents at the stated commit; never silently review a moving worktree snapshot.

For round 1, independently inspect repository evidence needed to judge the committed specifications.

For later rounds, require the previous reviewed commit and begin with a machine
Git diff limited to the named docs. Reuse accepted conclusions only when the
retained contract and User Decisions are unchanged and repository evidence,
dependencies, and document invariants remain compatible. When new decisions
arrive, derive the review frame again; unchanged repository facts may be reused,
but conclusions may not. Reinspect affected source, then scan the complete
documents for consistency.

If the previous baseline is unavailable, state that under Residual Risk; use NEEDS_INPUT when the request should have supplied it and reliable incremental review cannot proceed.

Do not trust a requester- or author-written change summary as the diff. Do not edit the branch or documents.
